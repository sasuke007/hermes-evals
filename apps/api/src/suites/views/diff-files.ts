/**
 * The file list of a task diff and the line diffs under it (Phase 5 section
 * 6.1, settled for Phase 5b): task.yaml, prompt.md and reference.json first,
 * with the sizes and hashes the loader recorded (task_root_files), then every
 * task file by path; and a line diff of each changed small text file.
 *
 * A version loaded before Phase 5b has no root-file record: its task.yaml and
 * prompt.md are measured from the text the task row keeps, and its
 * reference.json, whose bytes the stored JSON value does not keep, is listed
 * as not recorded (Phase 5b question 9, Phase 7), changed or not by its
 * stored value (the reference's JSON diff shows either way).
 */
import { createHash } from 'node:crypto';
import {
  AUTHORING_LIMITS,
  isRecordedFileVersion,
  type FileNotRecordedReason,
  type TaskFileChange,
  type TaskFileVersion,
  type TaskTextFileDiff,
} from '@hermes-evals/shared';
import { TASK_ROOT_FILES, type TaskRootFile } from '../../database/schema/index.js';
import type { FileState } from './changes.js';
import { textDiff } from './diffs.js';
import type { TaskRootFileRow, TaskRow } from './rows.js';

/** A recorded root file, as far as the diff needs it. */
export type RootFileRecord = Pick<TaskRootFileRow, 'path' | 'sha256' | 'size'>;

/** A root file the version has, whose size and hash the loader did not record. */
export interface NotRecordedFile {
  path: string;
  notRecorded: FileNotRecordedReason;
}

/** One version's side of a root file: measured, not recorded, or unknown (null). */
export type RootFileState = FileState | NotRecordedFile | null;

const sha256Of = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const isMeasured = (state: RootFileState): state is FileState =>
  state !== null && 'sha256' in state;

/**
 * What is known of one version's root files: the loader's record, else the
 * size and hash of the text the task row keeps (task.yaml, prompt.md), else
 * for reference.json "not recorded" when the row keeps a reference value,
 * else nothing (a text the row does not keep).
 */
export function rootFileStates(
  task: Pick<TaskRow, 'taskYaml' | 'prompt' | 'reference'>,
  recorded: readonly RootFileRecord[],
): Map<TaskRootFile, RootFileState> {
  const byPath = new Map(recorded.map((r) => [r.path, r]));
  const kept: Record<'task.yaml' | 'prompt.md', string | null> = {
    'task.yaml': task.taskYaml,
    'prompt.md': task.prompt,
  };
  return new Map(
    TASK_ROOT_FILES.map((path): [TaskRootFile, RootFileState] => {
      const row = byPath.get(path);
      if (row) return [path, { path, sha256: row.sha256, size: row.size }];
      if (path === 'reference.json') {
        const known = task.reference !== null && task.reference !== undefined;
        return [path, known ? { path, notRecorded: 'loaded_before_phase_5b' } : null];
      }
      const text = kept[path];
      return [
        path,
        text === null ? null : { path, sha256: sha256Of(text), size: Buffer.byteLength(text) },
      ];
    }),
  );
}

const versionOf = (state: FileState | NotRecordedFile): TaskFileVersion =>
  isMeasured(state)
    ? { sizeBytes: state.size, sha256: state.sha256 }
    : { sizeBytes: null, sha256: null, notRecorded: state.notRecorded };

/**
 * The root files known on both sides, in the order task.yaml, prompt.md,
 * reference.json. Two measured sides compare by hash; a side not recorded
 * takes `sameReference`, whether the two versions' stored reference values
 * are the same JSON.
 */
export function rootFileChanges(
  from: ReadonlyMap<TaskRootFile, RootFileState>,
  to: ReadonlyMap<TaskRootFile, RootFileState>,
  sameReference: boolean,
): TaskFileChange[] {
  return TASK_ROOT_FILES.flatMap((path): TaskFileChange[] => {
    const before = from.get(path) ?? null;
    const after = to.get(path) ?? null;
    if (before === null || after === null) return [];
    const same =
      isMeasured(before) && isMeasured(after) ? before.sha256 === after.sha256 : sameReference;
    return [
      {
        path,
        change: same ? 'unchanged' : 'changed',
        before: versionOf(before),
        after: versionOf(after),
      },
    ];
  });
}

/** True when a changed file is small enough on both sides to be read for a line diff. */
export function isTextDiffCandidate(change: TaskFileChange): change is TaskFileChange & {
  before: { sizeBytes: number; sha256: string };
  after: { sizeBytes: number; sha256: string };
} {
  const limit = AUTHORING_LIMITS.textFixtureDiffMaxBytes;
  return (
    change.change === 'changed' &&
    isRecordedFileVersion(change.before) &&
    isRecordedFileVersion(change.after) &&
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
    const before = texts.get(change.before.sha256) ?? null;
    const after = texts.get(change.after.sha256) ?? null;
    return before === null || after === null
      ? []
      : [{ path: change.path, lines: textDiff(before, after) }];
  });
}
