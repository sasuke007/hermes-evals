/**
 * json_match's evidence key by key (Phase 5 section 6.1, Phase 7;
 * RunInspectorStates "✓ Fjord Software 3", "✗ Granite Office expected 2,
 * got 3"): every key of the compared object, or every item of the compared
 * list, with both sides' values there and whether the matcher counted them
 * equal. One level deep only, so the entries hold no more than the compared
 * values the score row already keeps; the mismatch paths
 * (json-match-paths.ts) go deeper.
 *
 * Order: the reference's keys or items in its order, then what only the
 * answer has, in the answer's order. Paths are json-match-paths' notation,
 * relative to the compared value: a key (`Granite Office`, `["a.b"]`), the
 * reference's index (`[2]`) for a reference item, the answer's index for an
 * answer item paired with nothing, and '' for a compared value that is no
 * object or list. Keys `exclude_keys` leaves out are not listed.
 *
 * Reporting only: the score comes from the matcher, never from these.
 */
import type { JsonMatchEntry, JsonValue } from '@hermes-evals/shared';
import type { JsonObject } from './json-canonical.js';
import { indexPath, keyPath } from './json-match-paths.js';

/**
 * Entries kept at most, the reference's first. A list that long is far past
 * what the inspector's table shows; the counts still say how many there are.
 */
export const MAX_ENTRIES = 1_000;

const capped = (entries: JsonMatchEntry[]): JsonMatchEntry[] => entries.slice(0, MAX_ENTRIES);

/**
 * An object compared key by key: `differing` are the keys the matcher
 * counted as different (keyFraction). `observed` is null when the answer is
 * no object, so every reference key is missing from it.
 */
export function keyEntries(
  observed: JsonObject | null,
  expected: JsonObject,
  differing: ReadonlySet<string>,
  exclude: ReadonlySet<string>,
): JsonMatchEntry[] {
  const entries: JsonMatchEntry[] = [];
  for (const key of Object.keys(expected)) {
    if (exclude.has(key)) continue;
    const answered = observed !== null && Object.hasOwn(observed, key);
    entries.push({
      path: keyPath('', key),
      expected: expected[key]!,
      ...(answered ? { observed: observed[key]! } : {}),
      match: answered && !differing.has(key),
    });
  }
  if (observed !== null) {
    for (const key of Object.keys(observed)) {
      if (exclude.has(key) || Object.hasOwn(expected, key)) continue;
      entries.push({ path: keyPath('', key), observed: observed[key]!, match: false });
    }
  }
  return capped(entries);
}

/** How the matcher paired a list's items: [answer index, reference index], and which pairs fell short. */
export interface ItemPairing {
  pairs: ReadonlyArray<readonly [number, number]>;
  /** Pairs short of full credit, as [answer index, reference index]. */
  partial: ReadonlyArray<readonly [number, number]>;
}

/**
 * A list compared item by item. `observed` is null when the answer is no
 * list, so every reference item is missing from it.
 */
export function itemEntries(
  observed: readonly JsonValue[] | null,
  expected: readonly JsonValue[],
  pairing: ItemPairing,
): JsonMatchEntry[] {
  const partner = new Map(pairing.pairs.map(([i, j]) => [j, i]));
  const short = new Set(pairing.partial.map(([, j]) => j));
  const entries: JsonMatchEntry[] = expected.map((item, j) => {
    const i = observed === null ? undefined : partner.get(j);
    return {
      path: indexPath('', j),
      expected: item,
      ...(i !== undefined ? { observed: observed![i]! } : {}),
      match: i !== undefined && !short.has(j),
    };
  });
  if (observed !== null) {
    const paired = new Set(pairing.pairs.map(([i]) => i));
    observed.forEach((item, i) => {
      if (!paired.has(i)) entries.push({ path: indexPath('', i), observed: item, match: false });
    });
  }
  return capped(entries);
}

/** A compared value that is no object or list: one entry at the value itself. */
export const valueEntries = (
  observed: JsonValue,
  expected: JsonValue,
  match: boolean,
): JsonMatchEntry[] => [{ path: '', expected, observed, match }];
