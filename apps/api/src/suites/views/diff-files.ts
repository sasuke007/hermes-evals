/**
 * The file list of a task diff and the line diffs under it (Phase 5 section
 * 6.1, settled for Phase 5b): task.yaml, prompt.md and reference.json first,
 * with the sizes and hashes the loader recorded (task_root_files), then every
 * task file by path; and a line diff of each changed small text file.
 *
 * A version loaded before Phase 5b has no root-file record: its task.yaml and
 * prompt.md are measured from the text the task row keeps, and its
 * reference.json, whose bytes the stored JSON value does not keep, is left out
 * of the list (the reference's JSON diff shows either way).
 */
import { createHash } from 'node:crypto';
import { AUTHORING_LIMITS, type TaskFileChange, type TaskTextFileDiff } from '@hermes-evals/shared';
import { TASK_ROOT_FILES, type TaskRootFile } from '../../database/schema/index.js';
import { fileChanges, type FileState } from './changes.js';
import { textDiff } from './diffs.js';
import type { TaskRootFileRow, TaskRow } from './rows.js';

/** A recorded root file, as far as the diff needs it. */
export type RootFileRecord = Pick<TaskRootFileRow, 'path' | 'sha256' | 'size'>;

const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * What is known of one version's root files: the loader's record, else the
 * size and hash of the text the task row keeps (task.yaml, prompt.md), else
 * nothing (reference.json, or a text the row does not keep).
 */
export function rootFileStates(
  task: Pick<TaskRow, 'taskYaml' | 'prompt'>,
  recorded: readonly RootFileRecord[],
): Map<TaskRootFile, FileState | null> {
  const byPath = new Map(recorded.map((r) => [r.path, r]));
  const kept: Record<TaskRootFile, string | null> = {
    'task.yaml': task.taskYaml,
    'prompt.md': task.prompt,
    'reference.json': null,
  };
  return new Map(
    TASK_ROOT_FILES.map((path): [TaskRootFile, FileState | null] => {
      const row = byPath.get(path);
      if (row) return [path, { path, sha256: row.sha256, size: row.size }];
      const text = kept[path];
      return [
        path,
        text === null ? null : { path, sha256: sha256Of(text), size: Buffer.byteLength(text) },
      ];
    }),
  );
}

/** The root files known on both sides, in the order task.yaml, prompt.md, reference.json. */
export function rootFileChanges(
  from: ReadonlyMap<TaskRootFile, FileState | null>,
  to: ReadonlyMap<TaskRootFile, FileState | null>,
): TaskFileChange[] {
  return TASK_ROOT_FILES.flatMap((path) => {
    const before = from.get(path);
    const after = to.get(path);
    return before && after ? fileChanges([before], [after]) : [];
  });
}

/** True when a changed file is small enough on both sides to be read for a line diff. */
export function isTextDiffCandidate(change: TaskFileChange): boolean {
  const limit = AUTHORING_LIMITS.textFixtureDiffMaxBytes;
  return (
    change.change === 'changed' &&
    change.before !== null &&
    change.after !== null &&
    change.before.sizeBytes <= limit &&
    change.after.sizeBytes <= limit
  );
}

/**
 * The line diffs of the changed small text files, in the order of `changes`.
 * `texts` holds each candidate's text by sha256, null when it is not UTF-8 or
 * gone from the blob store; a file missing either side's text is left out.
 */
export function textFileDiffs(
  changes: readonly TaskFileChange[],
  texts: ReadonlyMap<string, string | null>,
): TaskTextFileDiff[] {
  return changes.filter(isTextDiffCandidate).flatMap((change) => {
    const before = texts.get(change.before!.sha256) ?? null;
    const after = texts.get(change.after!.sha256) ?? null;
    return before === null || after === null
      ? []
      : [{ path: change.path, lines: textDiff(before, after) }];
  });
}
