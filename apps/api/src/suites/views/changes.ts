/**
 * What changed between two versions: the task keys of a suite (its change
 * set), the files of one task (its history and diff file list).
 *
 * A task's own files are prompt.md, task.yaml and reference.json, which the
 * loader stores on the task row, plus its task_files (fixtures, verifiers,
 * rubrics, the expected workspace), which it stores by content hash.
 */
import type { JsonValue, SuiteChangeSet, TaskFileChange } from '@hermes-evals/shared';
import { sameJson } from './diffs.js';

/** One task of a suite version, as far as its change set needs it. */
export interface TaskState {
  key: string;
  contentHash: string;
  valid: boolean;
}

/**
 * The change set of `next` against `previous` (null for a directory's first
 * version). Keys are listed in suite order, removed ones in the old order.
 * A task added already invalid counts as now invalid, so a new version's
 * failures are never silent.
 */
export function suiteChanges(
  previous: readonly TaskState[] | null,
  next: readonly TaskState[],
): SuiteChangeSet {
  const before = new Map((previous ?? []).map((t) => [t.key, t]));
  const after = new Set(next.map((t) => t.key));
  const changes: SuiteChangeSet = {
    added: [],
    removed: [],
    changed: [],
    nowInvalid: [],
    nowValid: [],
  };
  for (const task of next) {
    const old = before.get(task.key);
    if (!old) changes.added.push(task.key);
    else if (old.contentHash !== task.contentHash) changes.changed.push(task.key);
    if (!task.valid && (!old || old.valid)) changes.nowInvalid.push(task.key);
    if (task.valid && old && !old.valid) changes.nowValid.push(task.key);
  }
  for (const task of previous ?? []) if (!after.has(task.key)) changes.removed.push(task.key);
  return changes;
}

/** A stored task file, as far as comparisons need it. */
export interface FileState {
  path: string;
  sha256: string;
  size: number;
}

/** The content of one task version. */
export interface TaskContent {
  prompt: string | null;
  taskYaml: string | null;
  reference: JsonValue | null;
  files: readonly FileState[];
}

/**
 * Files of `next` that differ from `previous`: prompt.md, reference.json and
 * task.yaml first, then task files (added, removed or changed) by path.
 */
export function changedFiles(previous: TaskContent, next: TaskContent): string[] {
  const out: string[] = [];
  if (previous.prompt !== next.prompt) out.push('prompt.md');
  if (!sameJson(previous.reference, next.reference)) out.push('reference.json');
  if (previous.taskYaml !== next.taskYaml) out.push('task.yaml');
  for (const change of fileChanges(previous.files, next.files)) {
    if (change.change !== 'unchanged') out.push(change.path);
  }
  return out;
}

/** Every task file of either version with what happened to it, by path. */
export function fileChanges(
  previous: readonly FileState[],
  next: readonly FileState[],
): TaskFileChange[] {
  const before = new Map(previous.map((f) => [f.path, f]));
  const after = new Map(next.map((f) => [f.path, f]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.map((path) => {
    const old = before.get(path);
    const now = after.get(path);
    const version = (f: FileState | undefined) =>
      f ? { sizeBytes: f.size, sha256: f.sha256 } : null;
    const change = !old
      ? 'added'
      : !now
        ? 'removed'
        : old.sha256 === now.sha256
          ? 'unchanged'
          : 'changed';
    return { path, change, before: version(old), after: version(now) };
  });
}
