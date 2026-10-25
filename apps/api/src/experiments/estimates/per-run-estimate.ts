/**
 * The estimate maths of New experiment (plan 7.2, UI_FLOWS 11.1). Pure, so
 * the rules the summary panel shows are tested without a database.
 *
 * A per-run estimate is one configuration version on one suite directory:
 * the medians of its past executed attempts there, matched by config_hash so
 * a renamed configuration with the same settings still counts. With no
 * history it falls back to a quarter of the run's time budget and 15,000
 * tokens, and says so (`basis: 'budget'`). Cost is always the current price
 * table applied to those tokens; a model the table does not price has no
 * cost (null), never zero.
 */
import type {
  ExperimentEstimate,
  ExperimentEstimateView,
  PerRunEstimate,
  PriceTable,
  Tokens,
} from '@hermes-evals/shared';
import { attemptCost } from '../../execution/pricing.js';

/** Without history a run is assumed to use this fraction of its time budget (plan 7.2). */
export const BUDGET_DIVISOR = 4;

/**
 * Tokens assumed per run without history (plan 7.2: 15,000). The split into
 * prompt and completion only matters for cost; 13,000 in and 2,000 out is the
 * proportion the design's sample estimate uses ($0.0126 per run).
 */
export const BUDGET_TOKENS: Tokens = {
  input: 13_000,
  output: 2_000,
  total: 15_000,
  cache_read: 0,
  cache_write: 0,
};

/** One past executed attempt, as the history query reads it. */
export interface PastAttempt {
  durationMs: number;
  /** Null when Hermes reported no usable counts; such an attempt still counts for duration. */
  tokens: Tokens | null;
}

/** Past attempts of one configuration hash on one suite directory. */
export interface AttemptHistory {
  /** The most recent attempts, which the medians are taken over. */
  attempts: readonly PastAttempt[];
  /** Every executed attempt found, which may exceed `attempts` (shown as "from 192 past runs"). */
  total: number;
}

export interface PerRunInput {
  model: string;
  /** The configuration version's time_budget_s. */
  timeBudgetS: number;
  history: AttemptHistory | null;
}

/** The middle value, or the mean of the two middle values; null for no values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Money as attempts.cost_usd stores it: 6 decimals, so sums do not drift. */
export const roundUsd = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

/** Seconds to a tenth: a fast mock run must not estimate as 0 s. */
const roundSeconds = (s: number): number => Math.round(s * 10) / 10;

/** The per-run estimate for one configuration version on one suite directory. */
export function perRunEstimate(input: PerRunInput, prices: PriceTable): PerRunEstimate {
  const past = input.history?.attempts ?? [];
  if (past.length === 0) {
    return {
      seconds: roundSeconds(input.timeBudgetS / BUDGET_DIVISOR),
      costUsd: attemptCost(prices, input.model, BUDGET_TOKENS),
      tokens: BUDGET_TOKENS.total,
      basis: 'budget',
      pastRuns: 0,
    };
  }
  // Attempts without usable counts still time the run; if none has counts, assume the budget's.
  const counted = past.flatMap((a) => (a.tokens === null ? [] : [a.tokens]));
  const sample = counted.length > 0 ? counted : [BUDGET_TOKENS];
  // Each attempt priced at today's table, then the median: an unpriced model prices none.
  const costs = sample.map((t) => attemptCost(prices, input.model, t));
  const priced = costs.filter((c): c is number => c !== null);
  return {
    seconds: roundSeconds(median(past.map((a) => a.durationMs))! / 1000),
    costUsd: priced.length === sample.length ? roundUsd(median(priced)!) : null,
    tokens: Math.round(median(sample.map((t) => t.total))!),
    basis: 'history',
    pastRuns: input.history?.total ?? past.length,
  };
}

/** One chosen configuration version and its per-run estimate on the suite. */
export interface ChosenEstimate {
  versionId: string;
  name: string;
  estimate: PerRunEstimate;
}

export interface MatrixShape {
  taskCount: number;
  repetitions: number;
  concurrency: number;
}

/**
 * The summary panel's figures for a run matrix: every configuration runs
 * `taskCount × repetitions` runs, `concurrency` at a time, so the experiment
 * takes ceil(runs / concurrency) waves of the average run. Cost is null as
 * soon as one chosen configuration is unpriced, because a partial sum would
 * read as the whole. The basis is `history` only when every configuration
 * has history, and pastRuns is the fewest of them: the weakest basis decides.
 */
export function experimentEstimate(
  shape: MatrixShape,
  chosen: readonly ChosenEstimate[],
): ExperimentEstimateView {
  const runsEach = shape.taskCount * shape.repetitions;
  const runs = runsEach * chosen.length;
  const waves = Math.ceil(runs / Math.max(1, shape.concurrency));
  const perRun =
    chosen.length === 0
      ? 0
      : chosen.reduce((sum, c) => sum + c.estimate.seconds, 0) / chosen.length;
  const perConfiguration = chosen.map((c) => ({
    versionId: c.versionId,
    name: c.name,
    runs: runsEach,
    costUsd: c.estimate.costUsd === null ? null : roundUsd(runsEach * c.estimate.costUsd),
  }));
  const unpriced = perConfiguration.some((p) => p.costUsd === null);
  return {
    runs,
    waves,
    perRunSeconds: roundSeconds(perRun),
    durationS: Math.round(waves * perRun),
    costUsd: unpriced
      ? null
      : roundUsd(perConfiguration.reduce((sum, p) => sum + (p.costUsd ?? 0), 0)),
    perConfiguration,
    basis: chosen.every((c) => c.estimate.basis === 'history') ? 'history' : 'budget',
    pastRuns: chosen.length === 0 ? 0 : Math.min(...chosen.map((c) => c.estimate.pastRuns)),
  };
}

/** What the experiment row keeps of the estimate shown at launch (experiments.estimate). */
export const estimateSnapshot = (view: ExperimentEstimateView): ExperimentEstimate => ({
  runs: view.runs,
  duration_s: view.durationS,
  cost_usd: view.costUsd,
  basis: view.basis,
});
