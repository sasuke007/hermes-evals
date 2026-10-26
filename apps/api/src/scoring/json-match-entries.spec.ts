/**
 * json_match's key-by-key evidence (Phase 5 section 6.1, Phase 7): the
 * compared path and every key or item with both values, as the run
 * inspector's evidence table reads them. Every evidence parses with the
 * shared schema the run views use.
 */
import {
  JsonMatchParamsSchema,
  ScoreEvidenceSchema,
  type JsonMatchEvidence,
  type JsonValue,
} from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { MAX_ENTRIES } from './json-match-entries.js';
import { scoreJsonMatch } from './json-match.js';
import { scoreAnswer } from './answer.js';

const evidenceOf = (
  params: Record<string, unknown>,
  observed: JsonValue,
  expected: JsonValue,
): JsonMatchEvidence =>
  ScoreEvidenceSchema.parse(
    scoreJsonMatch(JsonMatchParamsSchema.parse(params), observed, expected).evidence,
  ).json_match!;

describe('the compared path', () => {
  it('is the check’s path, or null when the whole answer is compared', () => {
    expect(evidenceOf({ path: 'overdue_by_vendor' }, { a: 1 }, { a: 1 }).path).toBe(
      'overdue_by_vendor',
    );
    expect(evidenceOf({}, { a: 1 }, { a: 1 }).path).toBeNull();
  });

  it('comes through answer scoring, which compares the values at it', () => {
    const result = scoreAnswer(
      { type: 'json_match', params: JsonMatchParamsSchema.parse({ path: 'totals', pass_at: 0.5 }) },
      {
        status: 'found',
        block_count: 1,
        start: 0,
        end: 0,
        value: { totals: { net: 10, vat: 3 } },
      },
      { totals: { net: 10, vat: 2 } },
    );
    const evidence = ScoreEvidenceSchema.parse(result.evidence).json_match!;
    expect(evidence).toMatchObject({ path: 'totals', unit: 'keys', matched: 1, total: 2 });
    expect(evidence.entries).toEqual([
      { path: 'net', expected: 10, observed: 10, match: true },
      { path: 'vat', expected: 2, observed: 3, match: false },
    ]);
  });
});

describe('entries of an object', () => {
  const reference = {
    'Fjord Software': 3,
    'Granite Office': 2,
    'Helios Energy': 4,
    'Cobalt Print Co': 1,
    'Nordlys Freight': 7,
  };

  it('lists the reference’s keys in its order, then the answer’s own, as the board draws them', () => {
    const answer = {
      'Fjord Software': 3,
      'Granite Office': 3,
      'Helios Energy': 4,
      'Cobalt Print Co': 1,
      'Atlas Paper': 2,
    };
    expect(evidenceOf({ pass_at: 0.8 }, answer, reference).entries).toEqual([
      { path: 'Fjord Software', expected: 3, observed: 3, match: true },
      { path: 'Granite Office', expected: 2, observed: 3, match: false },
      { path: 'Helios Energy', expected: 4, observed: 4, match: true },
      { path: 'Cobalt Print Co', expected: 1, observed: 1, match: true },
      { path: 'Nordlys Freight', expected: 7, match: false },
      { path: 'Atlas Paper', observed: 2, match: false },
    ]);
  });

  it('compares a key’s value as the check does, one level deep, and leaves excluded keys out', () => {
    const entries = evidenceOf(
      { unordered: true, exclude_keys: ['note'] },
      { ids: [3, 1, 2], note: 'mine', 'a.b': { x: 1 } },
      { ids: [1, 2, 3], note: 'theirs', 'a.b': { x: 2 } },
    ).entries;
    expect(entries).toEqual([
      { path: 'ids', expected: [1, 2, 3], observed: [3, 1, 2], match: true },
      { path: '["a.b"]', expected: { x: 2 }, observed: { x: 1 }, match: false },
    ]);
  });

  it('lists every reference key as missing when the answer is no object', () => {
    expect(evidenceOf({}, [1], { a: 1, b: 2 }).entries).toEqual([
      { path: 'a', expected: 1, match: false },
      { path: 'b', expected: 2, match: false },
    ]);
  });
});

describe('entries of a list', () => {
  it('pairs an ordered list by index, partial pairs not matching, extras after', () => {
    expect(
      evidenceOf({}, [{ net: 1 }, { net: 9 }, 'extra'], [{ net: 1 }, { net: 3 }]).entries,
    ).toEqual([
      { path: '[0]', expected: { net: 1 }, observed: { net: 1 }, match: true },
      { path: '[1]', expected: { net: 3 }, observed: { net: 9 }, match: false },
      { path: '[2]', observed: 'extra', match: false },
    ]);
    expect(evidenceOf({}, ['a'], ['a', 'b']).entries).toEqual([
      { path: '[0]', expected: 'a', observed: 'a', match: true },
      { path: '[1]', expected: 'b', match: false },
    ]);
  });

  it('names an unordered pair by the reference’s index, and an answer extra by its own', () => {
    const overdue = ['INV-1', 'INV-2', 'INV-3'];
    expect(evidenceOf({ unordered: true }, ['INV-3', 'INV-9', 'INV-1'], overdue).entries).toEqual([
      { path: '[0]', expected: 'INV-1', observed: 'INV-1', match: true },
      { path: '[1]', expected: 'INV-2', observed: 'INV-9', match: false },
      { path: '[2]', expected: 'INV-3', observed: 'INV-3', match: true },
    ]);
    expect(
      evidenceOf({ unordered: true }, ['INV-2', 'INV-9', 'INV-1', 'INV-3'], overdue).entries,
    ).toEqual([
      { path: '[0]', expected: 'INV-1', observed: 'INV-1', match: true },
      { path: '[1]', expected: 'INV-2', observed: 'INV-2', match: true },
      { path: '[2]', expected: 'INV-3', observed: 'INV-3', match: true },
      { path: '[1]', observed: 'INV-9', match: false },
    ]);
  });

  it('pairs partly matching objects of an unordered list as the score does', () => {
    const entries = evidenceOf(
      { unordered: true },
      [
        { invoice: 'INV-2', fee: 3 },
        { invoice: 'INV-1', fee: 9 },
      ],
      [
        { invoice: 'INV-1', fee: 2 },
        { invoice: 'INV-2', fee: 3 },
      ],
    ).entries;
    expect(entries).toEqual([
      {
        path: '[0]',
        expected: { invoice: 'INV-1', fee: 2 },
        observed: { invoice: 'INV-1', fee: 9 },
        match: false,
      },
      {
        path: '[1]',
        expected: { invoice: 'INV-2', fee: 3 },
        observed: { invoice: 'INV-2', fee: 3 },
        match: true,
      },
    ]);
  });

  it('lists every reference item as missing when the answer is no list, and none for two empty lists', () => {
    expect(evidenceOf({}, { a: 1 }, [1, 2]).entries).toEqual([
      { path: '[0]', expected: 1, match: false },
      { path: '[1]', expected: 2, match: false },
    ]);
    expect(evidenceOf({}, [], []).entries).toEqual([]);
  });

  it('keeps the reference’s first entries of a very long list', () => {
    const expected = Array.from({ length: MAX_ENTRIES + 20 }, (_, i) => i);
    const entries = evidenceOf({}, expected, expected).entries!;
    expect(entries).toHaveLength(MAX_ENTRIES);
    expect(entries.at(-1)).toEqual({
      path: `[${MAX_ENTRIES - 1}]`,
      expected: MAX_ENTRIES - 1,
      observed: MAX_ENTRIES - 1,
      match: true,
    });
  });
});

describe('entries of another value', () => {
  it('is one entry at the value itself', () => {
    expect(evidenceOf({}, 'x', 'x').entries).toEqual([
      { path: '', expected: 'x', observed: 'x', match: true },
    ]);
    expect(evidenceOf({}, 1, 2).entries).toEqual([
      { path: '', expected: 2, observed: 1, match: false },
    ]);
  });
});
