/**
 * Load-time self-checks (plan 4.3): before any agent runs, each check of a
 * task must pass on the task's own known-good answer, or a run graded by it
 * would mean nothing. The suite loader calls this once per task, in the
 * worker, with the task's folders materialised on disk.
 *
 * Per mode (registry.selfCheckModeFor):
 * - `answer`: reference.json scored as if it were the answer (text_match: the
 *   reference's text must hold the phrases and the pattern).
 * - `script`: the verifier with reference.json against the fixtures.
 * - `workspace`: file_check or the verifier against the expected workspace
 *   (fixtures overlaid with `expected/`), which must pass; then, as a negative
 *   control, against the untouched fixtures, which must not pass.
 * - `home` (Phase 6 P2): a file_check with `root: home`, or a verifier in a
 *   task whose only known-good folder is the expected home, against the
 *   expected home (the home seeds overlaid with `self_check.expected_home`),
 *   which must pass; then, as a negative control, against the seeds alone.
 * - `none`: recorded as skipped (trajectory_match, llm_judge).
 *
 * A verifier always gets both folders (`--workspace` and `--home`): the
 * known-good ones in a positive run, wherever the task declares them, and
 * the untouched fixtures and seeds in a negative control or an answer-based
 * run.
 *
 * Verifiers can write to the workspace they are given, so callers that keep
 * using a folder afterwards pass a copy.
 *
 * selfCheckSeconds is the longest one task's self-checks can take, from what
 * they declare (Phase 3 question 14), as scoring-time.ts is for a scoring
 * pass: the loader bounds a suite's sum so the load-suites job outlasts it.
 */
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { JsonValue, ScorerType, SelfCheck } from '@hermes-evals/shared';
import type { ScratchDir } from '../storage/blob-store.js';
import { scoreReferenceAsAnswer } from './answer.js';
import { checkFile } from './file-check.js';
import {
  parseVerificationEntry,
  selfCheckModeFor,
  type SelfCheckFolders,
  type SelfCheckMode,
} from './registry.js';
import type { ScorerResult } from './result.js';
import { KEY_SETUP_SECONDS } from './scoring-time.js';
import { scoreVerifierScript } from './verifier.js';

export type SelfCheckResult = SelfCheck['results'][number];

export interface SelfCheckEntry {
  key: string;
  type: ScorerType;
  /**
   * Params as written. For the primary key, the loader has already applied
   * `answer.path` when the params name no path (plan 4.2).
   */
  params: Record<string, unknown>;
}

export interface SelfCheckInput {
  entries: SelfCheckEntry[];
  reference: JsonValue;
  /** The task's untouched fixtures/ folder. */
  fixturesDir: string;
  /** fixtures/ overlaid with the expected folder, or null when the task declares none. */
  expectedWorkspaceDir: string | null;
  /**
   * The task's home seeds alone, at their home-relative paths
   * (`memories/MEMORY.md`): what a trial's home starts with. An empty folder
   * when the task has none.
   */
  homeDir: string;
  /** The seeds overlaid with `self_check.expected_home`, or null when the task declares none. */
  expectedHomeDir: string | null;
  /**
   * From task.yaml; the loader defaults it to true when an expected
   * workspace or an expected home is set.
   */
  negativeControl: boolean;
  /** The task's verify/ folder (it need not exist when no key uses a verifier). */
  verifyDir: string;
  /** A fresh scratch directory per verifier run, e.g. `(p) => storage.scratchDir(p)`. */
  scratch: (prefix: string) => Promise<ScratchDir>;
  python?: string;
}

/** What selfCheckSeconds reads of a task's plan. */
export interface TimedSelfCheck extends SelfCheckFolders {
  entries: readonly SelfCheckEntry[];
  negativeControl: boolean;
}

/**
 * The worst case of one task's self-checks, in seconds: they run one after
 * another, and only those that touch files take time worth counting.
 * - verifier_script: its `timeout_s` per run, after which it is killed, plus
 *   KEY_SETUP_SECONDS for writing the folders and starting it; two runs in
 *   workspace and home mode with a negative control;
 * - file_check: KEY_SETUP_SECONDS per run, the same runs;
 * - answer checks compare values in memory, and trajectory_match and
 *   llm_judge do not run at load: none counts.
 * An entry whose params do not parse runs nothing (it is an `error` result).
 */
export function selfCheckSeconds(task: TimedSelfCheck): number {
  let total = 0;
  for (const entry of task.entries) {
    const mode = selfCheckModeFor(entry, task);
    if (mode === 'answer' || mode === 'none') continue;
    const parsed = parseVerificationEntry(entry);
    if (!parsed.success) continue;
    const runs = mode !== 'script' && task.negativeControl ? 2 : 1;
    const perRun =
      parsed.data.type === 'verifier_script'
        ? parsed.data.params.timeout_s + KEY_SETUP_SECONDS
        : KEY_SETUP_SECONDS;
    total += runs * perRun;
  }
  return total;
}

const NONE_COMMENT = {
  trajectory_match: 'schema checked only: needs a run trajectory',
  llm_judge: 'schema checked only: the judge is never called at load',
} as const;

function toResult(
  entry: SelfCheckEntry,
  mode: SelfCheckMode,
  result: ScorerResult,
  durationMs: number,
  expect?: 'pass' | 'fail',
): SelfCheckResult {
  const script = result.evidence?.script;
  let comment = result.comment;
  if (expect === 'fail') {
    const on = mode === 'home' ? 'the home seeds alone' : 'the untouched fixtures';
    comment =
      result.status === 'passed'
        ? `the negative control passed on ${on}, so this check would pass any agent: ${comment}`
        : `negative control: ${comment}`;
  }
  return {
    key: entry.key,
    type: entry.type,
    mode,
    ...(expect ? { expect } : {}),
    status: result.status,
    score: result.score,
    comment,
    duration_ms: Math.round(durationMs),
    ...(script
      ? {
          argv: script.argv,
          exit_code: script.exit_code,
          timed_out: script.timed_out,
          stdout_tail: script.stdout_tail,
          stderr_tail: script.stderr_tail,
        }
      : {}),
  };
}

async function timed(run: () => Promise<ScorerResult>): Promise<[ScorerResult, number]> {
  const started = performance.now();
  const result = await run();
  return [result, performance.now() - started];
}

/** The two folders one run of a file-touching check reads. */
interface CheckDirs {
  workspace: string;
  home: string;
}

/** Why a file-touching mode has no known-good folder to run on, or null. */
function missingFolder(
  mode: SelfCheckMode,
  input: SelfCheckInput,
  type: ScorerType,
): string | null {
  if (mode === 'workspace' && input.expectedWorkspaceDir === null) {
    return `${type} needs self_check.expected_workspace in task.yaml: there is no known-good workspace to check it against`;
  }
  if (mode === 'home' && input.expectedHomeDir === null) {
    return `${type} with root: home needs self_check.expected_home in task.yaml: there is no known-good home to check it against`;
  }
  return null;
}

/** Runs every self-check of one task, in entry order. Never throws for a task's content. */
export async function runSelfChecks(input: SelfCheckInput): Promise<SelfCheckResult[]> {
  const folders: SelfCheckFolders = {
    expectedWorkspace: input.expectedWorkspaceDir !== null,
    expectedHome: input.expectedHomeDir !== null,
  };
  /** What a trial starts with: the negative control's folders, and an answer-based verifier's. */
  const untouched: CheckDirs = { workspace: input.fixturesDir, home: input.homeDir };
  const results: SelfCheckResult[] = [];
  for (const entry of input.entries) {
    const mode = selfCheckModeFor(entry, folders);
    const bare = { key: entry.key, type: entry.type, mode, score: null };
    const parsed = parseVerificationEntry(entry);
    if (!parsed.success) {
      results.push({
        ...bare,
        status: 'error',
        comment: `invalid params: ${z.prettifyError(parsed.error)}`,
      });
      continue;
    }
    const parsedEntry = parsed.data;

    /** One run of this entry's check against a workspace and a home, for the file-touching modes. */
    let check: (dirs: CheckDirs) => Promise<ScorerResult>;
    switch (parsedEntry.type) {
      case 'trajectory_match':
      case 'llm_judge':
        results.push({ ...bare, status: 'skipped', comment: NONE_COMMENT[parsedEntry.type] });
        continue;
      case 'numeric_tolerance':
      case 'json_match':
      case 'exact_match':
      case 'text_match': {
        const key = parsedEntry;
        const [result, ms] = await timed(async () => scoreReferenceAsAnswer(key, input.reference));
        results.push(toResult(entry, mode, result, ms));
        continue;
      }
      case 'file_check': {
        const { params } = parsedEntry;
        check = (dirs) => checkFile(params, params.root === 'home' ? dirs.home : dirs.workspace);
        break;
      }
      case 'verifier_script': {
        const { params } = parsedEntry;
        check = async (dirs) => {
          const scratch = await input.scratch('verifier');
          try {
            return await scoreVerifierScript(params, {
              verifyDir: input.verifyDir,
              answer: input.reference,
              workspaceDir: dirs.workspace,
              homeDir: dirs.home,
              scratchDir: scratch.path,
              python: input.python,
            });
          } finally {
            await scratch.dispose();
          }
        };
        break;
      }
    }

    if (mode === 'script') {
      const [result, ms] = await timed(() => check(untouched));
      results.push(toResult(entry, mode, result, ms));
      continue;
    }
    // mode === 'workspace' or 'home': the known-good folders the task declares, then the untouched ones.
    const missing = missingFolder(mode, input, entry.type);
    if (missing !== null) {
      results.push({ ...bare, status: 'error', comment: missing });
      continue;
    }
    const knownGood: CheckDirs = {
      workspace: input.expectedWorkspaceDir ?? input.fixturesDir,
      home: input.expectedHomeDir ?? input.homeDir,
    };
    const [positive, ms] = await timed(() => check(knownGood));
    results.push(toResult(entry, mode, positive, ms, 'pass'));
    if (input.negativeControl) {
      const [negative, negativeMs] = await timed(() => check(untouched));
      results.push(toResult(entry, mode, negative, negativeMs, 'fail'));
    }
  }
  return results;
}

/**
 * The task's overall self-check status: `error` if any check broke, else
 * `failed` if any check did not pass or a negative control passed, else
 * `passed`. Skipped checks do not count.
 */
export function selfCheckStatus(
  results: readonly SelfCheckResult[],
): 'passed' | 'failed' | 'error' {
  let failed = false;
  let errored = false;
  for (const r of results) {
    if (r.status === 'skipped') continue;
    if (r.expect === 'fail') {
      // A negative control must not pass; failing or breaking on the bare fixtures is expected.
      if (r.status === 'passed') failed = true;
      continue;
    }
    if (r.status === 'error') errored = true;
    else if (r.status !== 'passed') failed = true;
  }
  return errored ? 'error' : failed ? 'failed' : 'passed';
}
