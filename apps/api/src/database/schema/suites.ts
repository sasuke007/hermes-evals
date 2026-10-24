/**
 * Task suites. A suite is a folder of task folders on disk. Each successful
 * load that finds new content creates an immutable `suites` row with its
 * `tasks`; experiments point at the exact row they were launched from.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  SUITE_LOAD_OUTCOMES,
  TASK_FILE_KINDS,
  type JsonValue,
  type LoadIssue,
  type SelfCheck,
  type SuiteChanges,
  type SuiteLoadError,
  type SuiteLoadOutcome,
  type TaskFileKind,
  type TaskLimits,
  type VerificationEntry,
} from '@hermes-evals/shared';
import {
  emptyJsonArray,
  id,
  isRelativePath,
  isSha256,
  jsonValue,
  oneOf,
  storableText,
  tstz,
} from './_columns.js';
import { blobs } from './blobs.js';

/**
 * One immutable version of a suite. Identified by its directory, the hash of
 * its files, and the hash of what validation concluded about them: the same
 * bytes checked by a newer scorer registry can produce different validity.
 */
export const suites = pgTable(
  'suites',
  {
    id: id(),
    /** Directory the version was loaded from; matches suite_sources.path. */
    sourcePath: text('source_path').notNull(),
    /**
     * v1, v2, ... per directory, assigned by the loader as the directory's
     * highest number plus one (plan 4.5), so a version gets a new number even
     * when the author forgets to change `version_label`. A reload that reuses
     * an existing row (unchanged or reverted) reuses its number.
     */
    versionNumber: integer('version_number').notNull(),
    name: text('name').notNull(),
    /** `version` from suite.yaml, the author's label; shown muted beside the number. */
    versionLabel: text('version_label').notNull(),
    description: text('description'),
    /** sha256 over suite.yaml and every file of every task, sorted by path. */
    contentHash: text('content_hash').notNull(),
    /** sha256 over the loader and scorer versions plus each task's validity and self-check status. */
    checkHash: text('check_hash').notNull(),
    taskCount: integer('task_count').notNull(),
    validCount: integer('valid_count').notNull(),
    loadedAt: tstz('loaded_at').notNull().defaultNow(),
  },
  (t) => [
    // Reloading content that was loaded and judged the same way before reuses that row.
    uniqueIndex('suites_source_hashes_uq').on(t.sourcePath, t.contentHash, t.checkHash),
    // Target of suite_sources' pointer, which must stay within its own directory.
    unique('suites_id_source_uq').on(t.id, t.sourcePath),
    // Two loads racing on one directory cannot both take the next number.
    uniqueIndex('suites_source_version_uq').on(t.sourcePath, t.versionNumber),
    check('suites_version_number_ck', sql`${t.versionNumber} >= 1`),
    check('suites_content_hash_ck', isSha256(t.contentHash)),
    check('suites_check_hash_ck', isSha256(t.checkHash)),
    check('suites_counts_ck', sql`${t.validCount} >= 0 and ${t.validCount} <= ${t.taskCount}`),
  ],
);

/**
 * One row per suite directory under SUITES_DIR, and the result of its last
 * load. Points at the suites row currently served. A failed reload records the
 * error here and leaves `current_suite_id` on the last good version.
 */
export const suiteSources = pgTable(
  'suite_sources',
  {
    /** Directory relative to SUITES_DIR, e.g. `invoices-v1`. */
    path: text('path').primaryKey(),
    /** `name` from suite.yaml at the last successful parse. */
    name: text('name'),
    currentSuiteId: text('current_suite_id'),
    lastAttemptedAt: tstz('last_attempted_at').notNull().defaultNow(),
    lastOutcome: text('last_outcome').$type<SuiteLoadOutcome>().notNull(),
    lastError: jsonValue<SuiteLoadError>('last_error'),
    lastChanges: jsonValue<SuiteChanges>('last_changes'),
  },
  (t) => [
    foreignKey({
      name: 'suite_sources_current_suite_fk',
      columns: [t.currentSuiteId, t.path],
      foreignColumns: [suites.id, suites.sourcePath],
    }),
    // Two live directories may not declare the same suite name. A vanished
    // directory releases its name, so renaming a directory works.
    uniqueIndex('suite_sources_name_uq')
      .on(t.name)
      .where(sql`name is not null and last_outcome <> 'missing'`),
    check('suite_sources_last_outcome_ck', oneOf(t.lastOutcome, SUITE_LOAD_OUTCOMES)),
    check(
      'suite_sources_error_ck',
      sql`(${t.lastOutcome} = 'error') = (${t.lastError} is not null)`,
    ),
    check(
      'suite_sources_current_ck',
      sql`${t.lastOutcome} not in ('created', 'unchanged', 'reverted') or ${t.currentSuiteId} is not null`,
    ),
  ],
);

/**
 * One task of one suite version. The reference answer and the verification
 * list live here and are never copied into a trial workspace. A task that
 * fails to load or fails its self-check is stored with valid = false so the
 * UI can say why; it cannot be selected for an experiment.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: id(),
    suiteId: text('suite_id')
      .notNull()
      .references(() => suites.id),
    /** Folder name, unique within the suite. */
    key: text('key').notNull(),
    /**
     * v1, v2, ... per directory and task key. Goes up only when this task's
     * own content hash changes, so editing one task leaves the others'
     * numbers alone (plan 4.5).
     */
    versionNumber: integer('version_number').notNull(),
    /**
     * The suite version where this task content first appeared: this row's
     * own suite when the content is new, an earlier version of the same
     * directory when it is carried over unchanged.
     */
    introducedInSuiteId: text('introduced_in_suite_id').notNull(),
    /** Display order: suite.yaml `tasks` list first, then remaining keys sorted. */
    position: integer('position').notNull(),
    summary: text('summary'),
    /** prompt.md, exactly what the agent receives. */
    prompt: text('prompt'),
    /**
     * task.yaml exactly as read from disk, for version diffs and for showing
     * each verification entry's YAML verbatim. Null when it could not be read.
     */
    taskYaml: storableText('task_yaml'),
    limits: jsonValue<TaskLimits>('limits'),
    /** reference.json. SQL NULL when missing; JSON null is stored as 'null'::jsonb. */
    reference: jsonValue<JsonValue>('reference'),
    verification: jsonValue<VerificationEntry[]>('verification').notNull().default(emptyJsonArray),
    selfCheck: jsonValue<SelfCheck>('self_check').notNull(),
    loadIssues: jsonValue<LoadIssue[]>('load_issues').notNull().default(emptyJsonArray),
    valid: boolean('valid').notNull(),
    /** One line shown wherever an invalid task is listed. */
    invalidReason: text('invalid_reason'),
    contentHash: text('content_hash').notNull(),
  },
  (t) => [
    uniqueIndex('tasks_suite_key_uq').on(t.suiteId, t.key),
    foreignKey({
      name: 'tasks_introduced_in_suite_fk',
      columns: [t.introducedInSuiteId],
      foreignColumns: [suites.id],
    }),
    uniqueIndex('tasks_suite_position_uq').on(t.suiteId, t.position),
    check('tasks_key_ck', sql`${t.key} ~ '^[A-Za-z0-9][A-Za-z0-9_.-]*$'`),
    check('tasks_position_ck', sql`${t.position} >= 0`),
    check('tasks_version_number_ck', sql`${t.versionNumber} >= 1`),
    check('tasks_content_hash_ck', isSha256(t.contentHash)),
    check('tasks_invalid_reason_ck', sql`${t.valid} = (${t.invalidReason} is null)`),
    check(
      'tasks_valid_complete_ck',
      sql`not ${t.valid} or (${t.summary} is not null and ${t.prompt} is not null and ${t.limits} is not null and ${t.reference} is not null)`,
    ),
  ],
);

/**
 * Files a task needs at run, scoring or validation time: fixtures (the only
 * kind copied into a trial), verifier scripts, judge rubrics, and the hidden
 * known-good workspace (`expected/`) that file-checking verifiers are
 * validated against at load. The loader copies each into the content-addressed
 * blob store at DATA_DIR/blobs/<sha256>, so later edits on disk never change a
 * loaded task, and re-scoring never depends on a trial workspace surviving.
 */
export const taskFiles = pgTable(
  'task_files',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    /** Relative to the task folder, e.g. `fixtures/invoices.csv`. */
    path: text('path').notNull(),
    kind: text('kind').$type<TaskFileKind>().notNull(),
    sha256: text('sha256')
      .notNull()
      .references(() => blobs.sha256),
    size: bigint('size', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ name: 'task_files_pk', columns: [t.taskId, t.path] }),
    check('task_files_kind_ck', oneOf(t.kind, TASK_FILE_KINDS)),
    check('task_files_sha256_ck', isSha256(t.sha256)),
    check('task_files_size_ck', sql`${t.size} >= 0`),
    check('task_files_path_ck', isRelativePath(t.path)),
  ],
);
