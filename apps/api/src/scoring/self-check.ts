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
 * - `none`: recorded as skipped (trajectory_match, llm_judge).
 *
 * Verifiers can write to the workspace they are given, so callers that keep
 * using a folder afterwards pass a copy.
 */
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { JsonValue, ScorerType, SelfCheck } from '@hermes-evals/shared';
import type { ScratchDir } from '../storage/blob-store.js';
import { scoreReferenceAsAnswer } from './answer.js';
import { checkFile } from './file-check.js';
import { parseVerificationEntry, selfCheckModeFor, type SelfCheckMode } from './registry.js';
import type { ScorerResult } from './result.js';
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
  /** From task.yaml; the loader defaults it to true when an expected workspace is set. */
  negativeControl: boolean;
  /** The task's verify/ folder (it need not exist when no key uses a verifier). */
  verifyDir: string;
  /** A fresh scratch directory per verifier run, e.g. `(p) => storage.scratchDir(p)`. */
  scratch: (prefix: string) => Promise<ScratchDir>;
  python?: string;
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
    comment =
      result.status === 'passed'
        ? `the negative control passed on the untouched fixtures, so this check would pass any agent: ${comment}`
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

/** Runs every self-check of one task, in entry order. Never throws for a task's content. */
export async function runSelfChecks(input: SelfCheckInput): Promise<SelfCheckResult[]> {
  const results: SelfCheckResult[] = [];
  for (const entry of input.entries) {
    const mode = selfCheckModeFor(entry.type, input.expectedWorkspaceDir !== null);
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

    /** One run of this entry's check against a workspace, for the script and workspace modes. */
    let check: (workspaceDir: string) => Promise<ScorerResult>;
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
        check = (workspaceDir) => checkFile(params, workspaceDir);
        break;
      }
      case 'verifier_script': {
        const { params } = parsedEntry;
        check = async (workspaceDir) => {
          const scratch = await input.scratch('verifier');
          try {
            return await scoreVerifierScript(params, {
              verifyDir: input.verifyDir,
              answer: input.reference,
              workspaceDir,
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
      const [result, ms] = await timed(() => check(input.fixturesDir));
      results.push(toResult(entry, mode, result, ms));
      continue;
    }
    // mode === 'workspace'
    const expectedDir = input.expectedWorkspaceDir;
    if (expectedDir === null) {
      results.push({
        ...bare,
        status: 'error',
        comment: `${entry.type} needs self_check.expected_workspace in task.yaml: there is no known-good workspace to check it against`,
      });
      continue;
    }
    const [positive, ms] = await timed(() => check(expectedDir));
    results.push(toResult(entry, mode, positive, ms, 'pass'));
    if (input.negativeControl) {
      const [negative, negativeMs] = await timed(() => check(input.fixturesDir));
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
