/**
 * Counting helpers the comparison statistics and the repetitions estimate
 * share (plan 10.1): pass tallies, per-task differences, the task change and
 * the verdict rule. The runs are counted runs already (./contracts.ts).
 */
import type { TaskChange, Verdict } from '@hermes-evals/shared';
import { mean } from '../experiments/views/numbers.js';
import type { PassTally, StatsRun } from './contracts.js';

/**
 * Below this, a mean difference or an interval bound is 0. A sum of rates
 * can leave 1e-17 where exact arithmetic gives 0 (0.2 + 0.4 − 0.6), and that
 * must not turn an interval [0, x] into `better`. Any real difference is far
 * larger: with up to a thousand tasks and a dozen counted runs per side the
 * smallest non-zero mean is about 1e-8.
 */
const ZERO_TOLERANCE = 1e-9;

/** `x`, or 0 when it is within float noise of 0 (also turns −0 into 0). */
export const cleanZero = (x: number): number => (Math.abs(x) < ZERO_TOLERANCE ? 0 : x);

export function tallyOf(runs: readonly StatsRun[]): PassTally {
  const passed = runs.filter((r) => r.passed).length;
  return { passed, counted: runs.length, rate: runs.length === 0 ? null : passed / runs.length };
}

/** One tally over several lists of runs (every task of one side). */
export const pooledTally = (lists: readonly (readonly StatsRun[])[]): PassTally =>
  tallyOf(lists.flat());

/**
 * Candidate rate minus baseline rate; null unless both sides counted a run.
 * Exact 0 when the rates are equal: equal fractions divide to the same float.
 */
export const rateDelta = (baseline: PassTally, candidate: PassTally): number | null =>
  baseline.rate === null || candidate.rate === null ? null : candidate.rate - baseline.rate;

export const changeOf = (delta: number | null): TaskChange | null =>
  delta === null ? null : delta > 0 ? 'improved' : delta < 0 ? 'regressed' : 'unchanged';

/** The mean of the defined differences (tasks counted on both sides); null when there are none. */
export function meanDelta(deltas: readonly (number | null)[]): number | null {
  const m = mean(deltas.filter((d): d is number => d !== null));
  return m === null ? null : cleanZero(m);
}

/** better if lo > 0, worse if hi < 0, else inconclusive; provisional while the experiment runs. */
export function verdictOf(lo: number, hi: number, provisional: boolean): Verdict | 'provisional' {
  if (provisional) return 'provisional';
  return lo > 0 ? 'better' : hi < 0 ? 'worse' : 'inconclusive';
}

/** Every task has at least `min` runs on both sides (and there is a task). */
export const everyTaskHas = (
  tasks: readonly { baseline: readonly StatsRun[]; candidate: readonly StatsRun[] }[],
  min: number,
): boolean =>
  tasks.length > 0 && tasks.every((t) => t.baseline.length >= min && t.candidate.length >= min);
