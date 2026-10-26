/**
 * View models and request bodies of suite drafts (plan 4.6 and 11; boards
 * SA.1 to SA.3 and SA.11 to SA.13). Files stay the source of truth: edits go
 * into a draft, one per suite folder or new suite name, which saves on every
 * change; Save writes the folder under SUITES_DIR and loads it with the
 * normal loader. The tasks of a draft are in ./draft-tasks.ts, imports in
 * ./suite-import.ts. See ./common.ts for the conventions every contract
 * file follows.
 *
 * Routes, under /api (`:suite` is the folder name, DIRECTORY_KEY_PATTERN):
 *   GET    /suites/drafts                 every open draft → DraftSummary[]
 *   POST   /suites/drafts                 CreateSuiteDraftRequest → 201 SuiteDraftView (a new suite)
 *   POST   /suites/:suite/draft           a draft of an existing folder on its current version
 *                                         → 201 SuiteDraftView, or 200 with the one already open
 *   GET    /suites/:suite/draft           SuiteDraftView; 404 when there is none
 *   PATCH  /suites/:suite/draft           UpdateSuiteDraftRequest → SuiteDraftView
 *   DELETE /suites/:suite/draft           discard → 204; nothing on disk changes
 *   POST   /suites/:suite/draft/tasks     CreateDraftTaskRequest → 201 DraftTaskCreateResult
 *   GET    /suites/:suite/draft/review    DraftReview
 *   POST   /suites/:suite/draft/save      SaveSuiteDraftRequest → DraftSaveResult;
 *                                         409 DraftConflictBody, 422 DraftSaveFailureBody, 503 no worker
 *   POST   /suites/:suite/draft/rebase    RebaseSuiteDraftRequest → SuiteDraftView; 409 DraftConflictBody
 *   GET    /suites/:suite/versions/:n/zip the version's files, suiteVersionZipName (authoring.ts)
 *
 * Writes are refused with 409 while a save runs (SuiteDraftView.saving), and
 * when they name a revision older than the stored one.
 */
import { z } from 'zod';
import { DIRECTORY_KEY_MESSAGE, DIRECTORY_KEY_PATTERN } from '../suite-files.js';
import { DRAFT_ORIGINS, DRAFT_TASK_STATES, SCORER_TYPES } from '../vocab.js';
import { ApiErrorBodySchema, countView, isoTimeView, isUnique } from './common.js';
import { TASK_READINESS } from './draft-checks.js';
import { DraftTaskKeySchema } from './draft-tasks.js';
import { SuiteChangeSetSchema, SuiteLoadErrorViewSchema, SuiteVersionRefSchema } from './suites.js';

/** A suite folder name under SUITES_DIR: a new suite's name is its folder. */
export const SuiteFolderSchema = z
  .string()
  .max(255)
  .regex(DIRECTORY_KEY_PATTERN, DIRECTORY_KEY_MESSAGE);

const versionNumber = z.number().int().positive();

// ---------------------------------------------------------------------------
// What a draft changes
// ---------------------------------------------------------------------------

/** The kinds of change a draft lists against its base (plan 4.6: added, changed, removed, restored from vN, label, order). */
export const DRAFT_CHANGE_KINDS = [
  'added',
  'changed',
  'removed',
  'restored',
  'label',
  'description',
  'order',
] as const;
export type DraftChangeKind = (typeof DRAFT_CHANGE_KINDS)[number];

/** One change of the draft against its base, a chip of SuiteDraftBar ("restored total_due from v1", "label 0.3 → 0.4"). */
export const DraftChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('added'),
    key: z.string(),
    /** The base key of a renamed task, which the save removes ("Renaming makes this a new task"). */
    renamedFrom: z.string().nullable(),
  }),
  z.object({ kind: z.literal('changed'), key: z.string() }),
  z.object({ kind: z.literal('removed'), key: z.string() }),
  z.object({
    kind: z.literal('restored'),
    key: z.string(),
    fromTaskVersion: versionNumber,
    fromSuiteVersion: versionNumber,
  }),
  z.object({ kind: z.literal('label'), from: z.string().nullable(), to: z.string() }),
  z.object({
    kind: z.literal('description'),
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
  /** The task order written to suite.yaml's `tasks` changed. */
  z.object({ kind: z.literal('order') }),
]);
export type DraftChange = z.infer<typeof DraftChangeSchema>;

/** What blocks Review and save, at the suite level (SA.2, SA.3). Problems of tasks never do. */
export const DRAFT_SUITE_PROBLEMS = [
  'name_invalid',
  'name_taken',
  'label_empty',
  'no_tasks',
] as const;
export type DraftSuiteProblemCode = (typeof DRAFT_SUITE_PROBLEMS)[number];

export const DraftSuiteProblemSchema = z.object({
  code: z.enum(DRAFT_SUITE_PROBLEMS),
  /** e.g. "invoices-v1 is already used by ./suites/invoices-v1.", "Add at least one task to save v1." */
  message: z.string(),
});
export type DraftSuiteProblem = z.infer<typeof DraftSuiteProblemSchema>;

/** One row of the draft's task table (SA.3). */
export const DraftTaskRowSchema = z.object({
  key: z.string(),
  position: countView,
  state: z.enum(DRAFT_TASK_STATES),
  summary: z.string(),
  verificationTypes: z.array(z.enum(SCORER_TYPES)),
  fixtureCount: countView,
  /** The task's version in the base ("v2 → v3 on save"); null for a task the base does not hold. */
  baseVersion: versionNumber.nullable(),
  restoredFrom: z.object({ taskVersion: versionNumber, suiteVersion: versionNumber }).nullable(),
  /** Untouched tasks keep their last self-check's result. */
  readiness: z.enum(TASK_READINESS),
  updatedAt: isoTimeView,
});
export type DraftTaskRow = z.infer<typeof DraftTaskRowSchema>;

// ---------------------------------------------------------------------------
// Conflict and save progress
// ---------------------------------------------------------------------------

/**
 * Why the folder's current version is no longer the draft's base: a reload
 * created a newer version (`version_moved`), or the files on disk no longer
 * hashed to the base, so the save loaded them first, which created one
 * (`disk_changed`). Either way the draft combines onto `current`.
 */
export const DRAFT_CONFLICT_CAUSES = ['version_moved', 'disk_changed'] as const;
export type DraftConflictCause = (typeof DRAFT_CONFLICT_CAUSES)[number];

/** SA.12: the amber SuiteDraftBar, and the body of a save's 409. */
export const DraftConflictSchema = z.object({
  cause: z.enum(DRAFT_CONFLICT_CAUSES),
  baseVersion: versionNumber,
  /** The version to combine onto: "A reload at 16:40 created v7". */
  current: SuiteVersionRefSchema.extend({ loadedAt: isoTimeView }),
  /** The current version's changes against the base ("late_fees now valid"). */
  diskChanges: SuiteChangeSetSchema,
  /** Tasks the draft added, changed, removed or restored ("Your changes (overdue_count, total_due)"). */
  draftKeys: z.array(z.string()),
  /** Tasks both sides changed; each needs a choice before Combine (RebaseSuiteDraftRequest). */
  overlap: z.array(z.string()),
});
export type DraftConflict = z.infer<typeof DraftConflictSchema>;

/** The steps of a save as SaveSteps draws them; the folder in SUITES_DIR changes only at `moving`. */
export const SAVE_STEPS = ['staging', 'loading', 'self_checks', 'moving'] as const;
export type SaveStep = (typeof SAVE_STEPS)[number];

/** A save in progress, as the worker reports it. */
export const DraftSaveProgressSchema = z.object({
  startedAt: isoTimeView,
  step: z.enum(SAVE_STEPS),
  /** "Self-checks 1 of 2…", once the step is reached. */
  selfChecks: z.object({ done: countView, total: countView }).nullable(),
});
export type DraftSaveProgress = z.infer<typeof DraftSaveProgressSchema>;

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

export const SuiteDraftViewSchema = z.object({
  id: z.string(),
  folder: z.string(),
  /** As shown: `./suites/invoices-v1`. */
  path: z.string(),
  /** suite.yaml's name; fixed after the first save. */
  name: z.string(),
  origin: z.enum(DRAFT_ORIGINS),
  /** The version the draft is based on; null for a new suite. */
  base: SuiteVersionRefSchema.nullable(),
  /** The version a save creates: "Review and save as v7"; 1 for a new suite. */
  nextVersion: versionNumber,
  /** May be empty, a suite-level problem. */
  versionLabel: z.string(),
  description: z.string().nullable(),
  changes: z.array(DraftChangeSchema),
  /** In draft order, removed tasks included. */
  tasks: z.array(DraftTaskRowSchema),
  problems: z.array(DraftSuiteProblemSchema),
  /** Set when the folder's current version is no longer the base (found on open or at save). */
  conflict: DraftConflictSchema.nullable(),
  /** Set while a save runs; writes are refused until it ends. */
  saving: DraftSaveProgressSchema.nullable(),
  /** Goes up with every stored change of the draft or its tasks. */
  revision: countView,
  createdAt: isoTimeView,
  /** "saved 16:31". */
  updatedAt: isoTimeView,
});
export type SuiteDraftView = z.infer<typeof SuiteDraftViewSchema>;

/** One open draft, for the suite list's chip ("draft · 3 changes") and its unsaved new suites (SA.1). */
export const DraftSummarySchema = z.object({
  id: z.string(),
  folder: z.string(),
  path: z.string(),
  name: z.string(),
  origin: z.enum(DRAFT_ORIGINS),
  /** "Draft based on v6"; null for a new suite. */
  baseVersion: versionNumber.nullable(),
  /** SuiteDraftView.changes.length. */
  changeCount: countView,
  /** Tasks the save would write: removed ones left out. */
  taskCount: countView,
  conflict: z.boolean(),
  /** "last edited 16:31". */
  updatedAt: isoTimeView,
});
export type DraftSummary = z.infer<typeof DraftSummarySchema>;

/**
 * Body of POST /suites/drafts: a new suite (SA.2). The name is also the
 * folder; one that a suite, a folder or another draft holds is refused (409).
 * A copy takes every task of the suite's current version (or `versionNumber`)
 * with its files, verifier scripts included, which are already on disk, so it
 * needs no confirmation; a zip needs `trustScripts` when it holds scripts (R7).
 */
export const CreateSuiteDraftRequestSchema = z.strictObject({
  name: SuiteFolderSchema,
  versionLabel: z.string().trim().min(1, 'Add a version label.').max(200),
  description: z.string().max(10_000).optional(),
  from: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('empty') }),
    z.strictObject({
      kind: z.literal('copy'),
      suite: SuiteFolderSchema,
      versionNumber: versionNumber.optional(),
    }),
    z.strictObject({
      kind: z.literal('zip'),
      /** From POST /suites/import/validate. */
      token: z.string().min(1),
      /** "I trust these scripts"; required when the zip holds verifier scripts. */
      trustScripts: z.boolean(),
    }),
  ]),
});
export type CreateSuiteDraftRequest = z.infer<typeof CreateSuiteDraftRequestSchema>;

/** Body of PATCH /suites/:suite/draft: Edit details and the task order. */
export const UpdateSuiteDraftRequestSchema = z.strictObject({
  /** May be emptied: that blocks Review and save, it is not refused. */
  versionLabel: z.string().max(200).optional(),
  description: z.string().max(10_000).nullable().optional(),
  /** Every task key of the draft, removed ones included, in the new order. */
  order: z
    .array(DraftTaskKeySchema)
    .refine(isUnique, { message: 'a task appears twice in the order' })
    .optional(),
  revision: countView.optional(),
});
export type UpdateSuiteDraftRequest = z.infer<typeof UpdateSuiteDraftRequestSchema>;

/**
 * Body of POST /suites/:suite/draft/tasks (Add task, Duplicate, Restore on
 * Task detail, Copy tasks from another suite). A key another task holds is
 * refused (409); a blank or duplicated task without one gets a free key
 * (`new_task`, `total_due_copy`, then `_2`, …).
 */
export const CreateDraftTaskRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('blank'), key: DraftTaskKeySchema.optional() }),
  z.strictObject({
    kind: z.literal('duplicate'),
    from: DraftTaskKeySchema,
    key: DraftTaskKeySchema.optional(),
  }),
  /** Task `key` of the folder's version `suiteVersion`, from its blobs; it replaces the draft's task of that key. */
  z.strictObject({
    kind: z.literal('restore'),
    suiteVersion: versionNumber,
    key: DraftTaskKeySchema,
  }),
  z.strictObject({
    kind: z.literal('copy'),
    suite: SuiteFolderSchema,
    versionNumber: versionNumber.optional(),
    keys: z.array(DraftTaskKeySchema).min(1).refine(isUnique, { message: 'a task appears twice' }),
  }),
]);
export type CreateDraftTaskRequest = z.infer<typeof CreateDraftTaskRequestSchema>;

export const DraftTaskCreateResultSchema = z.object({
  /** The keys the request added or restored, in draft order. */
  keys: z.array(z.string()).min(1),
  draft: SuiteDraftViewSchema,
});
export type DraftTaskCreateResult = z.infer<typeof DraftTaskCreateResultSchema>;

// ---------------------------------------------------------------------------
// Review, save, rebase (SA.11, SA.12)
// ---------------------------------------------------------------------------

/** One line of "What is written". */
export const DraftWriteSchema = z.object({
  /** `+` add, `~` change, `-` remove a whole task folder. */
  op: z.enum(['add', 'change', 'remove']),
  /** As shown: `./suites/invoices-v1/overdue_count/prompt.md`, or a removed folder `./suites/invoices-v1/fx_rates/`. */
  path: z.string(),
  beforeBytes: countView.nullable(),
  afterBytes: countView.nullable(),
  /** suite.yaml's "version_label 0.3 → 0.4 · tasks + overdue_count"; a removed folder's "4 files". */
  note: z.string().nullable(),
});
export type DraftWrite = z.infer<typeof DraftWriteSchema>;

/** GET /suites/:suite/draft/review: what Save writes and what it creates. */
export const DraftReviewSchema = z.object({
  draft: SuiteDraftViewSchema,
  /** Each change with its one-line summary: "new task · 4 files · 1 check", "prompt +1 sentence". */
  changes: z.array(z.object({ change: DraftChangeSchema, detail: z.string() })),
  /** Files the UI does not manage (verify/, a README) are kept as they are and not listed. */
  writes: z.array(DraftWriteSchema),
  /** The added, changed and restored tasks' readiness: "overdue_count added · self-check passed · 16:31". */
  readiness: z.array(
    z.object({
      key: z.string(),
      state: z.enum(DRAFT_TASK_STATES),
      readiness: z.enum(TASK_READINESS),
      note: z.string(),
    }),
  ),
  /** Tasks that would be stored invalid: "Save with 1 invalid task?". */
  invalid: z.array(z.object({ key: z.string(), reason: z.string() })),
});
export type DraftReview = z.infer<typeof DraftReviewSchema>;

/** Body of POST /suites/:suite/draft/save. */
export const SaveSuiteDraftRequestSchema = z.strictObject({
  /** The label to save with, when the save page changed it; the draft's otherwise. */
  versionLabel: z.string().trim().min(1, 'Add a version label.').max(200).optional(),
  /** The draft revision the user reviewed; a newer one is refused (409). */
  revision: countView.optional(),
});
export type SaveSuiteDraftRequest = z.infer<typeof SaveSuiteDraftRequestSchema>;

/** The load result of a save (plan 4.6 step 5); the draft is gone. */
export const DraftSaveResultSchema = z.object({
  /** `unchanged`: "Nothing changed. invoices-v1 stays at v6."; `reverted`: the files of an earlier version. */
  outcome: z.enum(['created', 'unchanged', 'reverted']),
  suite: SuiteVersionRefSchema,
  changes: SuiteChangeSetSchema,
  taskCount: countView,
  validCount: countView,
  invalid: z.array(z.object({ key: z.string(), reason: z.string() })),
});
export type DraftSaveResult = z.infer<typeof DraftSaveResultSchema>;

/** The 409 of save and rebase when the folder moved past the draft's base. */
export const DraftConflictBodySchema = ApiErrorBodySchema.extend({
  statusCode: z.literal(409),
  conflict: DraftConflictSchema,
});
export type DraftConflictBody = z.infer<typeof DraftConflictBodySchema>;

/**
 * The 422 of a save whose staging folder failed the loader at the folder
 * level (suite.yaml or a task.yaml does not parse, an unsafe file, a name
 * another folder holds): nothing on disk changed and the draft is kept.
 */
export const DraftSaveFailureBodySchema = ApiErrorBodySchema.extend({
  statusCode: z.literal(422),
  step: z.enum(SAVE_STEPS),
  /** The loader's message, located: "overdue_count/task.yaml line 9: unknown key prmary". */
  error: SuiteLoadErrorViewSchema,
});
export type DraftSaveFailureBody = z.infer<typeof DraftSaveFailureBodySchema>;

/** Body of POST /suites/:suite/draft/rebase: combine onto `onto`, keeping one side of each overlapping task. */
export const RebaseSuiteDraftRequestSchema = z.strictObject({
  /** The version the user reviewed; when the folder moved again, 409 with the new conflict. */
  onto: versionNumber,
  /** One per task of DraftConflict.overlap: `mine` keeps the draft's task, `disk` the version's. */
  choices: z
    .array(z.object({ key: z.string(), keep: z.enum(['mine', 'disk']) }))
    .refine((c) => isUnique(c.map((x) => x.key)), { message: 'a task has two choices' }),
});
export type RebaseSuiteDraftRequest = z.infer<typeof RebaseSuiteDraftRequestSchema>;
