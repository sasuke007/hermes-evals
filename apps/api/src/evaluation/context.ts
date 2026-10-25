/**
 * The scorer context (plan 9.2): everything a scorer may read about one
 * attempt, and nothing it may write. Scorers get the extracted answer and the
 * evidence rows; the costly parts are built on first use, so a task graded
 * on its answer alone never copies a file or reads an event:
 *
 * - `workspace()`: the end-state workspace rebuilt from artifact blobs, made
 *   once and shared by read-only checks (file_check);
 * - `verifierDirs()`: a fresh workspace, `verify/` folder and scratch folder
 *   for each verifier run, because a verifier may write to what it is given
 *   and the next check must still see the agent's files;
 * - `events()`: the attempt's event stream (trajectory_match, Phase 3).
 *
 * `close()` removes every directory the context made, whatever happened.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtractedAnswer } from '@hermes-evals/shared';
import type { AppDb } from '../database/types.js';
import type { BlobStore, ScratchDir } from '../storage/blob-store.js';
import {
  loadEvents,
  type ArtifactRecord,
  type EvaluationEvidence,
  type EventRecord,
} from './evidence.js';
import { materialiseVerifyDir, materialiseWorkspace } from './workspace.js';

/** Folders for one verifier run, all inside one scratch directory. */
export interface VerifierDirs {
  /** The attempt's end-state workspace; the verifier may change it. */
  workspaceDir: string;
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
  /** Fresh folders for one verifier run; removed by close() or by the returned dispose. */
  verifierDirs(): Promise<VerifierDirs & { dispose(): Promise<void> }>;
  /** Interpreter for verifier scripts; `python3` on PATH by default. */
  python?: string;
  /** The LLM judge client, built in Phase 3. */
  judge: null;
}

export interface ScorerContextDeps {
  db: AppDb;
  store: BlobStore;
  python?: string;
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

  return {
    task: evidence.task,
    attempt: evidence.attempt,
    answer,
    artifacts: evidence.artifacts,
    python: deps.python,
    judge: null,
    events: () => (events ??= loadEvents(deps.db, evidence.attemptId)),
    workspace: () =>
      (shared ??= (async () => {
        const dir = await scratch('eval-workspace');
        const workspaceDir = join(dir.path, 'workspace');
        await materialiseWorkspace(deps.store, evidence.artifacts, workspaceDir);
        return workspaceDir;
      })()),
    verifierDirs: async () => {
      const dir = await scratch('eval-verifier');
      const dirs = {
        workspaceDir: join(dir.path, 'workspace'),
        verifyDir: join(dir.path, 'verify'),
        scratchDir: join(dir.path, 'scratch'),
      };
      await materialiseWorkspace(deps.store, evidence.artifacts, dirs.workspaceDir);
      await materialiseVerifyDir(deps.store, evidence.verifierFiles, dirs.verifyDir);
      await mkdir(dirs.scratchDir);
      return { ...dirs, dispose: () => dir.dispose() };
    },
    close: async () => {
      await Promise.all(made.map((dir) => dir.dispose().catch(() => {})));
    },
  };
}
