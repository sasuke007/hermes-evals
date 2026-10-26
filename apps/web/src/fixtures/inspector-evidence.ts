/**
 * json_match evidence as the scorer records it since Phase 7 (JsonMatchEvidence in
 * records.ts): what was counted, the mismatches' paths relative to the compared value, the
 * compared path, and one entry per key or item with both values. The fixtures compare by
 * position; the real scorer also pairs list items without order.
 */
import type { JsonValue } from '@hermes-evals/shared';
import type { JsonMatchEntry, JsonMatchEvidence } from '@/api/types/runs';

const isObject = (v: JsonValue | undefined): v is Record<string, JsonValue> =>
  v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);

const same = (a: JsonValue | undefined, b: JsonValue | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/** A key as json-match-paths writes it: bare, or `["a.b"]` when it needs quoting. */
const keyPath = (key: string): string =>
  /^[^.[\]"]+$/.test(key) ? key : `[${JSON.stringify(key)}]`;

function entry(path: string, expected: JsonValue | undefined, observed: JsonValue | undefined) {
  const e: JsonMatchEntry = { path, match: expected !== undefined && same(expected, observed) };
  if (expected !== undefined) e.expected = expected;
  if (observed !== undefined) e.observed = observed;
  return e;
}

/** The evidence of comparing `answer` with `reference` at `path` (null: the whole answer). */
export function jsonMatchEvidence(
  reference: JsonValue,
  answer: JsonValue,
  path: string | null,
): JsonMatchEvidence {
  let unit: JsonMatchEvidence['unit'];
  let entries: JsonMatchEntry[];
  if (Array.isArray(reference)) {
    unit = 'items';
    const got = Array.isArray(answer) ? answer : [];
    entries = reference.map((item, i) => entry(`[${i}]`, item, got[i]));
    for (let i = reference.length; i < got.length; i++) {
      entries.push(entry(`[${i}]`, undefined, got[i]));
    }
  } else if (isObject(reference)) {
    unit = 'keys';
    const got = isObject(answer) ? answer : {};
    entries = Object.keys(reference).map((k) => entry(keyPath(k), reference[k], got[k]));
    for (const k of Object.keys(got)) {
      if (!(k in reference)) entries.push(entry(keyPath(k), undefined, got[k]));
    }
  } else {
    unit = 'value';
    entries = [entry('', reference, answer)];
  }
  const counted = entries.filter((e) => e.expected !== undefined);
  return {
    unit,
    matched: counted.filter((e) => e.match).length,
    total: counted.length,
    mismatches: unit === 'value' ? [] : entries.filter((e) => !e.match).map((e) => e.path),
    path,
    entries,
  };
}
