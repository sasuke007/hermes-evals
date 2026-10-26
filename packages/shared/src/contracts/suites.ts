/**
 * View models for suites and tasks (Suites section, plan sections 4 and 4.5).
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { JsonValueSchema } from '../records.js';
import { EXPERIMENT_STATUSES, SCORE_STATUSES } from '../status.js';
import { SCORER_TYPES, SUITE_LOAD_OUTCOMES } from '../vocab.js';
import { countView, isoTimeView, sha256View } from './common.js';

const scorerType = z.enum(SCORER_TYPES);
const loadOutcome = z.enum(SUITE_LOAD_OUTCOMES);

/** A suite version as other records refer to it (experiment snapshot, run header). */
export const SuiteVersionRefSchema = z.object({
  /** Id of the immutable suite version row. */
  suiteId: z.string(),
  /** suite.yaml name, also the directory name: `invoices-v1`. */
  name: z.string(),
  /** v1, v2, … assigned by the loader per directory. */
  versionNumber: z.number().int().positive(),
  /** The author's `version_label` from suite.yaml, shown muted. */
  versionLabel: z.string().nullable(),
  /** sha256 of suite.yaml and every task file. Pages show the first 7 characters. */
  contentHash: sha256View,
});
export type SuiteVersionRef = z.infer<typeof SuiteVersionRefSchema>;

/** Task keys that changed in one reload, against the previously current version. */
export const SuiteChangeSetSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.string()),
  nowInvalid: z.array(z.string()),
  nowValid: z.array(z.string()),
});
export type SuiteChangeSet = z.infer<typeof SuiteChangeSetSchema>;

/** Parse error that stopped a suite from reloading (the last good version is kept). */
export const SuiteLoadErrorViewSchema = z.object({
  file: z.string(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  message: z.string(),
  /** Lines around the error, each with its number; `highlight` marks the failing line. */
  excerpt: z.array(
    z.object({ line: z.number().int().nullable(), text: z.string(), highlight: z.boolean() }),
  ),
});
export type SuiteLoadErrorView = z.infer<typeof SuiteLoadErrorViewSchema>;

export const SuiteLastLoadSchema = z.object({
  outcome: loadOutcome,
  at: isoTimeView,
  changes: SuiteChangeSetSchema,
  /** Set when outcome is `error`: the version still served is `servedVersion`. */
  error: SuiteLoadErrorViewSchema.nullable(),
  servedVersion: z
    .object({
      versionNumber: z.number().int().positive(),
      contentHash: sha256View,
      loadedAt: isoTimeView,
    })
    .nullable(),
});
export type SuiteLastLoad = z.infer<typeof SuiteLastLoadSchema>;

/** One row of the Suite list. */
export const SuiteListRowSchema = SuiteVersionRefSchema.extend({
  /** Directory on disk, as shown: `./suites/invoices-v1`. */
  path: z.string(),
  description: z.string(),
  taskCount: countView,
  validCount: countView,
  /** Scorer types used by the tasks, most used first. */
  verificationTypes: z.array(scorerType),
  loadedAt: isoTimeView,
  lastLoad: SuiteLastLoadSchema,
});
export type SuiteListRow = z.infer<typeof SuiteListRowSchema>;

/** Self-check output of an invalid task, shown when its row expands. */
export const SelfCheckFailureViewSchema = z.object({
  key: z.string(),
  type: scorerType,
  /** Headline, e.g. "verifier_script check_late_fees.py printed no result line …". */
  title: z.string(),
  status: z.enum(SCORE_STATUSES),
  ranAt: isoTimeView,
  durationMs: countView,
  previousRun: z
    .object({ at: isoTimeView, status: z.enum(['passed', 'failed', 'error']) })
    .nullable(),
  /** Command and output exactly as the self-check captured them. */
  transcript: z.string(),
  /** Plain-English explanation of the likely cause and the fix. */
  explanation: z.string(),
});
export type SelfCheckFailureView = z.infer<typeof SelfCheckFailureViewSchema>;

/** One task row of Suite detail. */
export const SuiteTaskRowSchema = z.object({
  key: z.string(),
  /** Task version, which goes up only when this task's own files change. */
  version: z.number().int().positive(),
  summary: z.string(),
  verificationTypes: z.array(scorerType),
  /**
   * From task.yaml `limits`. Null only for an invalid task whose task.yaml
   * states no usable value; the UI shows "—". A valid task always has both.
   */
  maxTurns: z.number().int().positive().nullable(),
  /** As maxTurns: null only for an invalid task without a usable value. */
  budgetS: z.number().int().positive().nullable(),
  fixtureCount: countView,
  valid: z.boolean(),
  /** Present when the task failed its self-check. */
  selfCheckFailure: SelfCheckFailureViewSchema.nullable(),
});
export type SuiteTaskRow = z.infer<typeof SuiteTaskRowSchema>;

export const SuiteVersionOptionSchema = z.object({
  suiteId: z.string(),
  versionNumber: z.number().int().positive(),
  versionLabel: z.string().nullable(),
  contentHash: sha256View,
  loadedAt: isoTimeView,
  current: z.boolean(),
  /** "v1 (reverted)" when the directory pointed back at earlier files. */
  reverted: z.boolean(),
});
export type SuiteVersionOption = z.infer<typeof SuiteVersionOptionSchema>;

export const SuiteDetailSchema = SuiteListRowSchema.extend({
  /** Content hash of the version this one replaced ("was 3f9c2a1"), if any. */
  previousContentHash: sha256View.nullable(),
  tasks: z.array(SuiteTaskRowSchema),
  /** Every version of this directory, current first, for the version selector. */
  versions: z.array(SuiteVersionOptionSchema),
  /** True when this is the current version of the directory. */
  current: z.boolean(),
});
export type SuiteDetail = z.infer<typeof SuiteDetailSchema>;

/** One entry of a suite's History panel. */
export const SuiteHistoryEntrySchema = z.object({
  suiteId: z.string(),
  versionNumber: z.number().int().positive(),
  versionLabel: z.string().nullable(),
  contentHash: sha256View,
  loadedAt: isoTimeView,
  outcome: loadOutcome,
  changes: SuiteChangeSetSchema,
  /** Set when the same files were re-checked by a newer loader or scorer ("same files as v3"). */
  sameFilesAs: z.number().int().positive().nullable(),
  current: z.boolean(),
  experiments: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type SuiteHistoryEntry = z.infer<typeof SuiteHistoryEntrySchema>;

/** The result of reloading one suite directory. */
export const SuiteReloadEntrySchema = z.object({
  /** Directory as shown, the same as SuiteListRow.path: `./suites/invoices-v1`. */
  sourcePath: z.string(),
  name: z.string(),
  outcome: loadOutcome,
  suiteId: z.string().nullable(),
  versionNumber: z.number().int().positive().nullable(),
  changes: SuiteChangeSetSchema,
  /** Result line, e.g. "1 task now invalid: late_fees" or "All self-checks passed". */
  message: z.string(),
  error: SuiteLoadErrorViewSchema.nullable(),
});
export type SuiteReloadEntry = z.infer<typeof SuiteReloadEntrySchema>;

/** Result of POST /suites/reload, one entry per suite directory. */
export const SuiteReloadResultSchema = z.object({
  at: isoTimeView,
  suites: z.array(SuiteReloadEntrySchema),
});
export type SuiteReloadResult = z.infer<typeof SuiteReloadResultSchema>;

/** First rows of a CSV (or other tabular) file. */
export const TablePreviewSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  totalRows: countView,
});
export type TablePreview = z.infer<typeof TablePreviewSchema>;

export const TaskFixtureFileSchema = z.object({
  path: z.string(),
  /** Human description, e.g. "CSV · 48 rows · 8 columns". */
  typeLabel: z.string(),
  sizeBytes: countView,
  sha256: sha256View,
  /** Inline preview when the file is small and tabular; otherwise fetch it. */
  preview: TablePreviewSchema.nullable(),
});
export type TaskFixtureFile = z.infer<typeof TaskFixtureFileSchema>;

/** The task-file kinds Task detail lists as home files (Phase 6 P1, P2). */
export const TASK_HOME_FILE_KINDS = ['home_seed', 'expected_home'] as const;
export type TaskHomeFileKind = (typeof TASK_HOME_FILE_KINDS)[number];

/**
 * A task file that seeds the agent's home (`home_seed`, copied into the trial
 * home before every run) or holds what a home check expects there after a run
 * (`expected_home`, overlaid on the seeds, never copied into a trial).
 */
export const TaskHomeFileSchema = z.object({
  kind: z.enum(TASK_HOME_FILE_KINDS),
  /**
   * As in the task folder: `home/memories/MEMORY.md`, or under the
   * self_check.expected_home folder, which may be nested:
   * `expected_home/memories/USER.md`, `known_good/home/memories/USER.md`.
   */
  path: z.string().min(1),
  /**
   * Where the file is in the home, `memories/USER.md`: a seed's target, or an
   * expected_home file's path inside its folder (the API strips the folder
   * as task.yaml names it, so a nested one is stripped whole).
   */
  homePath: z.string().min(1),
  sizeBytes: countView,
  sha256: sha256View,
  /** The file's text when it is valid UTF-8 of at most TASK_HOME_FILE_TEXT_LIMIT bytes, else null. */
  text: z.string().nullable(),
});
export type TaskHomeFile = z.infer<typeof TaskHomeFileSchema>;

/** Home files up to this size carry their text inside Task detail (memory files are far smaller). */
export const TASK_HOME_FILE_TEXT_LIMIT = 16 * 1024;

/** One verification entry, with the sentence VerificationSentence renders. */
export const VerificationEntryViewSchema = z.object({
  key: z.string(),
  type: scorerType,
  primary: z.boolean(),
  params: z.record(z.string(), JsonValueSchema),
  /** Raw YAML of this entry, verbatim. */
  yaml: z.string(),
  /** Readable sentence, e.g. "json_match on duplicates, unordered, pass at 1.0". */
  sentence: z.string(),
});
export type VerificationEntryView = z.infer<typeof VerificationEntryViewSchema>;

export const TaskSelfCheckResultViewSchema = z.object({
  key: z.string(),
  type: scorerType,
  /** `skipped` for entries that are schema-checked only (trajectory_match, llm_judge). */
  status: z.enum([...SCORE_STATUSES, 'skipped']),
  score: z.number().min(0).max(1).nullable(),
  note: z.string(),
});
export type TaskSelfCheckResultView = z.infer<typeof TaskSelfCheckResultViewSchema>;

export const TaskSelfCheckViewSchema = z.object({
  status: z.enum(['passed', 'failed', 'error', 'skipped']),
  ranAt: isoTimeView,
  trigger: z.string(),
  results: z.array(TaskSelfCheckResultViewSchema),
});
export type TaskSelfCheckView = z.infer<typeof TaskSelfCheckViewSchema>;

/** One experiment that included a task, with the task's pass rate per configuration. */
export const TaskExperimentUsageSchema = z.object({
  experimentId: z.string(),
  experimentName: z.string(),
  status: z.enum(EXPERIMENT_STATUSES),
  rows: z.array(
    z.object({
      configuration: z.string(),
      role: z.enum(['baseline', 'candidate']),
      passRate: z.number().min(0).max(1).nullable(),
      /** Runs of this task counted so far, and the total for this configuration. */
      scored: countView,
      total: countView,
    }),
  ),
});
export type TaskExperimentUsage = z.infer<typeof TaskExperimentUsageSchema>;

export const TaskDetailSchema = z.object({
  suite: SuiteVersionRefSchema,
  key: z.string(),
  version: z.number().int().positive(),
  /** Suite version in which this task version first appeared. */
  introducedInSuiteVersion: z.number().int().positive(),
  summary: z.string(),
  /** Path of task.yaml as shown: `./suites/invoices-v1/dup_invoices/task.yaml`. */
  path: z.string(),
  prompt: z.object({ file: z.string(), markdown: z.string(), characters: countView }),
  fixtures: z.array(TaskFixtureFileSchema),
  /** home_seed files in path order, then expected_home files in path order; [] for most tasks. */
  homeFiles: z.array(TaskHomeFileSchema),
  verification: z.array(VerificationEntryViewSchema),
  reference: z.object({ file: z.string(), value: JsonValueSchema }),
  /** Verifier script source when an entry is a verifier_script; null otherwise. */
  verifier: z.object({ path: z.string(), sha256: sha256View, source: z.string() }).nullable(),
  selfCheck: TaskSelfCheckViewSchema,
  limits: z.object({
    /**
     * Null only for an invalid task whose task.yaml states no usable value
     * (the UI shows "—"); a valid task always has both limits.
     */
    maxTurns: z.number().int().positive().nullable(),
    budgetS: z.number().int().positive().nullable(),
    toolsetsNeeded: z.array(z.string()),
  }),
  valid: z.boolean(),
  selfCheckFailure: SelfCheckFailureViewSchema.nullable(),
  experiments: z.array(TaskExperimentUsageSchema),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;

/** One version of a task, for its History list. */
export const TaskVersionEntrySchema = z.object({
  version: z.number().int().positive(),
  contentHash: sha256View,
  suiteId: z.string(),
  introducedInSuiteVersion: z.number().int().positive(),
  loadedAt: isoTimeView,
  /** Files that changed against the previous task version. */
  changedFiles: z.array(z.string()),
  current: z.boolean(),
});
export type TaskVersionEntry = z.infer<typeof TaskVersionEntrySchema>;

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

const fileVersion = z.object({ sizeBytes: countView, sha256: sha256View }).nullable();

export const TaskFileChangeSchema = z.object({
  path: z.string(),
  change: z.enum(['added', 'removed', 'changed', 'unchanged']),
  before: fileVersion,
  after: fileVersion,
});
export type TaskFileChange = z.infer<typeof TaskFileChangeSchema>;

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
});
export type TaskDiff = z.infer<typeof TaskDiffSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Body of POST /suites/reload. */
export const SuiteReloadRequestSchema = z.strictObject({
  /**
   * One suite directory to reload, as SuiteListRow.path and
   * SuiteReloadEntry.sourcePath show it (`./suites/invoices-v1`; the bare
   * directory name is accepted too); every directory under SUITES_DIR when
   * absent. Matched against the directories on disk, never opened as given.
   */
  path: z.string().min(1).optional(),
});
export type SuiteReloadRequest = z.infer<typeof SuiteReloadRequestSchema>;
