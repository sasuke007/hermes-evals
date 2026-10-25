import { JsonMatchParamsSchema, ScoreEvidenceSchema, type JsonValue } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { MAX_MISMATCHES } from './json-match-paths.js';
import { scoreJsonMatch } from './json-match.js';

const match = (params: Record<string, unknown>, observed: JsonValue, expected: JsonValue) =>
  scoreJsonMatch(JsonMatchParamsSchema.parse(params), observed, expected);

/** The stored evidence, parsed as the run views read it. */
const evidenceOf = (params: Record<string, unknown>, observed: JsonValue, expected: JsonValue) =>
  ScoreEvidenceSchema.parse(match(params, observed, expected).evidence).json_match;

describe('json_match evidence on objects', () => {
  const reference: JsonValue = {
    'Fjord Software': 3,
    'Granite Office': 2,
    'Helios Energy': 4,
    'Cobalt Print Co': 1,
    'Nordlys Freight': 7,
  };

  it('counts the keys the comment counts and names each wrong or missing key', () => {
    const replyB = {
      'Fjord Software': 3,
      'Granite Office': 3,
      'Helios Energy': 4,
      'Cobalt Print Co': 1,
    };
    const result = match({ pass_at: 0.8 }, replyB, reference);
    expect(result).toMatchObject({ status: 'failed', score: 0.6 });
    expect(result.comment).toMatch(/^3 of 5 keys match/);
    expect(evidenceOf({ pass_at: 0.8 }, replyB, reference)).toEqual({
      unit: 'keys',
      matched: 3,
      total: 5,
      mismatches: ['Granite Office', 'Nordlys Freight'],
    });
  });

  it('follows a nested value down to the item that differs', () => {
    const answer = { bands: [{ net: 1 }, { net: 2 }, { net: 9 }], currency: 'EUR' };
    const ref = { bands: [{ net: 1 }, { net: 2 }, { net: 3 }], currency: 'EUR' };
    expect(evidenceOf({}, answer, ref)).toEqual({
      unit: 'keys',
      matched: 1,
      total: 2,
      mismatches: ['bands[2].net'],
    });
  });

  it('leaves excluded keys out and brackets keys that would read ambiguously', () => {
    expect(evidenceOf({ exclude_keys: ['note'] }, { 'a.b': 1, note: 'x' }, { 'a.b': 2 })).toEqual({
      unit: 'keys',
      matched: 0,
      total: 1,
      mismatches: ['["a.b"]'],
    });
  });

  it('reports everything matching as no mismatch', () => {
    expect(evidenceOf({}, { a: [1, 2] }, { a: [1, 2] })).toEqual({
      unit: 'keys',
      matched: 1,
      total: 1,
      mismatches: [],
    });
  });
});

describe('json_match evidence on lists', () => {
  it('names the index of each wrong item of an ordered list, down to its key', () => {
    const answer = { bands: [{ net: 1 }, { net: 2 }, { net: 9 }] };
    const ref = [{ net: 1 }, { net: 2 }, { net: 3 }];
    const result = match({}, answer.bands, ref);
    expect(result).toMatchObject({
      score: 0.666667,
      comment: '2 of 3 items match exactly (3 items)',
    });
    expect(evidenceOf({}, answer.bands, ref)).toEqual({
      unit: 'items',
      matched: 2,
      total: 3,
      mismatches: ['[2].net'],
    });
  });

  it('names missing items of an ordered list and extras past its end', () => {
    expect(evidenceOf({}, ['a', 'x'], ['a', 'b', 'c'])?.mismatches).toEqual(['[1]', '[2]']);
    expect(evidenceOf({}, ['a', 'b', 'c', 'd'], ['a', 'b'])).toEqual({
      unit: 'items',
      matched: 2,
      total: 2,
      mismatches: ['[2]', '[3]'],
    });
  });

  it('names a wrong item of an unordered list by the reference item it was paired with', () => {
    const expected = [
      { invoice: 'INV-1', fee: 2 },
      { invoice: 'INV-2', fee: 3 },
    ];
    const observed = [
      { invoice: 'INV-2', fee: 3 },
      { invoice: 'INV-1', fee: 9 },
    ];
    expect(evidenceOf({ unordered: true }, observed, expected)).toEqual({
      unit: 'items',
      matched: 1,
      total: 2,
      mismatches: ['[0].fee'],
    });
  });

  it('names unpaired reference items and the answer extras of an unordered list', () => {
    const overdue = ['INV-1', 'INV-2', 'INV-3'];
    expect(evidenceOf({ unordered: true }, ['INV-3', 'INV-1'], overdue)).toEqual({
      unit: 'items',
      matched: 2,
      total: 3,
      mismatches: ['[1]'],
    });
    expect(evidenceOf({ unordered: true }, ['INV-2', 'INV-9', 'INV-1', 'INV-3'], overdue)).toEqual({
      unit: 'items',
      matched: 3,
      total: 3,
      mismatches: ['[3]'],
    });
  });

  it('names the unmatched items of an unordered list nested under a key', () => {
    expect(
      evidenceOf({ unordered: true }, { ids: [3, 1, 7, 8] }, { ids: [1, 2, 3] })?.mismatches,
    ).toEqual(['ids[1]', 'ids[3]', 'ids[4]']);
  });

  it('caps the mismatch list', () => {
    const expected = Array.from({ length: 80 }, (_, i) => i);
    const observed = expected.map((i) => i + 1000);
    const evidence = evidenceOf({}, observed, expected);
    expect(evidence).toMatchObject({ unit: 'items', matched: 0, total: 80 });
    expect(evidence?.mismatches).toHaveLength(MAX_MISMATCHES);
    expect(evidence?.mismatches[0]).toBe('[0]');
  });

  it('counts nothing matched for a value of the wrong kind', () => {
    expect(evidenceOf({}, { a: 1 }, [1, 2])).toEqual({
      unit: 'items',
      matched: 0,
      total: 2,
      mismatches: [],
    });
  });
});

describe('json_match evidence on other values', () => {
  it('counts the whole value as one unit', () => {
    expect(evidenceOf({}, 'x', 'x')).toEqual({
      unit: 'value',
      matched: 1,
      total: 1,
      mismatches: [],
    });
    expect(evidenceOf({}, 1, 2)).toEqual({ unit: 'value', matched: 0, total: 1, mismatches: [] });
  });
});
