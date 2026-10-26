/**
 * View models for suites and tasks (Suites section, plan sections 4 and 4.5).
 * The contracts live in @hermes-evals/shared as zod schemas, so the API and
 * the web share one definition; this file re-exports their types.
 *
 * Conventions for every file in src/api/types:
 * - camelCase fields; ids are opaque strings; timestamps are ISO-8601 strings;
 *   sha256 values are full 64-character lowercase hex (pages shorten them).
 * - Durations carry their unit in the name (`durationS`, `durationMs`).
 * - Status strings are the shared vocabularies from @hermes-evals/shared.
 */
export type {
  FileNotRecordedReason,
  JsonDiffEntry,
  SelfCheckFailureView,
  SuiteChangeSet,
  SuiteDetail,
  SuiteHistoryEntry,
  SuiteLastLoad,
  SuiteListRow,
  SuiteLoadErrorView,
  SuiteReloadEntry,
  SuiteReloadProgress,
  SuiteReloadProgressEntry,
  SuiteReloadResult,
  SuiteReloadState,
  SuiteTaskRow,
  SuiteVersionOption,
  SuiteVersionRef,
  TablePreview,
  TaskDetail,
  TaskDiff,
  TaskExperimentUsage,
  TaskFileChange,
  TaskFileVersion,
  TaskHomeFile,
  TaskHomeFileKind,
  TaskFixtureFile,
  TaskSelfCheckResultView,
  TaskSelfCheckView,
  TaskTextFileDiff,
  TaskVersionEntry,
  TextDiffLine,
  VerificationEntryView,
} from '@hermes-evals/shared';
