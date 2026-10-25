/**
 * The secondary metrics (plan 10.2, the Comparison tab's table under the
 * statistics): per configuration, and the candidate's difference from the
 * baseline. Durations, tokens, execution errors and ungradable runs are
 * over its counted runs, durations and tokens describing their current
 * attempts; the median is the middle value, or the mean of the two middle
 * values, as the Overview's aggregates take it. The cost is what the
 * caller priced, every attempt of the arm (StatsInput.costUsd).
 */
import { EXECUTION_ERROR_CATEGORIES } from '@hermes-evals/shared';
import { mean, median } from '../experiments/views/numbers.js';
import type { SecondaryDifference, SecondaryMetrics, StatsRun } from './contracts.js';

const known = (values: readonly (number | null)[]): number[] =>
  values.filter((v): v is number => v !== null);

export function secondaryMetrics(
  runs: readonly StatsRun[],
  costUsd: number | null,
): SecondaryMetrics {
  const categories = new Set(runs.flatMap((r) => (r.executionError ? [r.executionError] : [])));
  return {
    medianDurationS: median(known(runs.map((r) => r.durationS))),
    meanTokens: mean(known(runs.map((r) => r.tokens))),
    costUsd,
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
