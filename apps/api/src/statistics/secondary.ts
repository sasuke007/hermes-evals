/**
 * The secondary metrics (plan 10.2, the Comparison tab's table under the
 * statistics): per configuration over its counted runs, and the candidate's
 * difference from the baseline. Durations and tokens describe the runs'
 * current attempts; the median is the middle value, or the mean of the two
 * middle values, as the Overview's aggregates take it.
 */
import { EXECUTION_ERROR_CATEGORIES } from '@hermes-evals/shared';
import { mean, median } from '../experiments/views/numbers.js';
import type { SecondaryDifference, SecondaryMetrics, StatsRun } from './contracts.js';

const known = (values: readonly (number | null)[]): number[] =>
  values.filter((v): v is number => v !== null);

export function secondaryMetrics(runs: readonly StatsRun[]): SecondaryMetrics {
  const costs = known(runs.map((r) => r.costUsd));
  const categories = new Set(runs.flatMap((r) => (r.executionError ? [r.executionError] : [])));
  return {
    medianDurationS: median(known(runs.map((r) => r.durationS))),
    meanTokens: mean(known(runs.map((r) => r.tokens))),
    costUsd: costs.length === 0 ? null : costs.reduce((sum, c) => sum + c, 0),
    executionErrors: runs.filter((r) => r.executionError !== null).length,
    executionErrorCategories: EXECUTION_ERROR_CATEGORIES.filter((c) => categories.has(c)),
    ungradable: runs.filter((r) => r.keyStatus === 'ungradable').length,
  };
}

const minus = (candidate: number | null, baseline: number | null): number | null =>
  candidate === null || baseline === null ? null : candidate - baseline;

export function secondaryDifference(
  baseline: SecondaryMetrics,
  candidate: SecondaryMetrics,
): SecondaryDifference {
  const b = baseline.meanTokens;
  const c = candidate.meanTokens;
  return {
    medianDurationS: minus(candidate.medianDurationS, baseline.medianDurationS),
    meanTokensPct: b === null || c === null || b === 0 ? null : ((c - b) / b) * 100,
    costUsd: minus(candidate.costUsd, baseline.costUsd),
    executionErrors: candidate.executionErrors - baseline.executionErrors,
    ungradable: candidate.ungradable - baseline.ungradable,
  };
}
