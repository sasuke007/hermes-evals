/** The bootstrap's pieces: the seeded PRNG, the type 7 percentile and the resampling. */
import { describe, expect, it } from 'vitest';
import { bootstrapInterval, bootstrapMeans, mulberry32, percentile } from './bootstrap.js';

const draws = (seed: number, n: number): number[] => {
  const next = mulberry32(seed);
  return Array.from({ length: n }, () => next());
};

describe('mulberry32', () => {
  it('produces the reference sequence, so stored verdicts can be recomputed', () => {
    // Checked against an independent unsigned-integer port; seed 0 starts 0.2664292…
    const u32 = (seed: number) => draws(seed, 3).map((x) => x * 2 ** 32);
    expect(u32(0)).toEqual([1_144_304_738, 1_416_247, 958_946_056]);
    expect(u32(0x2ba192df)).toEqual([4_124_296_599, 2_759_662_891, 1_953_536_110]);
  });

  it('is uniform on [0, 1), the same for a seed and different across seeds', () => {
    const xs = draws(42, 100_000);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((a, x) => a + x, 0) / xs.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.005);
    const tenths = Array.from(
      { length: 10 },
      (_, i) => xs.filter((x) => Math.floor(x * 10) === i).length,
    );
    for (const count of tenths) expect(Math.abs(count - 10_000)).toBeLessThan(500);
    expect(draws(42, 5)).toEqual(xs.slice(0, 5));
    expect(draws(43, 5)).not.toEqual(xs.slice(0, 5));
  });
});

describe('percentile (type 7)', () => {
  it('matches R quantile(type = 7) and NumPy percentile', () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // quantile(1:10, c(0.025, 0.5, 0.975)) is 1.225, 5.5, 9.775.
    expect(percentile(ten, 0.025)).toBeCloseTo(1.225, 12);
    expect(percentile(ten, 0.5)).toBeCloseTo(5.5, 12);
    expect(percentile(ten, 0.975)).toBeCloseTo(9.775, 12);
    expect(percentile([1, 3, 7], 0.5)).toBe(3);
    expect(percentile([1, 3, 7], 0.75)).toBe(5);
  });

  it('takes the extremes at 0 and 1, and a single value everywhere', () => {
    expect(percentile([2, 4, 8], 0)).toBe(2);
    expect(percentile([2, 4, 8], 1)).toBe(8);
    expect(percentile([0.4], 0.025)).toBe(0.4);
    expect(percentile([0.4], 0.975)).toBe(0.4);
  });

  it('refuses no values and p outside [0, 1]', () => {
    expect(() => percentile([], 0.5)).toThrow(RangeError);
    expect(() => percentile([1], 1.5)).toThrow(RangeError);
    expect(() => percentile([1], Number.NaN)).toThrow(RangeError);
  });
});

describe('bootstrapMeans', () => {
  const deltas = [0, 0, 0, 0, 0.2, 0.2, 0.2, 0.2, 0.4, 0.4, 0.4, 0.6];

  it('draws one mean per resample, the same for the same seed', () => {
    const a = bootstrapMeans(deltas, 1_000, 7);
    expect(a).toHaveLength(1_000);
    expect(Array.from(bootstrapMeans(deltas, 1_000, 7))).toEqual(Array.from(a));
    expect(Array.from(bootstrapMeans(deltas, 1_000, 8))).not.toEqual(Array.from(a));
    // Each mean is a mean of drawn values: within their range, and centred on theirs.
    for (const m of a) {
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(0.6);
    }
    const centre = a.reduce((s, m) => s + m, 0) / a.length;
    expect(Math.abs(centre - 2.6 / 12)).toBeLessThan(0.01);
  });

  it('keeps a constant constant', () => {
    expect(new Set(bootstrapMeans([0.25, 0.25, 0.25], 100, 1))).toEqual(new Set([0.25]));
  });

  it('refuses no values and a resample count that is not a positive integer', () => {
    expect(() => bootstrapMeans([], 10, 1)).toThrow(RangeError);
    expect(() => bootstrapMeans([1], 0, 1)).toThrow(RangeError);
    expect(() => bootstrapMeans([1], 2.5, 1)).toThrow(RangeError);
  });
});

describe('bootstrapInterval', () => {
  it('brackets the mean, and widens with the confidence', () => {
    const deltas = [0, 0, 0, 0, 0.2, 0.2, 0.2, 0.2, 0.4, 0.4, 0.4, 0.6];
    const at = (confidence: number) =>
      bootstrapInterval(deltas, { seed: 3, resamples: 10_000, confidence });
    const ninety = at(0.9);
    const ninetyNine = at(0.99);
    expect(ninety.lo).toBeLessThan(2.6 / 12);
    expect(ninety.hi).toBeGreaterThan(2.6 / 12);
    expect(ninetyNine.lo).toBeLessThanOrEqual(ninety.lo);
    expect(ninetyNine.hi).toBeGreaterThanOrEqual(ninety.hi);
  });

  it('refuses a confidence outside (0, 1)', () => {
    for (const confidence of [0, 1, -0.5, Number.NaN]) {
      expect(() => bootstrapInterval([1, 2], { seed: 1, resamples: 10, confidence })).toThrow(
        RangeError,
      );
    }
  });
});
