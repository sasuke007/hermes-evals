/**
 * Imports (plan 4.6 and 11): tasks from a CSV or JSONL file into a draft
 * (ImportTasks, SA.9, with ColumnMapper), and a whole suite from a .zip as
 * the draft of a new suite (ImportSuiteDialog, SA.10). See ./common.ts for
 * the conventions every contract file follows.
 *
 * Routes, under /api:
 *   POST /suites/:suite/draft/import/validate  multipart `file`, optional `settings`
 *        (TaskImportSettings as JSON), optional `workspace` files → TaskImportValidation
 *   POST /suites/:suite/draft/import           the same parts, `settings` required
 *        → 201 TaskImportResult; 422 TaskImportRefusalBody while a row needs a fix
 *   POST /suites/import/validate               multipart `file` (.zip) → SuiteZipValidation
 *   POST /suites/import                        SuiteZipImportRequest → 201 SuiteDraftView
 *
 * The task file is parsed in the API (AUTHORING_LIMITS: 5 MB, 500 rows) and
 * nothing is written to SUITES_DIR until the draft is saved. A zip is read
 * with the hardened reader of skill uploads (no links, absolute paths or
 * `..`, at most 20,000 entries, 25 MB a file, 12 levels) and validated
 * without running any of its code; its verifier scripts are listed so the
 * user can confirm them (R7).
 */
import { z } from 'zod';
import { ApiErrorBodySchema, countView, isUnique, sha256View } from './common.js';
import { TASK_READINESS } from './draft-checks.js';
import { DraftTaskKeySchema, TaskFormCheckSchema } from './draft-tasks.js';
import { SuiteDraftViewSchema, SuiteFolderSchema } from './drafts.js';
import { UploadProblemSchema } from './resources.js';

// ---------------------------------------------------------------------------
// Tasks from CSV or JSONL (SA.9)
// ---------------------------------------------------------------------------

export const TASK_IMPORT_FORMATS = ['csv', 'jsonl'] as const;
export type TaskImportFormat = (typeof TASK_IMPORT_FORMATS)[number];

/** What a column becomes in the new tasks (ColumnMapper's "Use as"). */
export const TASK_IMPORT_COLUMN_USES = [
  'task_key',
  'summary',
  'prompt',
  'reference',
  'reference_value',
  'ignore',
] as const;
export type TaskImportColumnUse = (typeof TASK_IMPORT_COLUMN_USES)[number];

export const TASK_IMPORT_COLUMN_USE_LABELS = {
  task_key: 'Task key',
  summary: 'Summary',
  prompt: 'Prompt',
  reference: 'Reference (whole JSON)',
  reference_value: 'Reference value at the answer path',
  ignore: 'Ignore',
} as const satisfies Record<TaskImportColumnUse, string>;

/** One column of the file: its name (a JSONL object's key) and its first values. */
export const TaskTableColumnSchema = z.object({
  name: z.string(),
  /** Up to 3 values, as text. */
  samples: z.array(z.string()),
});
export type TaskTableColumn = z.infer<typeof TaskTableColumnSchema>;

/** The file as read: "overdue_questions.csv · 6 rows · key, question, expected · 0.4 KB". */
export const TaskTableFileSchema = z.object({
  fileName: z.string(),
  format: z.enum(TASK_IMPORT_FORMATS),
  sizeBytes: countView,
  rowCount: countView,
  columns: z.array(TaskTableColumnSchema),
});
export type TaskTableFile = z.infer<typeof TaskTableFileSchema>;

/**
 * The settings every imported task shares (step 3). Workspace files come
 * from no task, a task of the draft, or the `workspace` file parts of the
 * request (each at `fixtures/<its name>`). Checks are new ones or a task's.
 */
export const TaskImportSettingsSchema = z.strictObject({
  /** Each column of the file and what it becomes; columns left out are ignored. */
  mapping: z
    .array(z.object({ column: z.string(), use: z.enum(TASK_IMPORT_COLUMN_USES) }))
    .refine((m) => isUnique(m.map((x) => x.column)), { message: 'a column is mapped twice' }),
  /** Keys when no column is Task key: `overdue_q` gives overdue_q01, overdue_q02, … (generatedTaskKey). */
  keyPrefix: z.string().max(200).nullable(),
  /** The answer path of every task; each reference value becomes `{ "<path>": <value> }`. */
  answerPath: z.string().max(500).nullable(),
  workspace: z.discriminatedUnion('from', [
    z.strictObject({ from: z.literal('none') }),
    z.strictObject({ from: z.literal('task'), key: DraftTaskKeySchema }),
    z.strictObject({ from: z.literal('upload') }),
  ]),
  checks: z.discriminatedUnion('from', [
    z.strictObject({ from: z.literal('new'), checks: z.array(TaskFormCheckSchema).min(1) }),
    z.strictObject({ from: z.literal('task'), key: DraftTaskKeySchema }),
  ]),
  limits: z.strictObject({
    maxTurns: z.number().int(),
    runBudgetSeconds: z.number().int(),
    toolsetsNeeded: z.array(z.string()),
  }),
  /** Append answerInstructions(answerPath, reference) to every prompt (authoring.ts). */
  appendAnswerInstructions: z.boolean(),
  /** Inline fixes of the preview: the key of a data row (1-based). */
  keyFixes: z
    .array(z.object({ row: z.number().int().positive(), key: DraftTaskKeySchema }))
    .refine((f) => isUnique(f.map((x) => String(x.row))), { message: 'a row is fixed twice' }),
});
export type TaskImportSettings = z.infer<typeof TaskImportSettingsSchema>;

/** Which field of an imported row a problem belongs to. */
export const TASK_IMPORT_FIELDS = ['key', 'summary', 'prompt', 'reference'] as const;
export type TaskImportField = (typeof TASK_IMPORT_FIELDS)[number];

/** One row of the preview (step 4). */
export const TaskImportPreviewRowSchema = z.object({
  /** The data row, 1-based. */
  row: z.number().int().positive(),
  key: z.string(),
  summary: z.string(),
  /** The reference value as compact JSON. */
  referenceValue: z.string(),
  readiness: z.enum(TASK_READINESS),
  /** e.g. key: "Row 4: key overdue 90 has a space. Use letters, digits, ., _ and -." */
  problems: z.array(z.object({ field: z.enum(TASK_IMPORT_FIELDS), message: z.string() })),
  /** True when the row cannot be added as it is: its key is not a folder name or is taken. */
  needsFix: z.boolean(),
});
export type TaskImportPreviewRow = z.infer<typeof TaskImportPreviewRowSchema>;

export const TaskImportPreviewSchema = z.object({
  rows: z.array(TaskImportPreviewRowSchema),
  /** "Add 6 tasks to the draft". */
  addCount: countView,
  /** "1 row needs a fix": Add is disabled while it is above 0. */
  fixCount: countView,
  /**
   * About the mapping as a whole: problems ("Map one column to Prompt.", "Map
   * one column to Reference or Reference value.") and notes ("No column is
   * mapped to Summary. Summaries are taken from the first 80 characters of
   * each prompt.").
   */
  messages: z.array(z.object({ severity: z.enum(['problem', 'info']), message: z.string() })),
});
export type TaskImportPreview = z.infer<typeof TaskImportPreviewSchema>;

/**
 * POST …/draft/import/validate: the file as read (step 1) and, with
 * settings, the preview (step 4). A file that cannot be imported has
 * `problems` ("all_questions.csv: 1,240 rows. The limit is 500 per import.")
 * and no preview.
 */
export const TaskImportValidationSchema = z.object({
  file: TaskTableFileSchema.nullable(),
  problems: z.array(UploadProblemSchema),
  preview: TaskImportPreviewSchema.nullable(),
});
export type TaskImportValidation = z.infer<typeof TaskImportValidationSchema>;

export const TaskImportResultSchema = z.object({
  /** The keys added, as `added` tasks of the draft. */
  added: z.array(z.string()),
  draft: SuiteDraftViewSchema,
});
export type TaskImportResult = z.infer<typeof TaskImportResultSchema>;

/** The 422 of an import with rows that need a fix; nothing was added. */
export const TaskImportRefusalBodySchema = ApiErrorBodySchema.extend({
  statusCode: z.literal(422),
  preview: TaskImportPreviewSchema,
});
export type TaskImportRefusalBody = z.infer<typeof TaskImportRefusalBodySchema>;

// ---------------------------------------------------------------------------
// A suite from a .zip (SA.10)
// ---------------------------------------------------------------------------

/** A verifier script in the zip: "This suite contains code" lists each one. */
export const SuiteZipScriptSchema = z.object({
  /** In the suite: `late_fees/verify/check_late_fees.py`. */
  path: z.string(),
  sizeBytes: countView,
  sha256: sha256View,
});
export type SuiteZipScript = z.infer<typeof SuiteZipScriptSchema>;

/** One task of the zip: "unmatched_lines · valid · 2 workspace files · 1 check". */
export const SuiteZipTaskSchema = z.object({
  key: z.string(),
  summary: z.string().nullable(),
  /**
   * The readiness rules that run without code; checks that need the worker
   * (file checks, verifier scripts) stay `not_run` until the draft's
   * self-check or its save.
   */
  readiness: z.enum(TASK_READINESS),
  /** The first problem, for "late_fees · invalid: …"; null without one. */
  problem: z.string().nullable(),
  workspaceFiles: countView,
  checks: countView,
});
export type SuiteZipTask = z.infer<typeof SuiteZipTaskSchema>;

/**
 * Result of POST /suites/import/validate. Nothing is stored in SUITES_DIR;
 * the files wait in the blob store under `token`.
 * - `valid`: Import as a draft (after "I trust these scripts" when `scripts` is not empty).
 * - `name_taken`: valid, but suite.yaml's name is held by `nameTaken.path`; import under another name.
 * - `rejected`: `problems` say why ("The zip has a symbolic link at …"); `token` is null.
 */
export const SuiteZipValidationSchema = z
  .object({
    token: z.string().nullable(),
    fileName: z.string(),
    sizeBytes: countView,
    outcome: z.enum(['valid', 'name_taken', 'rejected']),
    /** From suite.yaml; null when it could not be read. */
    suite: z
      .object({ name: z.string(), versionLabel: z.string(), description: z.string().nullable() })
      .nullable(),
    nameTaken: z
      .object({
        /** As shown: `./suites/invoices-v1`. */
        path: z.string(),
        /** A free name to import as: `invoices-v1-copy`. */
        suggestion: z.string(),
      })
      .nullable(),
    tasks: z.array(SuiteZipTaskSchema),
    scripts: z.array(SuiteZipScriptSchema),
    fileCount: countView,
    unpackedBytes: countView,
    problems: z.array(UploadProblemSchema),
  })
  .refine((v) => (v.outcome === 'rejected') === (v.token === null), {
    path: ['token'],
    message: 'a token exactly when the zip can be imported',
  })
  .refine((v) => (v.outcome === 'name_taken') === (v.nameTaken !== null), {
    path: ['nameTaken'],
    message: 'nameTaken exactly when the outcome is name_taken',
  });
export type SuiteZipValidation = z.infer<typeof SuiteZipValidationSchema>;

/**
 * Body of POST /suites/import: the validated zip becomes the draft of a new
 * suite with every task added, saved as v1 after review. `name` is the
 * suite's name and folder (suite.yaml's own, or a new one when it was taken).
 * A zip with scripts is refused (409, "Confirm the verifier scripts first.")
 * unless `trustScripts` is true.
 */
export const SuiteZipImportRequestSchema = z.strictObject({
  token: z.string().min(1),
  name: SuiteFolderSchema,
  trustScripts: z.boolean(),
});
export type SuiteZipImportRequest = z.infer<typeof SuiteZipImportRequestSchema>;
