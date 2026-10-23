/**
 * View models for experiments: list, detail (header, snapshot, overview),
 * comparison, New experiment options and estimates (plan sections 7 and 10).
 * See src/api/types/suites.ts for the conventions shared by every types file.
 */
import type {
  ExecutionErrorCategory,
  ExperimentStatus,
  PauseReason,
  Provider,
  RunStatus,
  ScoreStatus,
  Verdict,
  VerdictCause,
} from '@hermes-evals/shared';
import type { ConfigField, ConfigVersionRef } from './configurations';
import type { SuiteVersionRef } from './suites';

/** Plan section 7.3 adds `provider_disconnected` to the shared pause reasons. */
export type ExperimentPauseReason = PauseReason | 'provider_disconnected';

/**
 * A verdict as drawn: the three final verdicts, `provisional` while the
 * experiment runs, and `not_computable` (with 1 repetition, or too few runs).
 */
export type VerdictState = Verdict | 'provisional' | 'not_computable';

export type ConfigRole = 'baseline' | 'candidate';

/** A frozen configuration version as an experiment uses it. */
export interface ExperimentConfigRef extends ConfigVersionRef {
  role: ConfigRole;
  model: string;
  provider: Provider;
}

/** Run counts by status, every status present (0 when none). */
export type RunCounts = Record<RunStatus, number>;

/** The Hermes build an experiment was frozen on: "hermes-agent v0.22.4 @ 4d04303". */
export interface HermesRevision {
  package: string;
  version: string;
  revision: string;
}

/** Shown on an older experiment when its suite directory has a newer version. */
export interface NewerSuiteVersion {
  suiteId: string;
  versionNumber: number;
  changedTasks: string[];
  removedTasks: string[];
  invalidTasks: string[];
}

export interface ExperimentSuiteSnapshot extends SuiteVersionRef {
  path: string;
  taskCount: number;
  /** Tasks of the suite included in this experiment. */
  tasks: { key: string; version: number }[];
  newerVersion: NewerSuiteVersion | null;
}

/** One verdict computation, kept in the experiment's history. */
export interface VerdictHistoryEntry {
  at: string;
  cause: VerdictCause;
  /** e.g. "1 retry" for "Updated 23 Oct 14:20 after 1 retry". */
  note: string | null;
  delta: number | null;
  lo: number | null;
  hi: number | null;
  verdict: VerdictState;
}

/** The verdict of one candidate against the baseline. */
export interface VerdictSummary {
  baseline: ExperimentConfigRef;
  candidate: ExperimentConfigRef;
  verdict: VerdictState;
  /** Score key the verdict is computed on: `primary` (each task's primary key) or a key name. */
  scoreKey: string;
  delta: number | null;
  lo: number | null;
  hi: number | null;
  passRates: { baseline: number | null; candidate: number | null };
  passCounts: {
    baseline: { passed: number; counted: number };
    candidate: { passed: number; counted: number };
  };
  taskCounts: { improved: number; regressed: number; unchanged: number };
  method: { name: 'paired_bootstrap'; resamples: number; confidence: number };
  /** Set when verdict is `not_computable`, e.g. `single_repetition`. */
  reason: string | null;
  /** Oldest first; more than one entry means the verdict was recomputed. */
  history: VerdictHistoryEntry[];
}

/** One field that differs between the baseline and a candidate. */
export interface ConfigDifference {
  field: ConfigField;
  candidate: string;
  baselineValue: string;
  candidateValue: string;
  /** Content hash behind the candidate value, e.g. the skill's sha256. */
  hash: string | null;
}

/** Progress of one configuration while the experiment runs. */
export interface ConfigProgress {
  configuration: ExperimentConfigRef;
  total: number;
  counts: RunCounts;
  passed: number;
  /** passed / counted so far, where counted = scored + execution_error. */
  provisionalPassRate: number | null;
}

/** One row of "Latest completions" (newest first, at most 10). */
export interface FeedEntry {
  runId: string;
  finishedAt: string;
  taskKey: string;
  configuration: string;
  repetition: number;
  /** The primary score status, or `execution_error` when the run broke. */
  result: ScoreStatus | 'execution_error';
  durationS: number;
}

/** Per-configuration aggregates on the completed Overview. */
export interface ConfigAggregate {
  configuration: ExperimentConfigRef;
  runs: number;
  passRate: number | null;
  meanScore: number | null;
  medianDurationS: number | null;
  meanTokens: number | null;
  costUsd: number | null;
  executionErrors: number;
  executionErrorCategories: ExecutionErrorCategory[];
  ungradable: number;
}

/** Why the circuit breaker stopped the experiment. */
export interface ExperimentFailureView {
  at: string;
  threshold: number;
  category: ExecutionErrorCategory;
  /** Headline cause, e.g. "invoice-db failed to start". */
  message: string;
  stderrFirstLine: string | null;
  /** Runs whose first stderr line was identical. */
  identicalIn: number;
  /** Where to fix it, when the platform can tell. */
  fix: { label: string; to: string } | null;
  runId: string;
}

export interface WorkerPresence {
  connected: boolean;
  lastHeartbeatAt: string | null;
  /** Runs that were in flight when the worker stopped and were marked execution_error · worker_lost. */
  workerLostRuns: number;
}

/** Spend against the ceiling. */
export interface ExperimentSpend {
  spentUsd: number;
  ceilingUsd: number | null;
  projectedTotalUsd: number | null;
  /** Estimated cost of the runs still waiting (paused-by-ceiling state). */
  remainingEstimateUsd: number | null;
  /** Attempts whose model has no price; counted, never treated as zero. */
  unpricedAttempts: number;
}

/** Everything the experiment detail page and its Overview tab show. */
export interface ExperimentDetail {
  id: string;
  name: string;
  description: string;
  status: ExperimentStatus;
  pauseReason: ExperimentPauseReason | null;
  pausedAt: string | null;
  createdAt: string;
  finishedAt: string | null;
  elapsedS: number;
  remainingEstimateS: number | null;
  /** When the last live event arrived ("Live · updated 15:23:42"). */
  lastEventAt: string | null;
  suite: ExperimentSuiteSnapshot;
  baseline: ExperimentConfigRef;
  candidates: ExperimentConfigRef[];
  differences: ConfigDifference[];
  hermes: HermesRevision;
  /** `primary` = each task's primary key. */
  scoreKey: string;
  repetitions: number;
  concurrency: number;
  timeBudgetOverrideS: number | null;
  totalRuns: number;
  counts: RunCounts;
  spend: ExperimentSpend;
  perConfiguration: ConfigProgress[];
  feed: FeedEntry[];
  /** One per candidate. Provisional while running; final once completed. */
  verdicts: VerdictSummary[];
  aggregates: ConfigAggregate[];
  failure: ExperimentFailureView | null;
  worker: WorkerPresence;
}

/** A verdict chip on the experiment list. */
export interface ExperimentListVerdict {
  candidate: string;
  candidateVersionId: string;
  verdict: VerdictState;
  delta: number | null;
  lo: number | null;
  hi: number | null;
}

/** One row of the Experiment list. */
export interface ExperimentListRow {
  id: string;
  name: string;
  status: ExperimentStatus;
  pauseReason: ExperimentPauseReason | null;
  /** Status chip tooltip, e.g. "invoice-db failed to start (setup) in 14 of 14 runs". */
  statusReason: string | null;
  suite: SuiteVersionRef;
  baseline: ExperimentConfigRef;
  candidates: ExperimentConfigRef[];
  repetitions: number;
  totalRuns: number;
  /**
   * Runs the progress bar counts: scored runs, plus the execution errors of an
   * experiment the circuit breaker stopped.
   */
  doneRuns: number;
  counts: RunCounts;
  /** Final verdicts once completed; empty while running ("Provisional"). */
  verdicts: ExperimentListVerdict[];
  createdAt: string;
  costUsd: number | null;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type ComparisonFilter = 'all' | 'improved' | 'regressed' | 'unchanged';

/** `primary`, `any_failed`, or a key every selected task has (e.g. `answer`). */
export type ScoreKeySelection = string;

export type TaskChange = 'improved' | 'regressed' | 'unchanged';

/** One repetition of one task under one configuration: a 16px button in the grid. */
export interface RepetitionCell {
  runId: string;
  repetition: number;
  runStatus: RunStatus;
  /** Status of the selected key; null until scored and for execution_error or cancelled runs. */
  scoreStatus: ScoreStatus | null;
  attempt: number;
  durationS: number | null;
  /** Primary score comment, or the execution error line, for the tooltip. */
  comment: string | null;
}

export interface ComparisonRow {
  taskKey: string;
  taskVersion: number;
  baseline: RepetitionCell[];
  candidate: RepetitionCell[];
  passBaseline: number | null;
  passCandidate: number | null;
  /** Null with one repetition (no Δ column) or before both sides have counted runs. */
  delta: number | null;
  change: TaskChange | null;
}

export interface ComparisonStatistics {
  observedDelta: number;
  lo: number;
  hi: number;
  resamples: number;
  confidence: number;
  verdict: VerdictState;
  provisional: boolean;
}

export interface SecondaryMetricsRow {
  configuration: ExperimentConfigRef;
  medianDurationS: number | null;
  meanTokens: number | null;
  costUsd: number | null;
  executionErrors: number;
  executionErrorCategories: ExecutionErrorCategory[];
  ungradable: number;
}

/** Candidate minus baseline, for the "Difference" row. */
export interface SecondaryMetricsDifference {
  medianDurationS: number | null;
  meanTokensPct: number | null;
  costUsd: number | null;
  executionErrors: number;
  ungradable: number;
}

/** The same difference computed without runs that broke rather than answered. */
export interface SensitivityView {
  excludedBaseline: { executionErrors: number; ungradable: number; error: number };
  excludedCandidate: { executionErrors: number; ungradable: number; error: number };
  baseline: { passed: number; counted: number; rate: number | null };
  candidate: { passed: number; counted: number; rate: number | null };
  delta: number | null;
  verdictChanges: boolean;
}

export interface ComparisonCandidateOption {
  configuration: ExperimentConfigRef;
  verdict: VerdictState;
}

export interface ScoreKeyOption {
  value: ScoreKeySelection;
  label: string;
}

/** GET /experiments/:id/comparison: always one candidate against the baseline. */
export interface ComparisonView {
  experimentId: string;
  experimentStatus: ExperimentStatus;
  /** True while running: unscored cells show queued or running, the panel reads "Provisional". */
  provisional: boolean;
  repetitions: number;
  baseline: ExperimentConfigRef;
  candidate: ExperimentConfigRef;
  candidates: ComparisonCandidateOption[];
  scoreKey: ScoreKeySelection;
  scoreKeyOptions: ScoreKeyOption[];
  filter: ComparisonFilter;
  filterCounts: Record<ComparisonFilter, number>;
  /** Rows after the filter, sorted by Δ descending, then baseline pass rate, then task. */
  rows: ComparisonRow[];
  passRates: { baseline: number | null; candidate: number | null };
  passCounts: {
    baseline: { passed: number; counted: number };
    candidate: { passed: number; counted: number };
  };
  statistics: ComparisonStatistics | null;
  /** Why there is no statistics panel. */
  statisticsUnavailable: {
    reason: 'single_repetition' | 'not_enough_runs' | 'nothing_scored';
    message: string;
  } | null;
  secondary: SecondaryMetricsRow[];
  secondaryDifference: SecondaryMetricsDifference | null;
  sensitivity: SensitivityView | null;
  progress: { scored: number; total: number };
}

export interface ComparisonQuery {
  /** Candidate configuration version id; defaults to the first candidate. */
  candidate?: string;
  key?: ScoreKeySelection;
  filter?: ComparisonFilter;
}

// ---------------------------------------------------------------------------
// New experiment
// ---------------------------------------------------------------------------

export interface NewExperimentTaskOption {
  key: string;
  version: number;
  summary: string;
  verificationCount: number;
  valid: boolean;
  /** Self-check reason shown in the tooltip and inline caption of an invalid task. */
  invalidReason: string | null;
}

export interface NewExperimentSuiteOption extends SuiteVersionRef {
  path: string;
  selfCheckAt: string;
  taskCount: number;
  validCount: number;
  /** Time budget the suite's tasks use, for the override field's help line. */
  budgetS: number;
  tasks: NewExperimentTaskOption[];
}

/** Per-run estimate for one configuration on a suite (medians of past runs, else budget ÷ 4). */
export interface PerRunEstimate {
  seconds: number;
  costUsd: number | null;
  tokens: number;
  basis: 'history' | 'budget';
  pastRuns: number;
}

export interface NewExperimentConfigOption extends ConfigVersionRef {
  configHash: string;
  model: string;
  provider: Provider;
  memoryEnabled: boolean;
  skills: string[];
  mcpServers: string[];
  /** Per-run estimate on each suite, keyed by suite version id. */
  estimates: Record<string, PerRunEstimate>;
}

export interface PriceEntry {
  model: string;
  inputPer1M: number;
  outputPer1M: number;
  checkedAt: string;
}

/** Everything New experiment needs before the user types anything. */
export interface NewExperimentOptions {
  suites: NewExperimentSuiteOption[];
  configurations: NewExperimentConfigOption[];
  defaults: { repetitions: number; concurrency: number };
  /** Runs executing at once is limited by the live workers' total. */
  maxConcurrency: number;
  workerCount: number;
  priceTable: PriceEntry[];
}

export interface LaunchExperimentInput {
  name: string;
  description: string;
  suiteId: string;
  taskKeys: string[];
  baselineVersionId: string;
  candidateVersionIds: string[];
  repetitions: number;
  concurrency: number;
  spendCeilingUsd: number | null;
  timeBudgetOverrideS: number | null;
  /** Version id to config hash, as the form showed them; a mismatch is a 409. */
  expectedConfigHashes: Record<string, string>;
}

export interface EstimateQuery {
  suiteId: string;
  versionIds: string[];
  taskCount: number;
  repetitions: number;
  concurrency: number;
}

export interface ExperimentEstimateView {
  runs: number;
  waves: number;
  perRunSeconds: number;
  durationS: number;
  costUsd: number | null;
  perConfiguration: { versionId: string; name: string; runs: number; costUsd: number | null }[];
  basis: 'history' | 'budget';
  pastRuns: number;
}

/** Duplicate: a prefilled New experiment form on the suite's current version. */
export interface NewExperimentDraft {
  sourceExperimentId: string;
  values: Omit<LaunchExperimentInput, 'expectedConfigHashes'>;
  /** What differs from the original because the suite moved on. */
  changes: {
    suiteVersionFrom: number;
    suiteVersionTo: number;
    changedTasks: string[];
    removedTasks: string[];
    invalidTasks: { key: string; reason: string }[];
  };
}

export interface ExperimentActionResult {
  id: string;
  status: ExperimentStatus;
}
