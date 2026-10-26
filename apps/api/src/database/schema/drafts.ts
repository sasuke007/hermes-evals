/**
 * Suite drafts (plan 4.6, Phase 5b): the only mutable suite data. A draft is
 * working state, never evidence, and nothing launches from it. Files stay the
 * source of truth: saving writes the folder under SUITES_DIR and loads it
 * with the normal loader, which creates the suites and tasks rows; then the
 * draft is deleted, and its tasks and files with it.
 *
 * A draft holds a full picture of the folder: the text files the forms edit
 * verbatim on its tasks, and every other file as a reference into the blob
 * store with its kind. Uploads go to the blob store first, so these rows
 * never hold file bytes, and the foreign keys keep every blob a draft names.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  DRAFT_FILE_KINDS,
  DRAFT_ORIGINS,
  DRAFT_TASK_STATES,
  HOME_SEED_PATHS,
  type DraftFileKind,
  type DraftOrigin,
  type DraftSaveProgress,
  type DraftTaskState,
  type SelfCheck,
  type TaskReadiness,
} from '@hermes-evals/shared';
import {
  createdAt,
  emptyJsonObject,
  id,
  isRelativePath,
  isSha256,
  jsonValue,
  oneOf,
  storableText,
  tstz,
} from './_columns.js';
import { blobs } from './blobs.js';
import { suites, tasks } from './suites.js';

/** The suite.yaml name and folder rule, DIRECTORY_KEY_PATTERN, as tasks_key_ck writes it. */
const DIRECTORY_KEY = `'^[A-Za-z0-9][A-Za-z0-9_.-]*$'`;

/** The last worker self-check of a draft task: the loader's record, and the content it ran on. */
export type DraftSelfCheckRecord = SelfCheck & {
  /** The draft task's content_hash when it ran; a later edit makes it out of date. */
  content_hash: string;
};

/**
 * One open draft per suite folder under SUITES_DIR, or per new suite name,
 * which is its folder. `base_suite_id` is the version a draft of an existing
 * folder started from (and must be a version of that folder); a new suite
 * has none.
 */
export const suiteDrafts = pgTable(
  'suite_drafts',
  {
    id: id(),
    /** The folder relative to SUITES_DIR, e.g. `invoices-v1`; a new suite's name. Routes address drafts by it. */
    sourcePath: text('source_path').notNull(),
    /** suite.yaml's name: the folder's current name, or the new suite's. Fixed after the first save. */
    name: text('name').notNull(),
    origin: text('origin').$type<DraftOrigin>().notNull(),
    baseSuiteId: text('base_suite_id'),
    /** The suite version a `copy` draft copied its tasks from. */
    copiedFromSuiteId: text('copied_from_suite_id').references(() => suites.id),
    /** May be '' while the user edits it: a suite-level problem that blocks saving, not a refusal. */
    versionLabel: text('version_label').notNull(),
    description: text('description'),
    /** When the user ticked "I trust these scripts" for a zip that holds verifier scripts (R7). */
    scriptsTrustedAt: tstz('scripts_trusted_at'),
    /** Set while a save-suite-draft job runs; writes are refused until it is cleared or stale. */
    saveStartedAt: tstz('save_started_at'),
    /** The save's step as the worker reports it (SaveSteps). */
    saveProgress: jsonValue<DraftSaveProgress>('save_progress'),
    /** Goes up with every stored change of the draft or one of its tasks. */
    revision: integer('revision').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    // At most one draft per folder or new suite name.
    uniqueIndex('suite_drafts_source_uq').on(t.sourcePath),
    // The base is a version of this very folder.
    foreignKey({
      name: 'suite_drafts_base_suite_fk',
      columns: [t.baseSuiteId, t.sourcePath],
      foreignColumns: [suites.id, suites.sourcePath],
    }),
    check('suite_drafts_source_ck', sql`${t.sourcePath} ~ ${sql.raw(DIRECTORY_KEY)}`),
    check('suite_drafts_name_ck', sql`${t.name} ~ ${sql.raw(DIRECTORY_KEY)}`),
    check('suite_drafts_origin_ck', oneOf(t.origin, DRAFT_ORIGINS)),
    // A draft of an existing folder has a base; a new suite has none.
    check('suite_drafts_base_ck', sql`(${t.origin} = 'edit') = (${t.baseSuiteId} is not null)`),
    check(
      'suite_drafts_copied_from_ck',
      sql`(${t.origin} = 'copy') = (${t.copiedFromSuiteId} is not null)`,
    ),
    check(
      'suite_drafts_scripts_trusted_ck',
      sql`${t.scriptsTrustedAt} is null or ${t.origin} = 'zip'`,
    ),
    check(
      'suite_drafts_save_progress_ck',
      sql`${t.saveProgress} is null or ${t.saveStartedAt} is not null`,
    ),
    check('suite_drafts_revision_ck', sql`${t.revision} >= 0`),
  ],
);

/**
 * One task of a draft: its state against the base, the text files the forms
 * edit stored verbatim (null when the folder has no such file), and the last
 * readiness and self-check. A removed task keeps its content, so Undo brings
 * it back as it was.
 */
export const suiteDraftTasks = pgTable(
  'suite_draft_tasks',
  {
    id: id(),
    draftId: text('draft_id')
      .notNull()
      .references(() => suiteDrafts.id, { onDelete: 'cascade' }),
    /** The task's folder name; the save writes `<source_path>/<key>/`. */
    key: text('key').notNull(),
    /** Draft order, written to suite.yaml's `tasks`. Ties are broken by key. */
    position: integer('position').notNull(),
    state: text('state').$type<DraftTaskState>().notNull(),
    /** The base version's task this one came from (another key after a rename). */
    baseTaskId: text('base_task_id').references(() => tasks.id),
    /** The older task version whose files a `restored` task holds. */
    restoredFromTaskId: text('restored_from_task_id').references(() => tasks.id),
    /** task.yaml exactly as typed or read; edited through the yaml Document API. */
    taskYaml: storableText('task_yaml'),
    /** prompt.md exactly as typed or read. */
    prompt: storableText('prompt'),
    /** reference.json exactly as typed or read, valid JSON or not. */
    reference: storableText('reference'),
    /** The rubric files llm_judge checks name, path in the task folder → text. */
    rubrics: jsonValue<Record<string, string>>('rubrics').notNull().default(emptyJsonObject),
    /**
     * The loader's task content hash of the draft folder as last analysed
     * (analyseTask). Equal to the base task's content_hash exactly when the
     * task is unchanged, and the hash a self-check result belongs to.
     */
    contentHash: text('content_hash'),
    readiness: jsonValue<TaskReadiness>('readiness'),
    selfCheck: jsonValue<DraftSelfCheckRecord>('self_check'),
    revision: integer('revision').notNull().default(0),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('suite_draft_tasks_key_uq').on(t.draftId, t.key),
    check('suite_draft_tasks_key_ck', sql`${t.key} ~ ${sql.raw(DIRECTORY_KEY)}`),
    check('suite_draft_tasks_position_ck', sql`${t.position} >= 0`),
    check('suite_draft_tasks_state_ck', oneOf(t.state, DRAFT_TASK_STATES)),
    // Only a task the base holds can be changed, removed or unchanged.
    check(
      'suite_draft_tasks_base_ck',
      sql`${t.state} not in ('changed', 'removed', 'unchanged') or ${t.baseTaskId} is not null`,
    ),
    check(
      'suite_draft_tasks_restored_ck',
      sql`(${t.state} = 'restored') = (${t.restoredFromTaskId} is not null)`,
    ),
    check(
      'suite_draft_tasks_content_hash_ck',
      sql`${t.contentHash} is null or ${isSha256(t.contentHash)}`,
    ),
    check('suite_draft_tasks_rubrics_ck', sql`jsonb_typeof(${t.rubrics}) = 'object'`),
    check('suite_draft_tasks_revision_ck', sql`${t.revision} >= 0`),
  ],
);

/**
 * Every file of a draft task other than its text files, by blob. The kind
 * follows from where the file is, as the loader classifies it (task-files.ts):
 * `verifier` exactly under `verify/` (read-only: draft endpoints refuse every
 * write there), `fixture` exactly under `fixtures/`, `home_seed` exactly the
 * two memory files; `expected` and `expected_home` depend on task.yaml's
 * folders, and `other` is anything the loader does not read, kept as is.
 */
export const suiteDraftFiles = pgTable(
  'suite_draft_files',
  {
    draftTaskId: text('draft_task_id')
      .notNull()
      .references(() => suiteDraftTasks.id, { onDelete: 'cascade' }),
    /** Relative to the task folder, e.g. `fixtures/invoices.csv`. */
    path: text('path').notNull(),
    kind: text('kind').$type<DraftFileKind>().notNull(),
    sha256: text('sha256')
      .notNull()
      .references(() => blobs.sha256),
    size: bigint('size', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'suite_draft_files_pk', columns: [t.draftTaskId, t.path] }),
    check('suite_draft_files_kind_ck', oneOf(t.kind, DRAFT_FILE_KINDS)),
    check('suite_draft_files_path_ck', isRelativePath(t.path)),
    check('suite_draft_files_sha256_ck', isSha256(t.sha256)),
    check('suite_draft_files_size_ck', sql`${t.size} >= 0`),
    check(
      'suite_draft_files_verifier_ck',
      sql`(${t.kind} = 'verifier') = (${t.path} like 'verify/%')`,
    ),
    check(
      'suite_draft_files_fixture_ck',
      sql`(${t.kind} = 'fixture') = (${t.path} like 'fixtures/%')`,
    ),
    check(
      'suite_draft_files_home_seed_ck',
      sql`(${t.kind} = 'home_seed') = (${t.path} in (${sql.raw(HOME_SEED_PATHS.map((p) => `'${p}'`).join(', '))}))`,
    ),
  ],
);
