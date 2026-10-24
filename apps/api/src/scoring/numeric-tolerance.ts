/**
 * numeric_tolerance (plan 9.3): passes when |observed − expected| ≤ abs, or
 * ≤ rel × |expected|. With neither, the numbers must be equal. Numeric
 * strings count as numbers, since agents often quote amounts.
 */
import type { JsonValue, NumericToleranceParams } from '@hermes-evals/shared';
import { binary, scorerError, type ScorerResult } from './result.js';

/**
 * Floating-point slack: a few units in the last place of the numbers compared, so a
 * tolerance of 0.01 accepts exactly one cent either way without loosening it.
 */
const ULPS = 64 * Number.EPSILON;

/** A finite number, or a string that reads as one; anything else is not a number. */
export function asNumber(value: JsonValue): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function scoreNumericTolerance(
  params: NumericToleranceParams,
  observed: JsonValue,
  expected: JsonValue,
): ScorerResult {
  const want = asNumber(expected);
  if (want === undefined) return scorerError('the reference is not a number', null, { expected });
  const got = asNumber(observed);
  if (got === undefined) {
    return binary(false, 'the answer is not a number', { observed, expected });
  }
  const { abs, rel } = params;
  const diff = Math.abs(got - want);
  const slack = ULPS * Math.max(1, Math.abs(want), Math.abs(got));
  const within =
    (abs !== undefined && diff <= abs + slack) ||
    (rel !== undefined && diff <= rel * Math.abs(want) + slack) ||
    (abs === undefined && rel === undefined && diff <= slack);
  return binary(within, `|observed − expected| = ${diff.toPrecision(6)}`, {
    observed,
    expected,
  });
}
