/**
 * A draft whose folder moved on (plan 4.6 step 1, board SA.12), as the save
 * and the rebase find it: the folder's current version is no longer the
 * draft's base, because a reload created a newer one (`version_moved`) or
 * because the save found files on disk that no longer hashed to the base
 * and loaded them first (`disk_changed`). What each side changed and where
 * they overlap is the draft view's own computation (drafts/draft-views.ts
 * draftConflict), so the bar and the save's 409 always agree.
 */
import type { DraftConflict, DraftConflictCause } from '@hermes-evals/shared';
import type { AppDb } from '../../database/types.js';
import type { StoredDraft } from '../drafts/draft-store.js';
import { draftConflict } from '../drafts/draft-views.js';
import { draftBase, type DraftBase } from '../drafts/draft-writer.js';
import { filesOf, tasksOf } from '../suites.queries.js';
import type { SuiteRow } from '../views/rows.js';
import type { BaseFile } from './stage.js';

/** The conflict of `stored` against `current`; throws when the draft has no base or none moved. */
export async function conflictOf(
  db: AppDb,
  stored: StoredDraft,
  current: SuiteRow,
  cause: DraftConflictCause,
): Promise<DraftConflict> {
  const base = await draftBase(db, stored.draft);
  const conflict = draftConflict(
    { stored, base, current: { suite: current, tasks: await tasksOf(db, [current.id]) } },
    cause,
  );
  if (conflict === null)
    throw new Error(`draft ${stored.draft.id} has no conflict with v${current.versionNumber}`);
  return conflict;
}

/** The base task's key of each draft task that has one, by draft task id. */
export function baseKeysOf(base: DraftBase, stored: StoredDraft): Map<string, string> {
  const keys = new Map(base.tasks.map((t) => [t.id, t.key]));
  const out = new Map<string, string>();
  for (const task of stored.tasks) {
    const key = task.baseTaskId === null ? undefined : keys.get(task.baseTaskId);
    if (key !== undefined) out.set(task.id, key);
  }
  return out;
}

/** The files the base version stored for each draft task that has a base task, by draft task id. */
export async function baseFilesOf(
  db: AppDb,
  baseTasks: readonly { id: string }[],
  stored: StoredDraft,
): Promise<Map<string, BaseFile[]>> {
  const byTask = new Map<string, BaseFile[]>();
  const files = await filesOf(
    db,
    baseTasks.map((t) => t.id),
  );
  for (const file of files) {
    const list = byTask.get(file.taskId) ?? [];
    list.push({ path: file.path, kind: file.kind });
    byTask.set(file.taskId, list);
  }
  const out = new Map<string, BaseFile[]>();
  for (const task of stored.tasks) {
    if (task.baseTaskId !== null) out.set(task.id, byTask.get(task.baseTaskId) ?? []);
  }
  return out;
}
