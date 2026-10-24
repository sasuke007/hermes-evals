import type { ExtractedAnswer, JsonValue } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { scoreAnswer, scoreReferenceAsAnswer, type AnswerKey } from './answer.js';
import { extractAnswer } from './extraction.js';
import { parseScorerParams } from './registry.js';

const block = (json: string) => `Done.\n\`\`\`json\n${json}\n\`\`\`\n`;

/** Builds a key the way the loader does: params through the registry's strict schema. */
function key(type: AnswerKey['type'], params: Record<string, unknown>): AnswerKey {
  const parsed = parseScorerParams(type, params);
  if (!parsed.success) throw parsed.error;
  return { type, params: parsed.data } as AnswerKey;
}

const grade = (k: AnswerKey, answerJson: string, reference: JsonValue) =>
  scoreAnswer(k, extractAnswer(block(answerJson)), reference);

describe('numeric_tolerance', () => {
  const cents = key('numeric_tolerance', { path: 'total_due', abs: 0.01 });
  const reference = { total_due: 99760.52 };
  const status = (json: string) => grade(cents, json, reference).status;

  it('accepts exactly one cent either way and rejects more', () => {
    expect(status('{"total_due": 99760.52}')).toBe('passed');
    expect(status('{"total_due": 99760.53}')).toBe('passed');
    expect(status('{"total_due": 99760.51}')).toBe('passed');
    expect(status('{"total_due": 99760.50}')).toBe('failed');
    expect(status('{"total_due": 185908.80}')).toBe('failed');
  });

  it('keeps the tolerance tight for large values', () => {
    const big = key('numeric_tolerance', { abs: 0.01 });
    expect(grade(big, '1000000000.5', 1e9).status).toBe('failed');
    expect(grade(big, '1000000000.01', 1e9).status).toBe('passed');
  });

  it('applies a relative tolerance, and either bound passes', () => {
    const rel = key('numeric_tolerance', { rel: 0.001 });
    expect(grade(rel, '1001', 1000).status).toBe('passed');
    expect(grade(rel, '1001.5', 1000).status).toBe('failed');
    const both = key('numeric_tolerance', { abs: 5, rel: 0.001 });
    expect(grade(both, '1004', 1000).status).toBe('passed');
  });

  it('requires equality, up to float slack, with no tolerance', () => {
    const exact = key('numeric_tolerance', {});
    expect(grade(exact, '0.30000000000000004', 0.3).status).toBe('passed');
    expect(grade(exact, '0.3001', 0.3).status).toBe('failed');
  });

  it('coerces numeric strings and fails other values', () => {
    expect(status('{"total_due": "99760.52"}')).toBe('passed');
    expect(status('{"total_due": "about 99760"}')).toBe('failed');
    expect(status('{"total_due": null}')).toBe('failed');
    expect(status('{"total_due": true}')).toBe('failed');
    expect(status('{"total_due": "  "}')).toBe('failed');
  });

  it('scores 1 or 0 and records both values', () => {
    expect(grade(cents, '{"total_due": 99760.52}', reference)).toMatchObject({
      score: 1,
      observed: 99760.52,
      expected: 99760.52,
      comment: '|observed − expected| = 0.00000',
    });
    expect(grade(cents, '{"total_due": 1}', reference)).toMatchObject({ score: 0 });
  });

  it('errors, without a score, on a reference that is not a number', () => {
    expect(grade(cents, '{"total_due": 1}', { total_due: 'n/a' })).toMatchObject({
      status: 'error',
      score: null,
      comment: 'the reference is not a number',
    });
  });
});

describe('paths', () => {
  const cents = key('numeric_tolerance', { path: 'total_due', abs: 0.01 });

  it('fails an answer without the value, and errors on a reference without it', () => {
    expect(grade(cents, '{"total": 99760.52}', { total_due: 1 })).toMatchObject({
      status: 'failed',
      score: 0,
      comment: 'the answer has no value at total_due',
      expected: 1,
    });
    expect(grade(cents, '{"total_due": 1}', {})).toMatchObject({
      status: 'error',
      score: null,
      comment: 'the reference has no value at total_due',
    });
  });

  it('reads indices and nested keys', () => {
    const nested = key('exact_match', { path: 'pairs[1][0]' });
    expect(grade(nested, '{"pairs": [["a"], ["b"]]}', { pairs: [['x'], ['b']] }).status).toBe(
      'passed',
    );
  });

  it('errors on a malformed path instead of guessing', () => {
    const bad = key('exact_match', { path: 'a..b' });
    expect(grade(bad, '{"a": 1}', { a: 1 })).toMatchObject({
      status: 'error',
      score: null,
      comment: expect.stringMatching(/invalid path a\.\.b/),
    });
  });
});

describe('exact_match', () => {
  const ids = key('exact_match', { path: 'ids' });
  const ref = { ids: 'A,B' };

  it('trims by default and is case-sensitive by default', () => {
    expect(grade(ids, '{"ids": " A,B "}', ref).status).toBe('passed');
    expect(grade(ids, '{"ids": "a,b"}', ref).status).toBe('failed');
    expect(grade(ids, '{"other": 1}', ref).status).toBe('failed');
  });

  it('honours trim: false and case_sensitive: false', () => {
    const strict = key('exact_match', { path: 'ids', trim: false });
    expect(grade(strict, '{"ids": " A,B "}', ref).status).toBe('failed');
    const folded = key('exact_match', { path: 'ids', case_sensitive: false });
    expect(grade(folded, '{"ids": "a,b"}', ref).status).toBe('passed');
  });

  it('compares non-strings as JSON text', () => {
    const whole = key('exact_match', {});
    expect(grade(whole, '7', '7').status).toBe('passed');
    expect(grade(whole, '[1, 2]', [1, 2]).status).toBe('passed');
    expect(grade(whole, '{"b": 1, "a": 2}', { a: 2, b: 1 }).status).toBe('failed');
  });
});

describe('extraction outcomes', () => {
  const k = key('json_match', {});

  it('makes a missing or invalid answer ungradable, never a zero', () => {
    const missing: ExtractedAnswer = { status: 'missing', block_count: 0 };
    expect(scoreAnswer(k, missing, 1)).toEqual({
      status: 'ungradable',
      score: null,
      comment: 'no fenced JSON block found in final response',
    });
    expect(scoreAnswer(k, extractAnswer('```json\n{x}\n```'), 1)).toMatchObject({
      status: 'ungradable',
      score: null,
      comment: expect.stringMatching(/^invalid JSON/),
    });
  });
});

describe('scoreReferenceAsAnswer', () => {
  it('passes for every answer type when the key is sound', () => {
    const reference = { total: 12.5, ids: 'A,B', pairs: [['b', 'a']] };
    expect(
      scoreReferenceAsAnswer(key('numeric_tolerance', { path: 'total' }), reference).status,
    ).toBe('passed');
    expect(scoreReferenceAsAnswer(key('exact_match', { path: 'ids' }), reference).status).toBe(
      'passed',
    );
    expect(
      scoreReferenceAsAnswer(key('json_match', { path: 'pairs', unordered: true }), reference)
        .status,
    ).toBe('passed');
  });

  it('errors when the key points at nothing in the reference', () => {
    expect(scoreReferenceAsAnswer(key('json_match', { path: 'missing' }), {}).status).toBe('error');
  });
});
