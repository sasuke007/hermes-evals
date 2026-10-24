import { SCORER_PARAM_SCHEMAS, SCORER_TYPES } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_SCORER_TYPES,
  SCORERS,
  SCORER_VERSIONS,
  isAnswerScorerType,
  parseScorerParams,
  scorerVersionLabel,
  selfCheckModeFor,
} from './registry.js';

describe('scorer registry', () => {
  it('registers every scorer type with its shared params schema', () => {
    expect(Object.keys(SCORERS).sort()).toEqual([...SCORER_TYPES].sort());
    for (const type of SCORER_TYPES) {
      expect(SCORERS[type].type).toBe(type);
      expect(SCORERS[type].params).toBe(SCORER_PARAM_SCHEMAS[type]);
      // scores.scorer_version is an integer >= 1.
      expect(Number.isInteger(SCORERS[type].version) && SCORERS[type].version >= 1).toBe(true);
    }
  });

  it('exposes the versions for the check hash and as labels', () => {
    expect(Object.keys(SCORER_VERSIONS)).toEqual([...SCORER_TYPES]);
    expect(Object.isFrozen(SCORER_VERSIONS)).toBe(true);
    expect(scorerVersionLabel('numeric_tolerance')).toBe('numeric_tolerance@1');
  });

  it('assigns the self-check modes of plan 4.3', () => {
    expect(ANSWER_SCORER_TYPES.map((t) => selfCheckModeFor(t, false))).toEqual([
      'answer',
      'answer',
      'answer',
    ]);
    expect(selfCheckModeFor('verifier_script', false)).toBe('script');
    expect(selfCheckModeFor('verifier_script', true)).toBe('workspace');
    expect(selfCheckModeFor('file_check', false)).toBe('workspace');
    expect(selfCheckModeFor('trajectory_match', true)).toBe('none');
    expect(selfCheckModeFor('llm_judge', false)).toBe('none');
    expect(SCORER_TYPES.filter(isAnswerScorerType)).toEqual([...ANSWER_SCORER_TYPES]);
    expect(SCORER_TYPES.filter((t) => SCORERS[t].needsAnswer)).toEqual([...ANSWER_SCORER_TYPES]);
  });

  it('parses params strictly and applies defaults', () => {
    const json = parseScorerParams('json_match', { unordered: true });
    expect(json.success && json.data).toEqual({ unordered: true, pass_at: 1 });
    expect(parseScorerParams('verifier_script', { script: 'check.py' }).data).toEqual({
      script: 'check.py',
      timeout_s: 30,
      pass_at: 1,
    });
    expect(parseScorerParams('json_match', { pass_at: '1' }).success).toBe(false);
    expect(parseScorerParams('exact_match', { case_sensitve: false }).success).toBe(false);
    expect(
      parseScorerParams('trajectory_match', { tool: 'read_file', min_calls: 2, max_calls: 1 })
        .success,
    ).toBe(false);
  });
});
