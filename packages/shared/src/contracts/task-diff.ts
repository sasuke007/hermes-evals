/**
 * A task's changes between two versions (Suites section, plan 4.5; TaskDiff,
 * SA.11): the line diffs of prompt.md and task.yaml, the reference's JSON
 * paths, and every file with its size and hash on each side. Task detail's
 * diff between suite versions is TaskDiff; a draft task against its base is
 * DraftTaskDiff (./draft-tasks.ts). See ./common.ts for the conventions
 * every contract file follows.
 */
import { z } from 'zod';
import { JsonValueSchema } from '../records.js';
import { countView, sha256View } from './common.js';

export const TextDiffLineSchema = z.object({
  kind: z.enum(['same', 'added', 'removed']),
  text: z.string(),
  oldLine: z.number().int().positive().nullable(),
  newLine: z.number().int().positive().nullable(),
});
export type TextDiffLine = z.infer<typeof TextDiffLineSchema>;

export const JsonDiffEntrySchema = z.object({
  /** JSON path, e.g. `total_due` or `duplicates[1][0]`. */
  path: z.string(),
  kind: z.enum(['added', 'removed', 'changed']),
  before: JsonValueSchema.nullable(),
  after: JsonValueSchema.nullable(),
});
export type JsonDiffEntry = z.infer<typeof JsonDiffEntrySchema>;

/**
 * Why a side of a task diff's file has no size and hash (Phase 5b question
 * 9, Phase 7): `loaded_before_phase_5b` for reference.json of a task version
 * loaded before Phase 5b, which has no task_root_files record until its
 * next reload. Pages say "not recorded".
 */
export const FILE_NOT_RECORDED_REASONS = ['loaded_before_phase_5b'] as const;
export type FileNotRecordedReason = (typeof FILE_NOT_RECORDED_REASONS)[number];

/**
 * One side of a file in a task diff: its size and hash, or, when the loader
 * never recorded them, null for both with the reason.
 */
export const TaskFileVersionSchema = z.union([
  z.object({ sizeBytes: countView, sha256: sha256View }),
  z.object({
    sizeBytes: z.null(),
    sha256: z.null(),
    notRecorded: z.enum(FILE_NOT_RECORDED_REASONS),
  }),
]);
export type TaskFileVersion = z.infer<typeof TaskFileVersionSchema>;

/** A side of a task diff's file whose size and hash the loader recorded. */
export type RecordedTaskFileVersion = Extract<TaskFileVersion, { sha256: string }>;

/** True for a side with its size and hash; false for none (null) or one not recorded. */
export const isRecordedFileVersion = (
  side: TaskFileVersion | null,
): side is RecordedTaskFileVersion => side !== null && side.sha256 !== null;

/**
 * One file of a task diff. The list holds task.yaml, prompt.md and
 * reference.json first (Phase 5 section 6.1), then every task file by path;
 * `before` is null for an added file and `after` for a removed one.
 * The root files' sizes and hashes are those the loader recorded
 * (task_root_files, from Phase 5b). A version loaded before has none: its
 * task.yaml and prompt.md are measured from their stored text, and its
 * reference.json side reads `notRecorded` (Phase 7), with `change` from
 * the stored values (its JSON diff is shown either way).
 */
export const TaskFileChangeSchema = z.object({
  path: z.string(),
  change: z.enum(['added', 'removed', 'changed', 'unchanged']),
  before: TaskFileVersionSchema.nullable(),
  after: TaskFileVersionSchema.nullable(),
});
export type TaskFileChange = z.infer<typeof TaskFileChangeSchema>;

/**
 * The line diff of one changed text fixture of at most
 * AUTHORING_LIMITS.textFixtureDiffMaxBytes on both sides, valid UTF-8, such as
 * `fixtures/policy_terms.json`; larger or binary files show only their size
 * and hash in `files`.
 */
export const TaskTextFileDiffSchema = z.object({
  path: z.string(),
  lines: z.array(TextDiffLineSchema),
});
export type TaskTextFileDiff = z.infer<typeof TaskTextFileDiffSchema>;

const diffSide = z.object({
  suiteId: z.string(),
  suiteVersion: z.number().int().positive(),
  taskVersion: z.number().int().positive(),
});

/** A task's changes between two suite versions. */
export const TaskDiffSchema = z.object({
  key: z.string(),
  from: diffSide,
  to: diffSide,
  prompt: z.array(TextDiffLineSchema),
  taskYaml: z.array(TextDiffLineSchema),
  reference: z.array(JsonDiffEntrySchema),
  files: z.array(TaskFileChangeSchema),
  /** Line diffs of the changed small text fixtures, in `files` order. */
  textFiles: z.array(TaskTextFileDiffSchema),
});
export type TaskDiff = z.infer<typeof TaskDiffSchema>;
