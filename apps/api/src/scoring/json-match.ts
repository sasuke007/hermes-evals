/**
 * json_match (plan 9.3): the share of the reference the answer gets right,
 * passing at `pass_at` (default 1, everything).
 *
 * The score follows openevals' json match with average aggregation: an object
 * scores the fraction of keys (of either side, minus `exclude_keys`) whose
 * values are equal; a list scores the summed credit of its paired items over
 * the longer list's length, where an object item earns its own key fraction
 * and any other item 1 or 0. Values inside a key or an item compare by deep
 * equality, without partial credit.
 *
 * Why not openevals' createJsonMatchEvaluator itself: it scores only objects
 * and lists of objects (it reads any other item through Object.entries, so a
 * string becomes its characters and a pair its positions); it pairs list
 * items greedily, so the score of a partial answer depends on item order;
 * and every call goes through LangSmith's traceable wrapper, which uploads
 * inputs when tracing variables are set. This matcher keeps its scoring and
 * drops those three.
 *
 * Order: `unordered` compares as multisets the lists that sit in no other
 * list (the compared value itself, or lists under its keys); `inner_unordered`
 * does the same for every list inside a list, such as the pairs in
 * `[["INV-1", "INV-2"]]`. A multiset list pairs exact matches first and the
 * rest by an optimal assignment, so the score never depends on order.
 *
 * Evidence (`evidence.json_match`, Part B): the counts the comment gives (for
 * a list, the reference's items matched exactly; for an object, the keys that
 * match; for any other value, 1 or 0) and the path of each mismatch
 * (json-match-paths.ts), so the run inspector can explain a fractional score.
 * Since Phase 7 also the answer path compared (`path`) and every key or item
 * with both values (`entries`, json-match-entries.ts).
 */
import type { JsonMatchEvidence, JsonMatchParams, JsonValue } from '@hermes-evals/shared';
import { canonicalText, isObject, type JsonObject, type ListOrder } from './json-canonical.js';
import { greedyAssignment, maxCreditAssignment } from './json-match-assignment.js';
import { itemEntries, keyEntries, valueEntries } from './json-match-entries.js';
import { collectDifferences, indexPath, keyPath, MismatchPaths } from './json-match-paths.js';
import { graded, type ScorerResult } from './result.js';

export { maxCreditAssignment } from './json-match-assignment.js';
export { canonicalText, type ListOrder } from './json-canonical.js';

interface MatchOptions {
  /** Sort lists that have no list ancestor. */
  outer: boolean;
  /** Sort lists inside a list. */
  inner: boolean;
  exclude: ReadonlySet<string>;
}

const kind = (value: JsonValue): string =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'a list'
      : isObject(value)
        ? 'an object'
        : typeof value;

interface KeyFraction {
  matched: number;
  total: number;
  differing: string[];
}

/** Keys of either object, minus excluded ones, whose values are equal. */
function keyFraction(
  observed: JsonObject,
  expected: JsonObject,
  sortLists: boolean,
  options: MatchOptions,
): KeyFraction {
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(observed)])]
    .filter((k) => !options.exclude.has(k))
    .sort();
  const differing: string[] = [];
  for (const key of keys) {
    const same =
      Object.hasOwn(observed, key) &&
      Object.hasOwn(expected, key) &&
      canonicalText(observed[key]!, { here: sortLists, inner: options.inner }) ===
        canonicalText(expected[key]!, { here: sortLists, inner: options.inner });
    if (!same) differing.push(key);
  }
  return { matched: keys.length - differing.length, total: keys.length, differing };
}

const fractionOf = (f: KeyFraction): number => (f.total === 0 ? 1 : f.matched / f.total);

/** Credit for pairing two items of a list: inside a list, every nested list is inner. */
function itemCredit(observed: JsonValue, expected: JsonValue, options: MatchOptions): number {
  if (isObject(observed) && isObject(expected)) {
    return fractionOf(keyFraction(observed, expected, options.inner, options));
  }
  const inside: ListOrder = { here: options.inner, inner: options.inner };
  return canonicalText(observed, inside) === canonicalText(expected, inside) ? 1 : 0;
}

/** The text two items share exactly when they earn full credit together. */
function itemIdentity(item: JsonValue, options: MatchOptions): string {
  const inside: ListOrder = { here: options.inner, inner: options.inner };
  if (!isObject(item)) return canonicalText(item, inside);
  // fromEntries defines own properties, so a `__proto__` key stays a key.
  const kept: JsonObject = Object.fromEntries(
    Object.entries(item).filter(([k]) => !options.exclude.has(k)),
  );
  return canonicalText(kept, inside);
}

/**
 * Unmatched remainders larger than this (500 × 500, about half a second) are
 * paired greedily instead, which can undercount partial credit; answers that
 * long are unusual, and exact matches are always paired first.
 */
const MAX_ASSIGNMENT_CELLS = 250_000;

interface ListMatch {
  credit: number;
  /** Items paired with full credit. */
  exact: number;
  /** Every pair, full credit or not, as [answer index, reference index]. */
  pairs: Array<[number, number]>;
  /** Pairs short of full credit, as [answer index, reference index]. */
  partial: Array<[number, number]>;
  /** Reference items paired with nothing. */
  missing: number[];
  /** Answer items paired with nothing. */
  extra: number[];
}

/** Pairs a multiset list: exact matches first, then the best assignment of the rest. */
function matchUnordered(
  observed: JsonValue[],
  expected: JsonValue[],
  options: MatchOptions,
): ListMatch {
  const pool = new Map<string, number[]>();
  expected.forEach((item, j) => {
    const id = itemIdentity(item, options);
    pool.set(id, [...(pool.get(id) ?? []), j]);
  });
  const restObserved: number[] = [];
  const pairs: Array<[number, number]> = [];
  let exact = 0;
  observed.forEach((item, i) => {
    const slots = pool.get(itemIdentity(item, options));
    if (slots && slots.length > 0) {
      pairs.push([i, slots.shift()!]);
      exact += 1;
    } else {
      restObserved.push(i);
    }
  });
  const restExpected = [...pool.values()].flat().sort((a, b) => a - b);
  if (restObserved.length === 0 || restExpected.length === 0) {
    return { credit: exact, exact, pairs, partial: [], missing: restExpected, extra: restObserved };
  }

  // Rows are the shorter side, as the assignment requires.
  const observedRows = restObserved.length <= restExpected.length;
  const rows = observedRows ? restObserved : restExpected;
  const cols = observedRows ? restExpected : restObserved;
  const credit = rows.map((r) =>
    cols.map((c) =>
      observedRows
        ? itemCredit(observed[r]!, expected[c]!, options)
        : itemCredit(observed[c]!, expected[r]!, options),
    ),
  );
  const pairing =
    rows.length * cols.length <= MAX_ASSIGNMENT_CELLS
      ? maxCreditAssignment(credit)
      : greedyAssignment(credit);
  let partialCredit = 0;
  const partial: Array<[number, number]> = [];
  const paired = new Set<number>();
  const unpairedRows: number[] = [];
  pairing.forEach((col, row) => {
    if (col < 0) {
      unpairedRows.push(rows[row]!);
      return;
    }
    paired.add(col);
    const c = credit[row]![col]!;
    partialCredit += c;
    const pair: [number, number] = observedRows
      ? [rows[row]!, cols[col]!]
      : [cols[col]!, rows[row]!];
    pairs.push(pair);
    if (c < 1) partial.push(pair);
  });
  const unpairedCols = cols.filter((_, col) => !paired.has(col));
  return {
    credit: exact + partialCredit,
    exact,
    pairs,
    partial,
    missing: observedRows ? unpairedCols : unpairedRows,
    extra: observedRows ? unpairedRows : unpairedCols,
  };
}

function matchOrdered(
  observed: JsonValue[],
  expected: JsonValue[],
  options: MatchOptions,
): ListMatch {
  let credit = 0;
  let exact = 0;
  const partial: Array<[number, number]> = [];
  const pairs: Array<[number, number]> = [];
  const shared = Math.min(observed.length, expected.length);
  for (let i = 0; i < shared; i++) {
    pairs.push([i, i]);
    const c = itemCredit(observed[i]!, expected[i]!, options);
    credit += c;
    if (c === 1) exact += 1;
    else partial.push([i, i]);
  }
  const from = (start: number, end: number) =>
    Array.from({ length: Math.max(0, end - start) }, (_, k) => start + k);
  return {
    credit,
    exact,
    pairs,
    partial,
    missing: from(shared, expected.length),
    extra: from(shared, observed.length),
  };
}

/**
 * Where an item, or the compared object itself, differs: under each key the
 * key fraction counted as differing, or the item itself when it is no object.
 */
function itemDifferences(
  observed: JsonValue,
  expected: JsonValue,
  sortLists: boolean,
  options: MatchOptions,
  path: string,
  out: MismatchPaths,
): void {
  const order: ListOrder = { here: sortLists, inner: options.inner };
  if (!isObject(observed) || !isObject(expected)) {
    collectDifferences(observed, expected, order, path, out);
    return;
  }
  for (const key of keyFraction(observed, expected, sortLists, options).differing) {
    const at = keyPath(path, key);
    if (Object.hasOwn(observed, key) && Object.hasOwn(expected, key)) {
      collectDifferences(observed[key]!, expected[key]!, order, at, out);
    } else {
      out.add(at);
    }
  }
}

/**
 * A list's mismatches in reference order: each imperfect pair under the
 * reference item's index, each reference item with no partner, then the
 * answer's extras past the reference's end.
 */
function listMismatches(
  observed: JsonValue[],
  expected: JsonValue[],
  match: ListMatch,
  options: MatchOptions,
): string[] {
  const out = new MismatchPaths();
  const partner = new Map(match.partial.map(([i, j]) => [j, i]));
  const missing = new Set(match.missing);
  for (let j = 0; j < expected.length && !out.full; j++) {
    const i = partner.get(j);
    if (i !== undefined) {
      itemDifferences(observed[i]!, expected[j]!, options.inner, options, indexPath('', j), out);
    } else if (missing.has(j)) {
      out.add(indexPath('', j));
    }
  }
  match.extra.forEach((_, k) => out.add(indexPath('', expected.length + k)));
  return out.paths;
}

const round = (score: number): number => Math.round(score * 1e6) / 1e6;

const listKeys = (keys: string[]): string =>
  keys.length <= 5 ? keys.join(', ') : `${keys.slice(0, 5).join(', ')} and ${keys.length - 5} more`;

export function scoreJsonMatch(
  params: JsonMatchParams,
  observed: JsonValue,
  expected: JsonValue,
): ScorerResult {
  const options: MatchOptions = {
    outer: params.unordered ?? false,
    inner: params.inner_unordered ?? false,
    exclude: new Set(params.exclude_keys ?? []),
  };
  // Judged on the stored (rounded) score, so the row's score and status always agree.
  // The evidence repeats the comment's counts with the path of each mismatch (Part B).
  const result = (score: number, comment: string, evidence: JsonMatchEvidence) => {
    const stored = round(score);
    return graded(stored >= params.pass_at, stored, comment, {
      observed,
      expected,
      // The compared answer path (the loader already applied answer.path to the primary).
      evidence: { json_match: { ...evidence, path: params.path ?? null } },
    });
  };

  if (Array.isArray(expected)) {
    const items = (
      matched: number,
      entries: JsonMatchEvidence['entries'],
      mismatches: string[] = [],
    ): JsonMatchEvidence => ({
      unit: 'items',
      matched,
      total: expected.length,
      mismatches,
      entries,
    });
    if (!Array.isArray(observed)) {
      const none = itemEntries(null, expected, { pairs: [], partial: [] });
      return result(0, `expected a list, got ${kind(observed)}`, items(0, none));
    }
    if (expected.length === 0 && observed.length === 0) {
      return result(1, 'both lists are empty', items(0, []));
    }
    const match = options.outer
      ? matchUnordered(observed, expected, options)
      : matchOrdered(observed, expected, options);
    const score = match.credit / Math.max(observed.length, expected.length);
    const sizes =
      observed.length === expected.length
        ? `${expected.length} items`
        : `expected ${expected.length} items, got ${observed.length}`;
    return result(
      score,
      `${match.exact} of ${expected.length} items match exactly (${sizes})`,
      items(
        match.exact,
        itemEntries(observed, expected, match),
        listMismatches(observed, expected, match, options),
      ),
    );
  }

  if (isObject(expected)) {
    if (!isObject(observed)) {
      const total = Object.keys(expected).filter((k) => !options.exclude.has(k)).length;
      return result(0, `expected an object, got ${kind(observed)}`, {
        unit: 'keys',
        matched: 0,
        total,
        mismatches: [],
        entries: keyEntries(null, expected, new Set(), options.exclude),
      });
    }
    const fraction = keyFraction(observed, expected, options.outer, options);
    const comment =
      fraction.differing.length === 0
        ? `all ${fraction.total} keys match`
        : `${fraction.matched} of ${fraction.total} keys match; differs: ${listKeys(fraction.differing)}`;
    const out = new MismatchPaths();
    itemDifferences(observed, expected, options.outer, options, '', out);
    return result(fractionOf(fraction), comment, {
      unit: 'keys',
      matched: fraction.matched,
      total: fraction.total,
      mismatches: out.paths,
      entries: keyEntries(observed, expected, new Set(fraction.differing), options.exclude),
    });
  }

  const root: ListOrder = { here: options.outer, inner: options.inner };
  const same = canonicalText(observed, root) === canonicalText(expected, root);
  return result(same ? 1 : 0, same ? 'equal' : 'differs', {
    unit: 'value',
    matched: same ? 1 : 0,
    total: 1,
    mismatches: [],
    entries: valueEntries(observed, expected, same),
  });
}
