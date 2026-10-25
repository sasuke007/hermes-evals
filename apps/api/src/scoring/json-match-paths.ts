/**
 * Where a json_match answer differs from its reference
 * (DESIGN_CHECKS_FIX_PROMPT.md Part B: "show the path of each mismatch:
 * `bands[2].net`"), so the run inspector can explain a fractional score from
 * the stored row alone.
 *
 * Paths are relative to the compared value: keys joined with `.`, list
 * indices as `[i]`. In a list compared without order, an item is named by the
 * index of the reference item it was paired with; an answer item paired with
 * nothing is an extra, named past the reference's end (`[n]`, `[n+1]`, ...)
 * as an extra item of an ordered list is. A path ends where the values stop
 * sharing a shape: a missing key, a list item with no counterpart, a value of
 * another kind, or a different scalar. Inside a key's value, a list compared
 * without order names each reference item no answer item equals, then the
 * answer's extras.
 *
 * Reporting only: the score comes from the matcher, never from these paths.
 */
import type { JsonValue } from '@hermes-evals/shared';
import { canonicalText, isObject, type ListOrder } from './json-canonical.js';

/** Enough to explain a score; a longer list would only repeat the comment's counts. */
export const MAX_MISMATCHES = 50;

/** A capped list of mismatch paths, filled while the matcher pairs keys and items. */
export class MismatchPaths {
  readonly paths: string[] = [];

  get full(): boolean {
    return this.paths.length >= MAX_MISMATCHES;
  }

  add(path: string): void {
    if (!this.full) this.paths.push(path);
  }
}

/** A key that would read ambiguously after a dot is written in brackets, as JSON. */
export const keyPath = (parent: string, key: string): string =>
  key === '' || /[.[\]"]/.test(key)
    ? `${parent}[${JSON.stringify(key)}]`
    : parent === ''
      ? key
      : `${parent}.${key}`;

export const indexPath = (parent: string, index: number): string => `${parent}[${index}]`;

/** Every path under `path` where the two values differ, by the matcher's own equality. */
export function collectDifferences(
  observed: JsonValue,
  expected: JsonValue,
  order: ListOrder,
  path: string,
  out: MismatchPaths,
): void {
  if (out.full || canonicalText(observed, order) === canonicalText(expected, order)) return;
  if (isObject(observed) && isObject(expected)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(observed)])].sort();
    for (const key of keys) {
      const at = keyPath(path, key);
      if (!Object.hasOwn(observed, key) || !Object.hasOwn(expected, key)) out.add(at);
      else collectDifferences(observed[key]!, expected[key]!, order, at, out);
    }
    return;
  }
  if (Array.isArray(observed) && Array.isArray(expected)) {
    const inside: ListOrder = { here: order.inner, inner: order.inner };
    if (order.here) {
      unpairedItems(observed, expected, inside, path, out);
      return;
    }
    const shared = Math.min(observed.length, expected.length);
    for (let i = 0; i < shared; i++) {
      collectDifferences(observed[i]!, expected[i]!, inside, indexPath(path, i), out);
    }
    for (let i = shared; i < Math.max(observed.length, expected.length); i++) {
      out.add(indexPath(path, i));
    }
    return;
  }
  out.add(path);
}

/**
 * A differing multiset list nested under a key: the reference items no
 * answer item equals, then the answer's extras past the reference's end.
 */
function unpairedItems(
  observed: JsonValue[],
  expected: JsonValue[],
  inside: ListOrder,
  path: string,
  out: MismatchPaths,
): void {
  const pool = new Map<string, number>();
  for (const item of observed) {
    const id = canonicalText(item, inside);
    pool.set(id, (pool.get(id) ?? 0) + 1);
  }
  let extras = observed.length;
  expected.forEach((item, j) => {
    const id = canonicalText(item, inside);
    const left = pool.get(id) ?? 0;
    if (left > 0) {
      pool.set(id, left - 1);
      extras -= 1;
    } else {
      out.add(indexPath(path, j));
    }
  });
  for (let k = 0; k < extras; k++) out.add(indexPath(path, expected.length + k));
}
