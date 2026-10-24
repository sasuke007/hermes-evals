/**
 * exact_match (plan 9.3): string equality after optional trimming and case
 * folding. A non-string compares as its JSON text, so the number 7 equals
 * the string "7" and objects must match key order too. Ours, because the
 * openevals version has neither option.
 */
import type { ExactMatchParams, JsonValue } from '@hermes-evals/shared';
import { binary, type ScorerResult } from './result.js';

/** The text exact_match compares. toLowerCase, not toLocaleLowerCase: no locale. */
export function exactText(value: JsonValue, params: ExactMatchParams): string {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (params.trim) text = text.trim();
  return params.case_sensitive ? text : text.toLowerCase();
}

export function scoreExactMatch(
  params: ExactMatchParams,
  observed: JsonValue,
  expected: JsonValue,
): ScorerResult {
  const same = exactText(observed, params) === exactText(expected, params);
  return binary(same, same ? 'equal' : 'differs', { observed, expected });
}
