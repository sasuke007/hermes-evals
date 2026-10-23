/**
 * View models for suites and tasks (Suites section, plan sections 4 and 4.5).
 *
 * Conventions for every file in src/api/types:
 * - camelCase fields; ids are opaque strings; timestamps are ISO-8601 strings;
 *   sha256 values are full 64-character lowercase hex (pages shorten them).
 * - Durations carry their unit in the name (`durationS`, `durationMs`).
 * - Status strings are the shared vocabularies from @hermes-evals/shared.
 */
import type { JsonValue, ScoreStatus, ScorerType, SuiteLoadOutcome } from '@hermes-evals/shared';

/** A suite version as other records refer to it (experiment snapshot, run header). */
export interface SuiteVersionRef {
  /** Id of the immutable suite version row. */
  suiteId: string;
  /** suite.yaml name, also the directory name: `invoices-v1`. */
  name: string;
  /** v1, v2, … assigned by the loader per directory. */
  versionNumber: number;
  /** The author's `version_label` from suite.yaml, shown muted. */
  versionLabel: string | null;
  /** sha256 of suite.yaml and every task file. Pages show the first 7 characters. */
  contentHash: string;
}

/** Task keys that changed in one reload, against the previously current version. */
export interface SuiteChangeSet {
  added: string[];
  removed: string[];
  changed: string[];
  nowInvalid: string[];
  nowValid: string[];
}

/** Parse error that stopped a suite from reloading (the last good version is kept). */
export interface SuiteLoadErrorView {
  file: string;
  line: number | null;
  column: number | null;
  message: string;
  /** Lines around the error, each with its number; `highlight` marks the failing line. */
  excerpt: { line: number | null; text: string; highlight: boolean }[];
}

export interface SuiteLastLoad {
  outcome: SuiteLoadOutcome;
  at: string;
  changes: SuiteChangeSet;
  /** Set when outcome is `error`: the version still served is `servedVersion`. */
  error: SuiteLoadErrorView | null;
  servedVersion: { versionNumber: number; contentHash: string; loadedAt: string } | null;
}

/** One row of the Suite list. */
export interface SuiteListRow extends SuiteVersionRef {
  /** Directory on disk, as shown: `./suites/invoices-v1`. */
  path: string;
  description: string;
  taskCount: number;
  validCount: number;
  /** Scorer types used by the tasks, most used first. */
  verificationTypes: ScorerType[];
  loadedAt: string;
  lastLoad: SuiteLastLoad;
}

/** Self-check output of an invalid task, shown when its row expands. */
export interface SelfCheckFailureView {
  key: string;
  type: ScorerType;
  /** Headline, e.g. "verifier_script check_late_fees.py printed no result line …". */
  title: string;
  status: ScoreStatus;
  ranAt: string;
  durationMs: number;
  previousRun: { at: string; status: 'passed' | 'failed' | 'error' } | null;
  /** Command and output exactly as the self-check captured them. */
  transcript: string;
  /** Plain-English explanation of the likely cause and the fix. */
  explanation: string;
}

/** One task row of Suite detail. */
export interface SuiteTaskRow {
  key: string;
  /** Task version, which goes up only when this task's own files change. */
  version: number;
  summary: string;
  verificationTypes: ScorerType[];
  maxTurns: number;
  budgetS: number;
  fixtureCount: number;
  valid: boolean;
  /** Present when the task failed its self-check. */
  selfCheckFailure: SelfCheckFailureView | null;
}

export interface SuiteVersionOption {
  suiteId: string;
  versionNumber: number;
  versionLabel: string | null;
  contentHash: string;
  loadedAt: string;
  current: boolean;
  /** "v1 (reverted)" when the directory pointed back at earlier files. */
  reverted: boolean;
}

export interface SuiteDetail extends SuiteListRow {
  /** Content hash of the version this one replaced ("was 3f9c2a1"), if any. */
  previousContentHash: string | null;
  tasks: SuiteTaskRow[];
  /** Every version of this directory, current first, for the version selector. */
  versions: SuiteVersionOption[];
  /** True when this is the current version of the directory. */
  current: boolean;
}

/** One entry of a suite's History panel. */
export interface SuiteHistoryEntry {
  suiteId: string;
  versionNumber: number;
  versionLabel: string | null;
  contentHash: string;
  loadedAt: string;
  outcome: SuiteLoadOutcome;
  changes: SuiteChangeSet;
  /** Set when the same files were re-checked by a newer loader or scorer ("same files as v3"). */
  sameFilesAs: number | null;
  current: boolean;
  experiments: { id: string; name: string }[];
}

/** Result of POST /suites/reload, one entry per suite directory. */
export interface SuiteReloadResult {
  at: string;
  suites: {
    sourcePath: string;
    name: string;
    outcome: SuiteLoadOutcome;
    suiteId: string | null;
    versionNumber: number | null;
    changes: SuiteChangeSet;
    /** Result line, e.g. "1 task now invalid: late_fees" or "All self-checks passed". */
    message: string;
    error: SuiteLoadErrorView | null;
  }[];
}

/** First rows of a CSV (or other tabular) file. */
export interface TablePreview {
  columns: string[];
  rows: string[][];
  totalRows: number;
}

export interface TaskFixtureFile {
  path: string;
  /** Human description, e.g. "CSV · 48 rows · 8 columns". */
  typeLabel: string;
  sizeBytes: number;
  sha256: string;
  /** Inline preview when the file is small and tabular; otherwise fetch it. */
  preview: TablePreview | null;
}

/** One verification entry, with the sentence VerificationSentence renders. */
export interface VerificationEntryView {
  key: string;
  type: ScorerType;
  primary: boolean;
  params: Record<string, JsonValue>;
  /** Raw YAML of this entry, verbatim. */
  yaml: string;
  /** Readable sentence, e.g. "json_match on duplicates, unordered, pass at 1.0". */
  sentence: string;
}

export interface TaskSelfCheckResultView {
  key: string;
  type: ScorerType;
  /** `skipped` for entries that are schema-checked only (trajectory_match, llm_judge). */
  status: ScoreStatus | 'skipped';
  score: number | null;
  note: string;
}

export interface TaskSelfCheckView {
  status: 'passed' | 'failed' | 'error' | 'skipped';
  ranAt: string;
  trigger: string;
  results: TaskSelfCheckResultView[];
}

/** One experiment that included a task, with the task's pass rate per configuration. */
export interface TaskExperimentUsage {
  experimentId: string;
  experimentName: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  rows: {
    configuration: string;
    role: 'baseline' | 'candidate';
    passRate: number | null;
    /** Runs of this task counted so far, and the total for this configuration. */
    scored: number;
    total: number;
  }[];
}

export interface TaskDetail {
  suite: SuiteVersionRef;
  key: string;
  version: number;
  /** Suite version in which this task version first appeared. */
  introducedInSuiteVersion: number;
  summary: string;
  /** Path of task.yaml as shown: `./suites/invoices-v1/dup_invoices/task.yaml`. */
  path: string;
  prompt: { file: string; markdown: string; characters: number };
  fixtures: TaskFixtureFile[];
  verification: VerificationEntryView[];
  reference: { file: string; value: JsonValue };
  /** Verifier script source when an entry is a verifier_script; null otherwise. */
  verifier: { path: string; sha256: string; source: string } | null;
  selfCheck: TaskSelfCheckView;
  limits: { maxTurns: number; budgetS: number; toolsetsNeeded: string[] };
  valid: boolean;
  selfCheckFailure: SelfCheckFailureView | null;
  experiments: TaskExperimentUsage[];
}

/** One version of a task, for its History list. */
export interface TaskVersionEntry {
  version: number;
  contentHash: string;
  suiteId: string;
  introducedInSuiteVersion: number;
  loadedAt: string;
  /** Files that changed against the previous task version. */
  changedFiles: string[];
  current: boolean;
}

export interface TextDiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface JsonDiffEntry {
  /** JSON path, e.g. `total_due` or `duplicates[1][0]`. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before: JsonValue | null;
  after: JsonValue | null;
}

export interface TaskFileChange {
  path: string;
  change: 'added' | 'removed' | 'changed' | 'unchanged';
  before: { sizeBytes: number; sha256: string } | null;
  after: { sizeBytes: number; sha256: string } | null;
}

/** A task's changes between two suite versions. */
export interface TaskDiff {
  key: string;
  from: { suiteId: string; suiteVersion: number; taskVersion: number };
  to: { suiteId: string; suiteVersion: number; taskVersion: number };
  prompt: TextDiffLine[];
  taskYaml: TextDiffLine[];
  reference: JsonDiffEntry[];
  files: TaskFileChange[];
}
