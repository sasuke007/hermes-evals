import { JsonMatchParamsSchema, type JsonValue } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { canonicalText, maxCreditAssignment, scoreJsonMatch } from './json-match.js';

const match = (params: Record<string, unknown>, observed: JsonValue, expected: JsonValue) =>
  scoreJsonMatch(JsonMatchParamsSchema.parse(params), observed, expected);

describe('json_match on lists', () => {
  const overdue = ['INV-1', 'INV-2', 'INV-3'];

  it('compares an unordered list as a multiset', () => {
    expect(match({ unordered: true }, ['INV-3', 'INV-1', 'INV-2'], overdue)).toMatchObject({
      status: 'passed',
      score: 1,
    });
    expect(match({ unordered: true }, ['a', 'a', 'b'], ['a', 'b', 'b'])).toMatchObject({
      status: 'failed',
      score: 0.666667,
    });
  });

  it('scores the share of items matched over the longer list', () => {
    expect(match({ unordered: true }, ['INV-1', 'INV-2'], overdue)).toMatchObject({
      status: 'failed',
      score: 0.666667,
      comment: '2 of 3 items match exactly (expected 3 items, got 2)',
    });
    expect(match({ unordered: true }, [...overdue, 'INV-9'], overdue)).toMatchObject({
      status: 'failed',
      score: 0.75,
    });
    expect(match({ unordered: true }, [], overdue).score).toBe(0);
    expect(match({ unordered: true }, ['x'], []).score).toBe(0);
    expect(match({}, [], [])).toMatchObject({ status: 'passed', score: 1 });
  });

  it('passes at pass_at', () => {
    expect(match({ unordered: true, pass_at: 0.6 }, ['INV-1', 'INV-2'], overdue).status).toBe(
      'passed',
    );
    expect(match({ unordered: true, pass_at: 0.7 }, ['INV-1', 'INV-2'], overdue).status).toBe(
      'failed',
    );
  });

  it('compares positions when the list is ordered', () => {
    expect(match({}, ['INV-1', 'INV-3', 'INV-2'], overdue)).toMatchObject({
      status: 'failed',
      score: 0.333333,
    });
    expect(match({}, overdue, overdue).status).toBe('passed');
  });

  it('keeps inner order unless inner_unordered', () => {
    const pairs = [
      ['INV-0988', 'INV-1131'],
      ['INV-1042', 'INV-1107'],
    ];
    const answer = [
      ['INV-1107', 'INV-1042'],
      ['INV-0988', 'INV-1131'],
    ];
    expect(match({ unordered: true }, answer, pairs).score).toBe(0.5);
    expect(match({ unordered: true, inner_unordered: true }, answer, pairs)).toMatchObject({
      status: 'passed',
      score: 1,
    });
    // inner_unordered alone: the pairs' own order still matters.
    expect(match({ inner_unordered: true }, answer, pairs).score).toBe(0);
    expect(
      match(
        { inner_unordered: true },
        [
          ['INV-1131', 'INV-0988'],
          ['INV-1107', 'INV-1042'],
        ],
        pairs,
      ).status,
    ).toBe('passed');
  });

  it('gives object items partial credit and pairs them by best credit', () => {
    const expected = [
      { invoice: 'INV-1', fee: 2 },
      { invoice: 'INV-2', fee: 3 },
    ];
    const observed = [
      { invoice: 'INV-2', fee: 3 },
      { invoice: 'INV-1', fee: 9 },
    ];
    expect(match({ unordered: true }, observed, expected)).toMatchObject({
      status: 'failed',
      score: 0.75,
      comment: '1 of 2 items match exactly (2 items)',
    });
  });

  it('pairs optimally, so the score does not depend on item order', () => {
    // A greedy pass pairs o1 with e1 (first of two ties) and leaves o2 with e2: 2/3 + 1/3.
    const e1 = { a: 1, b: 1, c: 1 };
    const e2 = { a: 1, b: 1, c: 2 };
    const o1 = { a: 1, b: 1, c: 3 };
    const o2 = { a: 1, b: 9, c: 1 };
    const best = (2 / 3 + 2 / 3) / 2;
    expect(match({ unordered: true }, [o1, o2], [e1, e2]).score).toBeCloseTo(best, 6);
    expect(match({ unordered: true }, [o2, o1], [e2, e1]).score).toBeCloseTo(best, 6);
  });

  it('leaves excluded keys out of list items', () => {
    const expected = [{ invoice: 'INV-1', note: 'late' }];
    expect(
      match({ exclude_keys: ['note'] }, [{ invoice: 'INV-1', note: 'x' }], expected).status,
    ).toBe('passed');
    expect(match({}, [{ invoice: 'INV-1', note: 'x' }], expected).score).toBe(0.5);
  });

  it('pairs long lists optimally where many items tie', () => {
    // Every wrong item shares `v` with a seventh of the others, so greedy pairing undercounts.
    const expected = Array.from({ length: 250 }, (_, i) => ({ id: i, v: i % 7 }));
    const observed = expected.map((e) => ({ ...e, v: (e.v + 1) % 7 })).reverse();
    const result = match({ unordered: true }, observed, expected);
    expect(result.status).toBe('failed');
    expect(result.score).toBeCloseTo(0.5, 6);
  });

  it('copes with lists past the assignment cap', () => {
    const expected = Array.from({ length: 600 }, (_, i) => ({ id: i, v: i * 10 }));
    const observed = expected.map((e) => ({ ...e, v: e.v + 1 })).reverse();
    const result = match({ unordered: true }, observed, expected);
    expect(result.score).toBeCloseTo(0.5, 6);
  });
});

describe('json_match on objects', () => {
  const expected = { 'ACME ': 120.5, Globex: 80, Initech: 0 };

  it('scores the fraction of keys of either side that match', () => {
    expect(match({}, { 'ACME ': 120.5, Globex: 80, Initech: 0 }, expected)).toMatchObject({
      status: 'passed',
      score: 1,
      comment: 'all 3 keys match',
    });
    expect(match({}, { ACME: 120.5, Globex: 80, Initech: 0 }, expected)).toMatchObject({
      status: 'failed',
      score: 0.5,
      comment: '2 of 4 keys match; differs: ACME, ACME ',
    });
    expect(match({}, { 'ACME ': 120.5, Globex: 80, Initech: 0, Extra: 1 }, expected).score).toBe(
      0.75,
    );
  });

  it('leaves out excluded keys on both sides', () => {
    expect(
      match(
        { exclude_keys: ['Initech', 'note'] },
        { 'ACME ': 120.5, Globex: 80, note: 'hi' },
        expected,
      ).status,
    ).toBe('passed');
  });

  it('compares values by deep equality, with unordered lists under the keys', () => {
    expect(match({}, { band: { net: 1, vat: 0 } }, { band: { vat: 0, net: 1 } }).status).toBe(
      'passed',
    );
    expect(match({}, { ids: [2, 1] }, { ids: [1, 2] }).status).toBe('failed');
    expect(match({ unordered: true }, { ids: [2, 1] }, { ids: [1, 2] }).status).toBe('passed');
    expect(match({ unordered: true }, { ids: [[2, 1]] }, { ids: [[1, 2]] }).status).toBe('failed');
    expect(
      match({ unordered: true, inner_unordered: true }, { ids: [[2, 1]] }, { ids: [[1, 2]] })
        .status,
    ).toBe('passed');
    expect(match({}, { n: '1' }, { n: 1 }).status).toBe('failed');
  });

  it('treats two empty objects as equal', () => {
    expect(match({}, {}, {}).score).toBe(1);
  });
});

describe('json_match on other values', () => {
  it('fails a value of the wrong kind with a score of 0', () => {
    expect(match({}, { a: 1 }, [1])).toMatchObject({
      status: 'failed',
      score: 0,
      comment: 'expected a list, got an object',
    });
    expect(match({}, [1], { a: 1 })).toMatchObject({
      score: 0,
      comment: 'expected an object, got a list',
    });
    expect(match({}, null, { a: 1 }).comment).toBe('expected an object, got null');
  });

  it('compares scalars for equality', () => {
    expect(match({}, 'x', 'x')).toMatchObject({ status: 'passed', score: 1, comment: 'equal' });
    expect(match({}, 1, 2)).toMatchObject({ status: 'failed', score: 0, comment: 'differs' });
  });
});

describe('canonicalText', () => {
  it('sorts keys always and lists only where asked', () => {
    const order = (here: boolean, inner: boolean) => ({ here, inner });
    expect(canonicalText({ b: [2, 1], a: 1 }, order(false, false))).toBe('{"a":1,"b":[2,1]}');
    expect(canonicalText({ b: [2, 1], a: 1 }, order(true, false))).toBe('{"a":1,"b":[1,2]}');
    expect(canonicalText([[2, 1]], order(true, false))).toBe('[[2,1]]');
    expect(canonicalText([[2, 1]], order(false, true))).toBe('[[1,2]]');
  });
});

describe('maxCreditAssignment', () => {
  it('finds the best pairing where a greedy choice would not', () => {
    expect(
      maxCreditAssignment([
        [2 / 3, 2 / 3],
        [2 / 3, 0],
      ]),
    ).toEqual([1, 0]);
  });

  it('pairs a short side into a long one', () => {
    expect(maxCreditAssignment([[0, 0, 1]])).toEqual([2]);
    expect(maxCreditAssignment([])).toEqual([]);
    expect(() => maxCreditAssignment([[1], [1]])).toThrow(RangeError);
  });
});

describe('json_match with unusual keys', () => {
  it('treats a __proto__ key as an ordinary key', () => {
    const expected = JSON.parse('[{"__proto__": 1, "id": "a"}]') as JsonValue;
    const same = JSON.parse('[{"__proto__": 1, "id": "a", "note": "x"}]') as JsonValue;
    const other = JSON.parse('[{"__proto__": 2, "id": "a"}]') as JsonValue;
    expect(match({ unordered: true, exclude_keys: ['note'] }, same, expected).score).toBe(1);
    expect(match({ unordered: true }, other, expected).score).toBe(0.5);
  });
});
