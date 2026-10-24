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
 */
import type { JsonMatchParams, JsonValue } from '@hermes-evals/shared';
import { graded, type ScorerResult } from './result.js';

type JsonObject = { [key: string]: JsonValue };

interface MatchOptions {
  /** Sort lists that have no list ancestor. */
  outer: boolean;
  /** Sort lists inside a list. */
  inner: boolean;
  exclude: ReadonlySet<string>;
}

const isObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const kind = (value: JsonValue): string =>
  value === null
    ? 'null'
    : Array.isArray(value)
      ? 'a list'
      : isObject(value)
        ? 'an object'
        : typeof value;

/** Which lists compare as multisets: this one (`here`) and every list inside a list (`inner`). */
export interface ListOrder {
  here: boolean;
  inner: boolean;
}

/**
 * Canonical text of a value: object keys sorted, and a list sorted by its
 * items' canonical text when the order says it is a multiset. Two values are
 * equal under the options exactly when their texts are equal.
 */
export function canonicalText(value: JsonValue, order: ListOrder): string {
  if (Array.isArray(value)) {
    const inside: ListOrder = { here: order.inner, inner: order.inner };
    const items = value.map((item) => canonicalText(item, inside));
    if (order.here) items.sort();
    return `[${items.join(',')}]`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalText(value[k]!, order)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

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

const filled = <T>(length: number, value: T): T[] => Array.from({ length }, () => value);

/**
 * Maximum-credit pairing of rows to columns (Hungarian method with
 * potentials), rows ≤ columns. Returns the column of each row.
 */
export function maxCreditAssignment(credit: number[][]): number[] {
  const n = credit.length;
  const m = n === 0 ? 0 : credit[0]!.length;
  if (n > m) throw new RangeError('more rows than columns');
  const INF = Number.POSITIVE_INFINITY;
  // 1-based arrays, as in the textbook form; cost = 1 − credit.
  const u = filled(n + 1, 0);
  const v = filled(m + 1, 0);
  const owner = filled(m + 1, 0);
  const way = filled(m + 1, 0);
  for (let i = 1; i <= n; i++) {
    owner[0] = i;
    let j0 = 0;
    const minv = filled(m + 1, INF);
    const used = filled(m + 1, false);
    do {
      used[j0] = true;
      const i0 = owner[j0]!;
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = 1 - credit[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[owner[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      j0 = j1;
    } while (owner[j0] !== 0);
    do {
      const j1 = way[j0]!;
      owner[j0] = owner[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const result = filled(n, -1);
  for (let j = 1; j <= m; j++) if (owner[j]! > 0) result[owner[j]! - 1] = j - 1;
  return result;
}

/** Pairs by highest credit first, ties by position: the fallback for very long lists. */
function greedyAssignment(credit: number[][]): number[] {
  const cells: Array<[number, number, number]> = [];
  credit.forEach((row, i) => row.forEach((c, j) => cells.push([c, i, j])));
  cells.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  const result = filled(credit.length, -1);
  const taken = new Set<number>();
  for (const [, i, j] of cells) {
    if (result[i] !== -1 || taken.has(j)) continue;
    result[i] = j;
    taken.add(j);
  }
  return result;
}

interface ListMatch {
  credit: number;
  /** Items paired with full credit. */
  exact: number;
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
  let exact = 0;
  observed.forEach((item, i) => {
    const slots = pool.get(itemIdentity(item, options));
    if (slots && slots.length > 0) {
      slots.shift();
      exact += 1;
    } else {
      restObserved.push(i);
    }
  });
  const restExpected = [...pool.values()].flat().sort((a, b) => a - b);
  if (restObserved.length === 0 || restExpected.length === 0) return { credit: exact, exact };

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
  let partial = 0;
  pairing.forEach((col, row) => {
    if (col >= 0) partial += credit[row]![col]!;
  });
  return { credit: exact + partial, exact };
}

function matchOrdered(
  observed: JsonValue[],
  expected: JsonValue[],
  options: MatchOptions,
): ListMatch {
  let credit = 0;
  let exact = 0;
  for (let i = 0; i < Math.min(observed.length, expected.length); i++) {
    const c = itemCredit(observed[i]!, expected[i]!, options);
    credit += c;
    if (c === 1) exact += 1;
  }
  return { credit, exact };
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
  const detail = { observed, expected };
  // Judged on the stored (rounded) score, so the row's score and status always agree.
  const result = (score: number, comment: string) => {
    const stored = round(score);
    return graded(stored >= params.pass_at, stored, comment, detail);
  };

  if (Array.isArray(expected)) {
    if (!Array.isArray(observed)) return result(0, `expected a list, got ${kind(observed)}`);
    if (expected.length === 0 && observed.length === 0) return result(1, 'both lists are empty');
    const match = options.outer
      ? matchUnordered(observed, expected, options)
      : matchOrdered(observed, expected, options);
    const score = match.credit / Math.max(observed.length, expected.length);
    const sizes =
      observed.length === expected.length
        ? `${expected.length} items`
        : `expected ${expected.length} items, got ${observed.length}`;
    return result(score, `${match.exact} of ${expected.length} items match exactly (${sizes})`);
  }

  if (isObject(expected)) {
    if (!isObject(observed)) return result(0, `expected an object, got ${kind(observed)}`);
    const fraction = keyFraction(observed, expected, options.outer, options);
    const comment =
      fraction.differing.length === 0
        ? `all ${fraction.total} keys match`
        : `${fraction.matched} of ${fraction.total} keys match; differs: ${listKeys(fraction.differing)}`;
    return result(fractionOf(fraction), comment);
  }

  const root: ListOrder = { here: options.outer, inner: options.inner };
  const same = canonicalText(observed, root) === canonicalText(expected, root);
  return result(same ? 1 : 0, same ? 'equal' : 'differs');
}
