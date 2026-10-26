/**
 * What a draft task is after a change (plan 4.6): its readiness, its content
 * hash (the loader's task hash of the folder it stands for) and its state
 * against the base version, which follows from the hash: a task whose files
 * hash to its base task's is `unchanged` whatever was edited and undone on
 * the way, so the change list never reports a change that is not there.
 */
import type { DraftRefusedUpload, DraftTaskState, TaskReadiness } from '@hermes-evals/shared';
import type { DraftSelfCheckRecord } from '../../database/schema/index.js';
import type { TaskRow } from '../views/rows.js';
import type { DraftTaskFolder } from './materialise.js';
import { evaluateReadiness } from './readiness.js';

export interface EvaluateInput {
  folder: DraftTaskFolder;
  /** The suite folder, for messages. */
  suiteFolder: string;
  otherKeys: readonly string[];
  /** The base version's task this one continues (another key after a rename), or null. */
  baseTask: TaskRow | null;
  /** The older version the task was restored from, while it may still hold its files. */
  restoredFrom: TaskRow | null;
  /** Marked removed: the save leaves its folder out. */
  removed: boolean;
  /** The last worker self-check stored on the draft task. */
  selfCheck: DraftSelfCheckRecord | null;
  /** Uploads refused for their size, kept on the draft task (Phase 5b question 11). */
  refusedUploads?: readonly DraftRefusedUpload[];
  readBlob: (sha256: string) => Promise<Buffer>;
  now: () => Date;
}

export interface Evaluated {
  state: DraftTaskState;
  contentHash: string;
  readiness: TaskReadiness;
  /** Null once the task no longer holds the restored version's files. */
  restoredFromTaskId: string | null;
}

/** A stored task version's self-check, as the record of the content it ran on. */
export function recordOf(task: TaskRow | null): DraftSelfCheckRecord | null {
  if (task === null || task.selfCheck.ran_at === null) return null;
  return { ...task.selfCheck, content_hash: task.contentHash };
}

export async function evaluateTask(input: EvaluateInput): Promise<Evaluated> {
  const { baseTask, restoredFrom, folder } = input;
  // The run that applies is the one on this content: the draft's own, the base's, or the restored version's.
  const candidates = [input.selfCheck, recordOf(baseTask), recordOf(restoredFrom)].filter(
    (r): r is DraftSelfCheckRecord => r !== null,
  );
  const context = {
    folder: input.suiteFolder,
    otherKeys: input.otherKeys,
    renamedFrom: baseTask !== null && baseTask.key !== folder.key ? baseTask.key : null,
    refusedUploads: input.refusedUploads ?? [],
    readBlob: input.readBlob,
    now: input.now,
  };
  let outcome = await evaluateReadiness(folder, {
    ...context,
    lastSelfCheck: candidates[0] ?? null,
  });
  const matching = candidates.find((r) => r.content_hash === outcome.analysis.contentHash);
  if (matching !== undefined && matching !== candidates[0]) {
    outcome = await evaluateReadiness(folder, { ...context, lastSelfCheck: matching });
  }
  const hash = outcome.analysis.contentHash;
  const sameAsBase =
    baseTask !== null && baseTask.key === folder.key && baseTask.contentHash === hash;
  const stillRestored = restoredFrom !== null && restoredFrom.contentHash === hash && !sameAsBase;
  let state: DraftTaskState;
  if (input.removed && baseTask !== null) state = 'removed';
  else if (stillRestored) state = 'restored';
  else if (baseTask === null || baseTask.key !== folder.key) state = 'added';
  else state = sameAsBase ? 'unchanged' : 'changed';
  return {
    state,
    contentHash: hash,
    readiness: outcome.readiness,
    restoredFromTaskId: state === 'restored' ? restoredFrom!.id : null,
  };
}
