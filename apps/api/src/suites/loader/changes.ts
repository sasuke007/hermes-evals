/**
 * What a reload changed, against the version that was current before it
 * (plan 4.4 step 4): task keys added, removed, changed (own content hash
 * differs), now invalid and now valid. A task that arrives already invalid
 * counts as now invalid, so a new version's failures are never silent.
 */
import type { SuiteChangeSet, SuiteChanges } from '@hermes-evals/shared';

export interface TaskState {
  key: string;
  contentHash: string;
  valid: boolean;
}

/** Keys in `next` order; removed keys in `previous` order. `previous` is null for a first version. */
export function suiteChanges(
  previous: readonly TaskState[] | null,
  next: readonly TaskState[],
): SuiteChanges {
  const before = new Map((previous ?? []).map((t) => [t.key, t]));
  const after = new Set(next.map((t) => t.key));
  const changes: SuiteChanges = {
    added: [],
    removed: [],
    changed: [],
    now_invalid: [],
    now_valid: [],
  };
  for (const task of next) {
    const old = before.get(task.key);
    if (!old) changes.added.push(task.key);
    else if (old.contentHash !== task.contentHash) changes.changed.push(task.key);
    if (!task.valid && (!old || old.valid)) changes.now_invalid.push(task.key);
    if (task.valid && old && !old.valid) changes.now_valid.push(task.key);
  }
  for (const task of previous ?? []) if (!after.has(task.key)) changes.removed.push(task.key);
  return changes;
}

export const noChanges = (): SuiteChanges => ({
  added: [],
  removed: [],
  changed: [],
  now_invalid: [],
  now_valid: [],
});

/** The stored (snake_case) change set as the reload result carries it. */
export const changeSetView = (c: SuiteChanges): SuiteChangeSet => ({
  added: [...c.added],
  removed: [...c.removed],
  changed: [...c.changed],
  nowInvalid: [...c.now_invalid],
  nowValid: [...c.now_valid],
});
