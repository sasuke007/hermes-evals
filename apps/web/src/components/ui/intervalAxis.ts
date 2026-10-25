/**
 * The axis of the interval figures (IntervalBar, the Comparison's IntervalChart): symmetric
 * about zero, so crossing it shows at once; its half-width at least 0.2, at most 1, and
 * rounded up to a multiple of 0.2, so the quarter ticks fall on whole tenths and read true
 * with one decimal (±0.4 for [−0.111, +0.250]: ticks −0.4 −0.2 0 +0.2 +0.4).
 */
import { formatSigned } from '@/lib/format';

/** The axis half-width for these values (the bounds and the point). */
export function intervalHalfWidth(...values: number[]): number {
  const largest = Math.max(0, ...values.map((v) => Math.abs(v)));
  return Math.min(1, Math.max(0.2, Math.ceil(largest * 5 - 1e-9) / 5));
}

/** A tick's label: "0", "−0.2", "+0.4". */
export const axisTick = (v: number): string => (v === 0 ? '0' : formatSigned(v, 1));
