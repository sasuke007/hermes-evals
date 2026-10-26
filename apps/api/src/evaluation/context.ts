/**
 * The scorer context (plan 9.2): everything a scorer may read about one
 * attempt, and nothing it may write. Scorers get the extracted answer and the
 * evidence rows; the costly parts are built on first use, so a task graded
 * on its answer alone never copies a file or reads an event:
 *
 * - `workspace()`: the end-state workspace rebuilt from artifact blobs, made
 *   once and shared by read-only checks (file_check);
 * - `home()`: the same for the home's memory files (Phase 6 P2), which a
 *   file_check with `root: home` reads;
 * - `verifierDirs()`: a fresh workspace, home, `verify/` folder and scratch
 *   folder for each verifier run, because a verifier may write to what it is
 *   given and the next check must still see the agent's files;
 * - `events()`: the attempt's event stream (trajectory_match);
 * - `rubric(path)`: an llm_judge rubric's text, read from its blob.
 *
 * The judge (llm_judge) comes with its settings: the JudgeClient that calls
 * the judge model through egress's admin socket (Phase 3 S2), or null where
 * there is none, and JUDGE_PROVIDER, JUDGE_MODEL and JUDGE_BASE_URL. The
 * experiment's frozen price table prices the judge's calls.
 *
 * `close()` removes every directory the context made, whatever happened.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtractedAnswer, PriceTable } from '@hermes-evals/shared';
import type { AppDb } from '../database/types.js';
import type { JudgeClient, JudgeSettings } from '../scoring/judge/contracts.js';
import type { BlobStore, ScratchDir } from '../storage/blob-store.js';
import {
  loadEvents,
  type ArtifactRecord,
  type EvaluationEvidence,
  type EventRecord,
} from './evidence.js';
import {
  materialiseHome,
  materialiseVerifyDir,
  materialiseWorkspace,
  normaliseRelativePath,
} from './workspace.js';

/** Folders for one verifier run, all inside one scratch directory. */
export interface VerifierDirs {
  /** The attempt's end-state workspace; the verifier may change it. */
  workspaceDir: string;
  /** The attempt's collected home files (`memories/…`), given as `--home`; empty when there are none. */
  homeDir: string;
  /** The task's `verify/` folder, outside the workspace. */
  verifyDir: string;
  /** Empty: the verifier's answer.json, HOME and TMPDIR. */
  scratchDir: string;
}

export interface ScorerContext {
  task: EvaluationEvidence['task'];
  attempt: EvaluationEvidence['attempt'];
  answer: ExtractedAnswer;
  artifacts: readonly ArtifactRecord[];
  /** The attempt's events in sequence order, read from the database on first call. */
  events(): Promise<readonly EventRecord[]>;
  /** The shared end-state workspace for read-only checks. Never hand it to a verifier. */
  workspace(): Promise<string>;
  /** The shared collected home files for read-only checks (Phase 6 P2). Never hand it to a verifier. */
  home(): Promise<string>;
  /** Fresh folders for one verifier run; removed by close() or by the returned dispose. */
  verifierDirs(): Promise<VerifierDirs & { dispose(): Promise<void> }>;
  /**
   * The text of the rubric at `path` (relative to the task folder, as
   * params.rubric names it), or null when the task stores no rubric there.
   */
  rubric(path: string): Promise<string | null>;
  /** Interpreter for verifier scripts; `python3` on PATH by default. */
  python?: string;
  /** The LLM judge client; null where no judge can be called, which makes llm_judge keys `error`. */
  judge: JudgeClient | null;
  /** The platform's judge default (JUDGE_PROVIDER, JUDGE_MODEL, JUDGE_BASE_URL); see resolveJudgeModel. */
  judgeSettings: JudgeSettings;
  /** The experiment's frozen price table, for the judge's cost. */
  priceTable: PriceTable;
}

export interface ScorerContextDeps {
  db: AppDb;
  store: BlobStore;
  python?: string;
  /** The judge client (the worker's egress judge path). Absent: no judge, llm_judge keys are `error`. */
  judge?: JudgeClient | null;
  /** judgeSettingsOf(env) in the worker. Absent: no platform default, so only a check's `model:` judges. */
  judgeSettings?: JudgeSettings;
}

/** A scorer context and the function that removes every directory it made. */
export interface OpenScorerContext extends ScorerContext {
  close(): Promise<void>;
}

export function openScorerContext(
  evidence: EvaluationEvidence,
  answer: ExtractedAnswer,
  deps: ScorerContextDeps,
): OpenScorerContext {
  const made: ScratchDir[] = [];
  const scratch = async (prefix: string): Promise<ScratchDir> => {
    const dir = await deps.store.scratchDir(prefix);
    made.push(dir);
    return dir;
  };

  let events: Promise<EventRecord[]> | null = null;
  let shared: Promise<string> | null = null;
  let sharedHome: Promise<string> | null = null;

  return {
    task: evidence.task,
    attempt: evidence.attempt,
    answer,
    artifacts: evidence.artifacts,
    python: deps.python,
    judge: deps.judge ?? null,
    judgeSettings: deps.judgeSettings ?? {},
    priceTable: evidence.priceTable,
    events: () => (events ??= loadEvents(deps.db, evidence.attemptId)),
    rubric: async (path) => {
      const wanted = normaliseRelativePath(path);
      const file = evidence.rubricFiles.find((f) => f.path === wanted);
      return file ? (await deps.store.read(file.sha256)).toString('utf8') : null;
    },
    workspace: () =>
      (shared ??= (async () => {
        const dir = await scratch('eval-workspace');
        const workspaceDir = join(dir.path, 'workspace');
        await materialiseWorkspace(deps.store, evidence.artifacts, workspaceDir);
        return workspaceDir;
      })()),
    home: () =>
      (sharedHome ??= (async () => {
        const dir = await scratch('eval-home');
        const homeDir = join(dir.path, 'home');
        await materialiseHome(deps.store, evidence.artifacts, homeDir);
        return homeDir;
      })()),
    verifierDirs: async () => {
      const dir = await scratch('eval-verifier');
      const dirs = {
        workspaceDir: join(dir.path, 'workspace'),
        homeDir: join(dir.path, 'home'),
        verifyDir: join(dir.path, 'verify'),
        scratchDir: join(dir.path, 'scratch'),
      };
      await materialiseWorkspace(deps.store, evidence.artifacts, dirs.workspaceDir);
      await materialiseHome(deps.store, evidence.artifacts, dirs.homeDir);
      await materialiseVerifyDir(deps.store, evidence.verifierFiles, dirs.verifyDir);
      await mkdir(dirs.scratchDir);
      return { ...dirs, dispose: () => dir.dispose() };
    },
    close: async () => {
      await Promise.all(made.map((dir) => dir.dispose().catch(() => {})));
    },
  };
}
