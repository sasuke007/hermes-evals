/**
 * The words of Try it (SA.7, SA.7a): the shared result line ("4 of 5 keys match · score
 * 0.80 · passed (needs 0.80)"), and the key-by-key, item-by-item or phrase-by-phrase rows
 * read from the result's compared values and evidence. Number within tolerance and Exact
 * text score 1 or 0, so they show no threshold.
 */
import type { JsonValue } from '@hermes-evals/shared';
import type { TryCheckResult } from '@/api/types/authoring';
import { valueAtPath as at } from './checkText';

/** A value on one line as the boards print it: `["INV-1042", "INV-1107"]`, `{ "rate": 0 }`. */
export function compact(value: JsonValue | undefined): string {
  if (value === undefined) return '—';
  return JSON.stringify(value, null, 1)
    .replace(/\n\s*/g, ' ')
    .replace(/\[ /g, '[')
    .replace(/ \]/g, ']');
}

export function scoreText(result: Pick<TryCheckResult, 'score' | 'passAt'>): string {
  if (result.score === null) return 'no score';
  const value =
    result.passAt === null ? String(Number(result.score.toFixed(2))) : result.score.toFixed(2);
  return `score ${value}`;
}

/** "what was compared · score · status (needs threshold)". */
export function resultLine(result: TryCheckResult): string {
  const needs =
    result.passAt !== null &&
    result.score !== null &&
    (result.status === 'failed' || result.type === 'json_match')
      ? ` (needs ${result.passAt.toFixed(2)})`
      : '';
  return `${result.comment} · ${scoreText(result)} · ${result.status}${needs}`;
}

/** "Against the reference: passed · score 1 on `overdue_count`". */
export function referenceLine(result: TryCheckResult): string {
  const on = result.path ? ` on \`${result.path}\`` : '';
  if (result.status === 'passed') return `${scoreText(result)}${on}`;
  return `${result.comment}`;
}

export interface DetailRow {
  label: string;
  ok: boolean;
  note: string;
}

const isObject = (v: JsonValue | undefined): v is Record<string, JsonValue> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** The rows under "Key by key", "Item by item · order ignored" or "Phrases"; [] for none. */
export function detailRows(result: TryCheckResult): { title: string; rows: DetailRow[] } {
  const text = result.evidence?.text;
  if (text) {
    return {
      title: 'Phrases',
      rows: text.items.map((i) => ({
        label: i.label,
        ok: i.found,
        note: i.found ? 'found' : 'not found',
      })),
    };
  }
  const match = result.evidence?.json_match;
  if (!match || match.unit === 'value' || result.expected === undefined)
    return { title: '', rows: [] };
  const expected = result.expected;
  const observed = result.observed;
  if (match.unit === 'items' && Array.isArray(expected)) {
    const got = Array.isArray(observed) ? observed : [];
    const unmatched = got.filter((o) => !expected.some((e) => compact(e) === compact(o)));
    const rows = expected.map((item, i) => {
      const where = got.findIndex((o) => compact(o) === compact(item));
      if (where >= 0)
        return {
          label: compact(item),
          ok: true,
          note: where === i ? 'found' : 'found (order ignored)',
        };
      const other = unmatched.shift();
      return {
        label: compact(item),
        ok: false,
        note:
          other === undefined ? 'not in the answer' : `not in the answer: got ${compact(other)}`,
      };
    });
    return { title: 'Item by item · order ignored', rows };
  }
  const nested = match.mismatches.some((p) => /[.[]/.test(p.replace(/^\[\d+\]/, '')));
  if (nested || !isObject(expected)) {
    const rows: DetailRow[] = match.mismatches.map((path) => ({
      label: path,
      ok: false,
      note: `expected ${compact(at(expected, path))}, got ${compact(at(observed, path))}`,
    }));
    if (match.matched > 0)
      rows.push({ label: `${match.matched} other keys`, ok: true, note: 'match' });
    return { title: 'Key by key · mismatches shown with their path', rows };
  }
  const got = isObject(observed) ? observed : {};
  const rows = Object.keys(expected).map((key) => {
    if (!match.mismatches.includes(key))
      return { label: key, ok: true, note: compact(expected[key]) };
    if (!(key in got)) return { label: key, ok: false, note: 'missing from the answer' };
    return {
      label: key,
      ok: false,
      note: `expected ${compact(expected[key])}, got ${compact(got[key])}`,
    };
  });
  return { title: 'Key by key', rows };
}
