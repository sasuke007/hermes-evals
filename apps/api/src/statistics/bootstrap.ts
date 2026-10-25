/**
 * The paired bootstrap over tasks (plan 10.2) and the pieces it is made of:
 * a small seeded PRNG and the "type 7" percentile. Pure and deterministic:
 * the same values, seed and resample count always give the same interval,
 * on every machine, because the PRNG is integer arithmetic and the means are
 * summed in draw order.
 *
 * The algorithm:
 * 1. The input is one number per task: the task's candidate pass rate minus
 *    its baseline pass rate. Resampling the task, not its runs, keeps each
 *    task's runs together, so task-to-task variation is what the interval
 *    measures, and the two configurations stay paired by task.
 * 2. Each resample draws T tasks with replacement from the T tasks (index =
 *    floor(u × T), u uniform in [0, 1) from mulberry32) and takes the mean
 *    of their differences; this is repeated `resamples` times (10,000).
 * 3. The interval is the (1 − confidence) / 2 and (1 + confidence) / 2
 *    percentiles of the sorted resample means (the 2.5th and 97.5th for
 *    95%), interpolated linearly between order statistics: the common
 *    "type 7" definition (R's default, NumPy's `linear`).
 */

/**
 * mulberry32 (Tommy Ettinger, public domain): a 32-bit-state generator,
 * plenty for 10,000 × T draws, and the same sequence for the same seed
 * everywhere. Returns uniform numbers in [0, 1) with 32 bits each.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * The p-th quantile (p in [0, 1]) of ascending values, type 7: h = (n − 1)p,
 * then linear interpolation between the order statistics around h.
 */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  if (sorted.length === 0) throw new RangeError('percentile of no values');
  if (!(p >= 0 && p <= 1)) throw new RangeError(`percentile ${p} is not in [0, 1]`);
  const h = (sorted.length - 1) * p;
  const below = Math.floor(h);
  const above = Math.min(below + 1, sorted.length - 1);
  const low = sorted[below]!;
  return low + (h - below) * (sorted[above]! - low);
}

/** Step 2: the mean of each resample, in draw order (not sorted). */
export function bootstrapMeans(
  values: readonly number[],
  resamples: number,
  seed: number,
): Float64Array {
  if (values.length === 0) throw new RangeError('bootstrap of no values');
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new RangeError(`resamples must be a positive integer, got ${resamples}`);
  }
  const n = values.length;
  const pool = Float64Array.from(values);
  const next = mulberry32(seed);
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += pool[Math.floor(next() * n)]!;
    means[r] = sum / n;
  }
  return means;
}

export interface BootstrapOptions {
  seed: number;
  resamples: number;
  /** Two-sided, in (0, 1): 0.95 takes the 2.5th and 97.5th percentiles. */
  confidence: number;
}

/** Steps 2 and 3: the percentile interval of the mean of `values`. */
export function bootstrapInterval(
  values: readonly number[],
  options: BootstrapOptions,
): { lo: number; hi: number } {
  const { seed, resamples, confidence } = options;
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError(`confidence must be in (0, 1), got ${confidence}`);
  }
  const means = bootstrapMeans(values, resamples, seed).sort();
  return {
    lo: percentile(means, (1 - confidence) / 2),
    hi: percentile(means, (1 + confidence) / 2),
  };
}
