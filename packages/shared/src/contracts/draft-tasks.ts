/**
 * View models and request bodies of the tasks of a suite draft (plan 4.6 and
 * 11; boards SA.4 to SA.8): the task editor's Form, Files and task.yaml tabs,
 * with what each file is; the readiness rules, the worker self-check and
 * Try it are in ./draft-checks.ts, the draft itself in ./drafts.ts. See
 * ./common.ts for the conventions every contract file follows.
 *
 * Routes, under /api/suites/:suite/draft (`:suite` is the folder name):
 *   POST   /tasks                       CreateDraftTaskRequest → 201 DraftTaskCreateResult (drafts.ts)
 *   GET    /tasks/:key                  DraftTaskDetail
 *   PUT    /tasks/:key                  UpdateDraftTaskRequest → DraftTaskDetail
 *   DELETE /tasks/:key                  marks a base task removed, drops an added one → SuiteDraftView
 *   POST   /tasks/:key/revert           the base version's files again → DraftTaskDetail
 *   POST   /tasks/:key/files            multipart `file` + DraftFileUploadFields → DraftTaskDetail
 *   PATCH  /tasks/:key/files/:path      MoveDraftFileRequest → DraftTaskDetail
 *   DELETE /tasks/:key/files/:path      → DraftTaskDetail
 *   GET    /tasks/:key/files/:path      the file's bytes; `/preview` a TablePreview
 *   GET    /tasks/:key/readiness        TaskReadiness
 *   POST   /tasks/:key/self-check       DraftSelfCheckView; 503 without a live worker
 *   POST   /tasks/:key/try              TryCheckRequest → TryCheckResult
 *   GET    /tasks/:key/diff             DraftTaskDiff, against the base version
 *
 * Writes under `verify/` are refused with 400 (isVerifyPath, R7). Problems
 * in what the forms hold never refuse a write: they are readiness results,
 * and a task with problems is saved as invalid. Only what cannot be stored
 * is refused: a key that is not a folder name, a key another task holds, a
 * path outside the task folder.
 */
import { z } from 'zod';
import { AUTHORING_LIMITS, isVerifyPath } from '../authoring.js';
import { JsonValueSchema } from '../records.js';
import { DIRECTORY_KEY_MESSAGE, DIRECTORY_KEY_PATTERN } from '../suite-files.js';
import { DRAFT_FILE_KINDS, DRAFT_TASK_STATES, SCORER_TYPES } from '../vocab.js';
import { countView, isoTimeView, isUnique, sha256View } from './common.js';
import { DraftSelfCheckViewSchema, TaskReadinessSchema } from './draft-checks.js';
import {
  JsonDiffEntrySchema,
  TaskFileChangeSchema,
  TaskTextFileDiffSchema,
  TextDiffLineSchema,
} from './task-diff.js';

/** A task key: the task's folder name in the suite. */
export const DraftTaskKeySchema = z
  .string()
  .max(255)
  .regex(DIRECTORY_KEY_PATTERN, DIRECTORY_KEY_MESSAGE);

/** A text the forms edit, verbatim: task.yaml, prompt.md, reference.json, a rubric. */
const draftText = z.string().max(AUTHORING_LIMITS.draftTextMaxChars);

/**
 * A path in the task folder: relative, no `.` or `..` segment, no backslash,
 * no name the loader skips (a leading `.`), never under `verify/`.
 */
export const DraftFilePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !/(^\/|(^|\/)\.\.?(\/|$)|\\|\0|\/\/|\/$)/.test(p), {
    message: 'use a relative path in the task folder, without . or .. segments',
  })
  .refine((p) => !p.split('/').some((segment) => segment.startsWith('.')), {
    message: 'names starting with . are skipped by the loader',
  })
  .refine((p) => !isVerifyPath(p), {
    message: 'verify/ holds code and is edited on disk only',
  });

// ---------------------------------------------------------------------------
// The form: task.yaml as fields
// ---------------------------------------------------------------------------

/** One check as the Checks section edits it. Values are not checked here: a bad one is a readiness problem. */
export const TaskFormCheckSchema = z.strictObject({
  key: z.string().max(255),
  type: z.enum(SCORER_TYPES),
  primary: z.boolean(),
  /** As written in task.yaml (`pass_at`, `timeout_s`, …). */
  params: z.record(z.string(), JsonValueSchema),
});
export type TaskFormCheck = z.infer<typeof TaskFormCheckSchema>;

/**
 * task.yaml as the Form tab shows and edits it. Keys are strict (the form has
 * no field for an unknown key, so such a file locks the form) but values are
 * not: `maxTurns: 250` is stored and reported, never refused. Null is an
 * empty field. The API writes back only the fields that differ from the file,
 * through the yaml Document API, so comments, key order and an unchanged
 * field's formatting survive (V5).
 */
export const TaskFormSchema = z.strictObject({
  summary: z.string().max(10_000),
  maxTurns: z.number().int().nullable(),
  runBudgetSeconds: z.number().int().nullable(),
  toolsetsNeeded: z.array(z.string()),
  /** `answer.path`: the value in the answer block the primary check reads; null compares the whole block. */
  answerPath: z.string().nullable(),
  checks: z.array(TaskFormCheckSchema),
  /** `self_check.expected_workspace`, e.g. `expected`. */
  expectedWorkspace: z.string().nullable(),
  /** `self_check.expected_home`, e.g. `expected_home` (Phase 6). */
  expectedHome: z.string().nullable(),
  /** `self_check.negative_control`; null leaves it to the default (on when an expected folder is set). */
  negativeControl: z.boolean().nullable(),
  /**
   * `self_check.answers_from_fixtures` (Phase 7): true silences the
   * `reference_leak` readiness rule, for an answer picked from the task's
   * own data; null when task.yaml does not set it (false). The API always
   * sends it; a form sent without it leaves task.yaml's value as it is.
   */
  answersFromFixtures: z.boolean().nullable().optional(),
});
export type TaskForm = z.infer<typeof TaskFormSchema>;

// ---------------------------------------------------------------------------
// The task, its files, and its edits
// ---------------------------------------------------------------------------

/** Every kind a row of the Files tab can have: the text files the forms edit, then the blob kinds. */
export const DRAFT_FILE_VIEW_KINDS = [
  'task_yaml',
  'prompt',
  'reference',
  'rubric',
  ...DRAFT_FILE_KINDS,
] as const;
export type DraftFileViewKind = (typeof DRAFT_FILE_VIEW_KINDS)[number];

/** One file of the task folder (Files tab, SA.6). */
export const DraftFileViewSchema = z.object({
  /** In the task folder: `fixtures/invoices.csv`, `verify/check_summary.py`, `README.md`. */
  path: z.string(),
  kind: z.enum(DRAFT_FILE_VIEW_KINDS),
  /** The agent sees prompt.md, fixtures and home seeds; `other` files are not used by the platform. */
  visibility: z.enum(['agent', 'hidden', 'other']),
  /** Where the agent finds it: `/workspace/invoices.csv`, `~/memories/USER.md`, `task.txt`; null when hidden. */
  agentPath: z.string().nullable(),
  sizeBytes: countView,
  sha256: sha256View,
  /** e.g. "CSV · 48 rows · 8 columns", "PDF · 2 pages", "Text · 3 lines". */
  typeLabel: z.string(),
  /**
   * True for a text the forms edit (task.yaml, prompt.md, reference.json, a
   * rubric) that a zip held at more than AUTHORING_LIMITS.draftTextMaxChars
   * characters (Phase 5b question 18, Phase 7): it is kept as an `other`
   * blob, saved byte for byte and shown read-only, since the editor could
   * not save it back. Absent or false for every other file.
   */
  tooLargeToEdit: z.boolean().optional(),
});
export type DraftFileView = z.infer<typeof DraftFileViewSchema>;

/** The draft a task belongs to, as the editor's breadcrumb and menu need it. */
export const DraftRefSchema = z.object({
  id: z.string(),
  folder: z.string(),
  /** As shown: `./suites/invoices-v1`. */
  path: z.string(),
  name: z.string(),
  /** The base version, "Revert to v6"; null for a new suite. */
  baseVersion: z.number().int().positive().nullable(),
  nextVersion: z.number().int().positive(),
});
export type DraftRef = z.infer<typeof DraftRefSchema>;

export const DraftTaskDetailSchema = z
  .object({
    draft: DraftRefSchema,
    key: z.string(),
    position: countView,
    state: z.enum(DRAFT_TASK_STATES),
    /** The base task this one came from: its key (another one after a rename) and version. */
    base: z
      .object({
        key: z.string(),
        version: z.number().int().positive(),
        suiteVersion: z.number().int().positive(),
      })
      .nullable(),
    /** Set while the task holds an older version's files ("restored from v1"). */
    restoredFrom: z
      .object({
        taskVersion: z.number().int().positive(),
        suiteVersion: z.number().int().positive(),
      })
      .nullable(),
    /** The text files, verbatim; null when the folder has no such file. */
    taskYaml: z.string().nullable(),
    prompt: z.string().nullable(),
    reference: z.string().nullable(),
    /** The rubric files an llm_judge check names, verbatim. */
    rubrics: z.array(z.object({ path: z.string(), text: z.string() })),
    /** task.yaml as fields; null while the Form tab is locked (formLock). */
    form: TaskFormSchema.nullable(),
    /** Why the form cannot show task.yaml, located in it: "line 9, col 7: unknown key prmary". */
    formLock: z
      .object({
        line: z.number().int().positive().nullable(),
        column: z.number().int().positive().nullable(),
        message: z.string(),
      })
      .nullable(),
    /** Every file of the folder, text files first. */
    files: z.array(DraftFileViewSchema),
    readiness: TaskReadinessSchema,
    selfCheck: DraftSelfCheckViewSchema.nullable(),
    /** Goes up with every stored change; an update naming an older one is refused (409). */
    revision: countView,
    updatedAt: isoTimeView,
  })
  .refine((t) => (t.form === null) !== (t.formLock === null), {
    path: ['formLock'],
    message: 'formLock is set exactly when the form is not',
  });
export type DraftTaskDetail = z.infer<typeof DraftTaskDetailSchema>;

/**
 * Body of PUT …/tasks/:key: what changed, as the editor autosaves it. `form`
 * comes from the Form tab and `taskYaml` from the task.yaml tab, never both.
 */
export const UpdateDraftTaskRequestSchema = z
  .strictObject({
    /** Rename: the new folder name. Another task's key is refused (409). */
    key: DraftTaskKeySchema.optional(),
    form: TaskFormSchema.optional(),
    taskYaml: draftText.optional(),
    prompt: draftText.optional(),
    /** reference.json as typed; invalid JSON is stored and reported, not refused. */
    reference: draftText.optional(),
    /** Rubric texts by path; a path not named by any llm_judge check is refused. */
    rubrics: z.array(z.object({ path: DraftFilePathSchema, text: draftText })).optional(),
    /** Undo a removal: the task comes back as it was before it was removed. */
    removed: z.literal(false).optional(),
    /** The task's revision the edit was made on (optimistic concurrency). */
    revision: countView.optional(),
  })
  .refine((b) => b.form === undefined || b.taskYaml === undefined, {
    path: ['taskYaml'],
    message: 'send the form or task.yaml, not both',
  })
  .refine((b) => isUnique((b.rubrics ?? []).map((r) => r.path)), {
    path: ['rubrics'],
    message: 'a rubric path appears twice',
  });
export type UpdateDraftTaskRequest = z.infer<typeof UpdateDraftTaskRequestSchema>;

/** The kinds a file upload may add; `verify/` and `other` files never arrive this way. */
export const DRAFT_UPLOAD_KINDS = ['fixture', 'expected', 'home_seed', 'expected_home'] as const;
export type DraftUploadKind = (typeof DRAFT_UPLOAD_KINDS)[number];

/**
 * The fields beside `file` in POST …/tasks/:key/files (multipart). `path` is
 * inside the kind's folder (`docs/payment-terms.pdf` under `fixtures/`; for
 * a home seed `memories/USER.md`); the file's own name when absent. Files
 * over AUTHORING_LIMITS.suiteMaxFileBytes are refused (413), and the
 * refusal is kept on the draft task (DraftRefusedUpload).
 */
export const DraftFileUploadFieldsSchema = z.strictObject({
  kind: z.enum(DRAFT_UPLOAD_KINDS),
  path: DraftFilePathSchema.optional(),
});
export type DraftFileUploadFields = z.infer<typeof DraftFileUploadFieldsSchema>;

/**
 * An upload refused for its size (Phase 5b question 11, Phase 7), kept on
 * the draft task (suite_draft_tasks.refused_uploads, migration 0010) so the
 * readiness rule `file_limits` still reports it after a reload: a `problem`
 * row worded by refusedUploadMessage, whose Fix goes to the kind's section
 * with `path` as the field. Nothing of the file is stored. The API drops
 * the record when a file is stored at the same path, or when the path is
 * deleted (DELETE …/files/:path), which is how the author dismisses it.
 */
export const DraftRefusedUploadSchema = z.object({
  /** Where it would have gone, in the task folder: `fixtures/ledger-2025.parquet`. */
  path: z.string().min(1),
  kind: z.enum(DRAFT_UPLOAD_KINDS),
  /** The size the upload declared or reached before it was cut off; null when unknown. */
  sizeBytes: countView.nullable(),
  /** The limit it was refused against: AUTHORING_LIMITS.suiteMaxFileBytes when it was refused. */
  limitBytes: countView,
  refusedAt: isoTimeView,
});
export type DraftRefusedUpload = z.infer<typeof DraftRefusedUploadSchema>;

/** `a/b/ledger.csv` → `ledger.csv`. */
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** "`ledger-2025.parquet` is over 25 MB." (ReadinessPanel, problems state): the `file_limits` row of a refused upload. */
export function refusedUploadMessage(
  upload: Pick<DraftRefusedUpload, 'path' | 'limitBytes'>,
): string {
  const limit = upload.limitBytes / (1024 * 1024);
  const shown = Number.isInteger(limit) ? String(limit) : limit.toFixed(1);
  return `\`${baseName(upload.path)}\` is over ${shown} MB.`;
}

/** Body of PATCH …/files/:path: the file's new path in the task folder (Rename, or a move into another folder). */
export const MoveDraftFileRequestSchema = z.strictObject({
  path: DraftFilePathSchema,
  revision: countView.optional(),
});
export type MoveDraftFileRequest = z.infer<typeof MoveDraftFileRequestSchema>;

/** A draft task against its base version (GET …/tasks/:key/diff; SA.11's rows, TaskDiff "draft"). */
export const DraftTaskDiffSchema = z.object({
  key: z.string(),
  /** The base task version; null for a task the base does not hold, whose files are all added. */
  from: z
    .object({
      suiteId: z.string(),
      suiteVersion: z.number().int().positive(),
      taskVersion: z.number().int().positive(),
    })
    .nullable(),
  /** The draft side: its last edit. */
  updatedAt: isoTimeView,
  prompt: z.array(TextDiffLineSchema),
  taskYaml: z.array(TextDiffLineSchema),
  /** Changed JSON paths; [] when either side is not valid JSON (the text diff below still shows it). */
  reference: z.array(JsonDiffEntrySchema),
  referenceText: z.array(TextDiffLineSchema),
  files: z.array(TaskFileChangeSchema),
  textFiles: z.array(TaskTextFileDiffSchema),
});
export type DraftTaskDiff = z.infer<typeof DraftTaskDiffSchema>;
