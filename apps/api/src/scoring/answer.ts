/**
 * Grading one answer-based key: numeric_tolerance, json_match or exact_match
 * against the reference answer, at the key's path (plan 9.3).
 *
 * Path rules: the reference lacking the value is the check's fault (`error`);
 * the answer lacking it is the agent's (`failed`). A missing or invalid
 * answer block makes the key `ungradable`, never a zero (plan 9.1).
 */
import type { ExtractedAnswer, JsonValue, ScorerParams } from '@hermes-evals/shared';
import {
  AnswerPathError,
  describePath,
  parseAnswerPath,
  resolveAnswerPath,
} from './answer-path.js';
import { scoreExactMatch } from './exact-match.js';
import { extractionComment } from './extraction.js';
import { scoreJsonMatch } from './json-match.js';
import { scoreNumericTolerance } from './numeric-tolerance.js';
import type { AnswerScorerType } from './registry.js';
import { binary, guarded, scorerError, ungradable, type ScorerResult } from './result.js';

/** One answer-based key with its parsed (defaulted) params. */
export type AnswerKey = {
  [T in AnswerScorerType]: { type: T; params: ScorerParams<T> };
}[AnswerScorerType];

/** Compares two values already taken at the key's path. */
export function compareAnswerValues(
  key: AnswerKey,
  observed: JsonValue,
  expected: JsonValue,
): ScorerResult {
  switch (key.type) {
    case 'numeric_tolerance':
      return scoreNumericTolerance(key.params, observed, expected);
    case 'json_match':
      return scoreJsonMatch(key.params, observed, expected);
    case 'exact_match':
      return scoreExactMatch(key.params, observed, expected);
  }
}

/**
 * Grades the extracted answer against the reference. Never throws: a scorer
 * that throws, or a malformed path, gives `error`.
 */
export function scoreAnswer(
  key: AnswerKey,
  answer: ExtractedAnswer,
  reference: JsonValue,
): ScorerResult {
  if (answer.status !== 'found') return ungradable(extractionComment(answer));
  const path = key.params.path;
  return guarded(() => {
    if (path !== undefined) {
      try {
        parseAnswerPath(path);
      } catch (err) {
        if (err instanceof AnswerPathError) return scorerError(err.message);
        throw err;
      }
    }
    const expected = resolveAnswerPath(reference, path);
    if (!expected.found) return scorerError(`the reference has no value at ${describePath(path)}`);
    const observed = resolveAnswerPath(answer.value, path);
    if (!observed.found) {
      return binary(false, `the answer has no value at ${describePath(path)}`, {
        expected: expected.value,
      });
    }
    return compareAnswerValues(key, observed.value, expected.value);
  });
}

/** The reference graded as if it were the answer: the self-check of mode `answer` (plan 4.3). */
export function scoreReferenceAsAnswer(key: AnswerKey, reference: JsonValue): ScorerResult {
  return scoreAnswer(
    key,
    { status: 'found', block_count: 1, start: 0, end: 0, value: reference },
    reference,
  );
}
