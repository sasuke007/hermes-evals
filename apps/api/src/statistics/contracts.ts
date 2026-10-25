/**
 * The statistics module's contract (plan 10.1 and 10.2, UI_FLOWS 16): what
 * the comparison and the verdict history hand it, and what it answers. Pure
 * data and no database: experiments/comparison/inputs.ts builds a StatsInput
 * from Postgres, compute.ts turns it into a StatsResult, and the comparison
 * endpoint (GET /experiments/:id/comparison), reconcile's verdict entries
 * (plan 7.4 step 3) and the experiment views read the result.
 *
 * Counting rules (plan 10.1), applied by whoever builds the input:
 * - a run counts once its status is `scored` or `execution_error` (which
 *   counts as not passed); queued, running, executed, scoring and cancelled
 *   runs are left out of the input;
 * - a run passes when the selected key's status is `passed`; `failed`,
 *   `error` and `ungradable` count as not passed and are reported
 *   separately (the sensitivity figure, the secondary metrics).
 *
 * Every number in a StatsResult is unrounded: the views round for display.
 */
import {
  SCORE_KEY_ANY_FAILED,
  SCORE_KEY_PRIMARY,
  type ExecutionErrorCategory,
  type NotComputableReason,
  type ScoreStatus,
  type TaskChange,
  type Verdict,
  type VerdictState,
} from '@hermes-evals/shared';

// ---------------------------------------------------------------------------
// The selected key
// ---------------------------------------------------------------------------

/**
 * Which score of a run grades it (ComparisonQuery.key, VerdictEntry.key).
 *
 * - `primary`: each task's own primary key. The default, and what verdict
 *   entries are computed on.
 * - `named`: one key that every selected task declares, e.g. `answer`; a
 *   key missing from any task is refused (400).
 * - `any_failed`: the run passes only when none of its keys failed, errored
 *   or was ungradable. Its status, as the grid shows it, is `failed` when
 *   any key failed, else `error` when any errored, else `ungradable` when
 *   any was ungradable, else `passed` (the web fixtures' rule).
 */
export type KeySelection =
  { kind: 'primary' } | { kind: 'named'; key: string } | { kind: 'any_failed' };

/** The selection a query value names: `primary`, `any_failed`, or a key name. */
export function keySelectionOf(value: string): KeySelection {
  if (value === SCORE_KEY_PRIMARY) return { kind: 'primary' };
  if (value === SCORE_KEY_ANY_FAILED) return { kind: 'any_failed' };
  return { kind: 'named', key: value };
}

/** The value a selection is shown and stored as: ComparisonView.scoreKey, VerdictEntry.key. */
export function keySelectionValue(selection: KeySelection): string {
  if (selection.kind === 'primary') return SCORE_KEY_PRIMARY;
  if (selection.kind === 'any_failed') return SCORE_KEY_ANY_FAILED;
  return selection.key;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** One counted run of one task under one configuration. */
export interface StatsRun {
  /** The selected key's status is `passed`. Always false for an execution error. */
  passed: boolean;
  /**
   * The selected key's status (see KeySelection for `any_failed`); null for
   * an execution error, which has no score.
   */
  keyStatus: ScoreStatus | null;
  /** Why the run's current attempt ended in execution_error; null for a scored run. */
  executionError: ExecutionErrorCategory | null;
  /** How long the current attempt ran, in seconds; null when nothing recorded it. */
  durationS: number | null;
  /** The current attempt's total tokens; null when they were not metered. */
  tokens: number | null;
  /** What the run's attempts cost, priced attempts only; null when none of them is priced. */
  costUsd: number | null;
}

/** One selected task: its counted runs under the baseline and under the candidate. */
export interface StatsTask {
  taskKey: string;
  /** Counted runs only, in any order; empty when none counts yet. */
  baseline: readonly StatsRun[];
  candidate: readonly StatsRun[];
}

export interface StatsInput {
  /**
   * Every selected task of the experiment, in experiment order, including
   * tasks with no counted run yet: the gate needs to see them.
   */
  tasks: readonly StatsTask[];
  /** The experiment's repetitions. 1 gives not_computable · single_repetition, whatever has run. */
  repetitions: number;
  /** True while the experiment is running or paused: a computed verdict is `provisional`. */
  provisional: boolean;
  /** Configuration names, for the not-computable sentence ("Pass rates: baseline 0.58, …"). */
  labels: { baseline: string; candidate: string };
  /**
   * Scored and total runs of the two configurations (cancelled included),
   * for the nothing_scored sentence "0 of 120 runs scored". Not the whole
   * experiment's: another candidate's runs say nothing about this pair.
   */
  progress: { scored: number; total: number };
}

/** The resample count the design shows: "paired bootstrap, 10,000 resamples". */
export const DEFAULT_RESAMPLES = 10_000;
/** A 95% interval: the 2.5th and 97.5th percentiles. */
export const DEFAULT_CONFIDENCE = 0.95;

export interface StatsOptions {
  /** The PRNG seed, an unsigned 32-bit integer: seedFromExperimentId(experimentId). */
  seed: number;
  /** Bootstrap resamples; DEFAULT_RESAMPLES when omitted. */
  resamples?: number;
  /** Two-sided confidence of the interval; DEFAULT_CONFIDENCE when omitted. */
  confidence?: number;
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Passed over counted runs. */
export interface PassTally {
  passed: number;
  counted: number;
  /** passed / counted; null when nothing counted. */
  rate: number | null;
}

/** One task of the grid: its rates on each side and the change between them. */
export interface TaskStats {
  taskKey: string;
  baseline: PassTally;
  candidate: PassTally;
  /** Candidate rate minus baseline rate; null unless both sides have counted runs. */
  delta: number | null;
  /** `improved` when delta > 0, `regressed` when < 0, `unchanged` when 0; null with delta. */
  change: TaskChange | null;
}

/** Runs the sensitivity figure leaves out of one side. */
export interface ExcludedRuns {
  executionErrors: number;
  /** Scored runs whose selected key is `ungradable`. */
  ungradable: number;
  /** Scored runs whose selected key is `error`. */
  error: number;
}

/**
 * The same difference and interval without the runs that broke rather than
 * answered (plan 10.2): execution errors, and runs whose selected key is
 * `error` or `ungradable`.
 */
export interface SensitivityResult {
  excludedBaseline: ExcludedRuns;
  excludedCandidate: ExcludedRuns;
  /** Pooled over the kept runs of each side. */
  baseline: PassTally;
  candidate: PassTally;
  /** Mean over tasks of the kept runs' per-task differences; null when no task has kept runs on both sides. */
  delta: number | null;
  /** The bootstrap interval over the kept runs; null when they fail the 2-runs gate. */
  lo: number | null;
  hi: number | null;
  /** better, worse or inconclusive; `provisional` while running; `not_computable` when the kept runs fail the gate. */
  verdict: VerdictState;
  /** True when `verdict` differs from the main verdict. */
  verdictChanges: boolean;
}

/** The secondary metrics of one configuration, over its counted runs. */
export interface SecondaryMetrics {
  medianDurationS: number | null;
  meanTokens: number | null;
  /** Summed over the runs whose cost is known; null when none is priced. */
  costUsd: number | null;
  executionErrors: number;
  /** The categories seen, in EXECUTION_ERROR_CATEGORIES order. */
  executionErrorCategories: ExecutionErrorCategory[];
  ungradable: number;
}

/** Candidate minus baseline, for the "Difference" row; any value may be negative. */
export interface SecondaryDifference {
  medianDurationS: number | null;
  /** (candidate − baseline) / baseline mean tokens × 100; null when either is unknown or the baseline's is 0. */
  meanTokensPct: number | null;
  costUsd: number | null;
  executionErrors: number;
  ungradable: number;
}

/** What every result carries, computable or not. */
export interface StatsBase {
  /** Pooled over every counted run of each side (ComparisonView.passRates, passCounts). */
  baseline: PassTally;
  candidate: PassTally;
  /** One per input task, in input order. */
  tasks: TaskStats[];
  taskCounts: { improved: number; regressed: number; unchanged: number };
  /** Mean over the tasks with counted runs on both sides of (candidate rate − baseline rate); null when none. */
  observedDelta: number | null;
  /** Null when nothing was excluded (no execution error, no error or ungradable key). */
  sensitivity: SensitivityResult | null;
  secondary: {
    baseline: SecondaryMetrics;
    candidate: SecondaryMetrics;
    difference: SecondaryDifference;
  };
}

/** Every task has at least 2 counted runs per configuration: the interval and the verdict. */
export interface ComputedStats extends StatsBase {
  computable: true;
  observedDelta: number;
  lo: number;
  hi: number;
  resamples: number;
  confidence: number;
  /** better if lo > 0, worse if hi < 0, else inconclusive; `provisional` while running or paused. */
  verdict: Verdict | 'provisional';
  provisional: boolean;
}

/** The gate failed: why, and the sentence the panel shows instead (StatisticsUnavailable). */
export interface NotComputableStats extends StatsBase {
  computable: false;
  reason: NotComputableReason;
  message: string;
}

export type StatsResult = ComputedStats | NotComputableStats;
