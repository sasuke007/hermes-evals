/**
 * How many repetitions per task an interval of a given half-width would need
 * (plan 19: "say what repetition count the interval width suggests"), for
 * the Phase 8 report. Not part of the API contract.
 *
 * The bootstrap over tasks measures how much the per-task differences d_i
 * vary. That variance has two parts, and only one shrinks with repetitions:
 * - within: the binomial noise of each task's two pass rates, which falls as
 *   1 / r with r repetitions per side;
 * - between: how much the tasks' true differences differ from each other,
 *   which no number of repetitions removes (only more tasks do).
 * So the estimate splits the observed variance S² of the d_i (n − 1
 * denominator) into within = mean over tasks of p̂b(1 − p̂b)/(nb − 1) +
 * p̂c(1 − p̂c)/(nc − 1) (the unbiased estimate of each difference's sampling
 * variance) and between = max(0, S² − within), and predicts the half-width
 * at r repetitions with the normal approximation of the percentile
 * bootstrap: z × √((T − 1) / T² × (between + V / r)), where V is the mean
 * per-run variance (within with r = 1) and T the number of tasks.
 */
import { DEFAULT_CONFIDENCE, type StatsInput, type StatsOptions } from './contracts.js';
import { rateDelta, tallyOf } from './tally.js';

const horner = (coefficients: readonly number[], x: number): number =>
  coefficients.reduce((sum, c) => sum * x + c, 0);

// Acklam's rational approximation of the inverse normal CDF (relative error
// below 1.2e-9), highest power first.
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
];
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1, 1,
];
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
];
const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416, 1];
const TAIL = 0.02425;

/** The standard normal quantile: z with P(Z ≤ z) = p, for p in (0, 1). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`normal quantile of ${p}`);
  if (p < TAIL) {
    const q = Math.sqrt(-2 * Math.log(p));
    return horner(C, q) / horner(D, q);
  }
  if (p > 1 - TAIL) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -horner(C, q) / horner(D, q);
  }
  const q = p - 0.5;
  const r = q * q;
  return (horner(A, r) * q) / horner(B, r);
}

/** p̂(1 − p̂) × n / (n − 1): the unbiased variance of one 0/1 run of a side. */
const runVariance = (passed: number, counted: number): number => {
  const p = passed / counted;
  return (p * (1 - p) * counted) / (counted - 1);
};

/**
 * The repetitions per task (at least 2, the gate's minimum) that the
 * observed variance suggests for an interval of half-width `halfWidth`
 * (e.g. 0.1 for ±0.10) at the given confidence. Null when the input has too
 * little to estimate a variance from (fewer than 2 tasks with 2 counted runs
 * per configuration), or when the differences between tasks alone are wider
 * than that, so that no number of repetitions gets there and only more
 * tasks would.
 */
export function suggestRepetitions(
  input: StatsInput,
  halfWidth: number,
  options: Pick<StatsOptions, 'confidence'> = {},
): number | null {
  if (!(halfWidth > 0 && Number.isFinite(halfWidth))) {
    throw new RangeError(`halfWidth must be a positive number, got ${halfWidth}`);
  }
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE;
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError(`confidence must be in (0, 1), got ${confidence}`);
  }
  const taskCount = input.tasks.length;
  const usable = input.tasks.flatMap((task) => {
    const b = tallyOf(task.baseline);
    const c = tallyOf(task.candidate);
    if (b.counted < 2 || c.counted < 2) return [];
    const perRun = runVariance(b.passed, b.counted) + runVariance(c.passed, c.counted);
    const within =
      runVariance(b.passed, b.counted) / b.counted + runVariance(c.passed, c.counted) / c.counted;
    return [{ delta: rateDelta(b, c)!, within, perRun }];
  });
  if (taskCount < 2 || usable.length < 2) return null;

  const k = usable.length;
  const meanOf = (pick: (u: (typeof usable)[number]) => number): number =>
    usable.reduce((sum, u) => sum + pick(u), 0) / k;
  const d = meanOf((u) => u.delta);
  const s2 = usable.reduce((sum, u) => sum + (u.delta - d) ** 2, 0) / (k - 1);
  const within = meanOf((u) => u.within);
  const perRun = meanOf((u) => u.perRun);
  const between = Math.max(0, s2 - within);

  // between + perRun / r must not exceed this for the half-width to fit.
  const z = normalQuantile((1 + confidence) / 2);
  const budget = ((halfWidth / z) ** 2 * taskCount * taskCount) / (taskCount - 1);
  if (perRun === 0) return between <= budget ? 2 : null;
  const room = budget - between;
  if (room <= 0) return null;
  return Math.max(2, Math.ceil(perRun / room - 1e-9));
}
