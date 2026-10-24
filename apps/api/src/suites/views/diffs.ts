/**
 * The diffs Task diff shows between two versions of a task (plan 4.5):
 * prompt.md and task.yaml as line diffs, reference.json as a list of changed
 * JSON paths.
 */
import { diffArrays } from 'diff';
import type { JsonDiffEntry, JsonValue, TextDiffLine } from '@hermes-evals/shared';

/**
 * Line diff of two texts. Every line of both sides appears once, with its line
 * number on the side(s) it belongs to; within a changed block the removed
 * lines come before the added ones. A final newline does not add an empty line.
 */
export function textDiff(before: string | null, after: string | null): TextDiffLine[] {
  const out: TextDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const change of diffArrays(splitLines(before), splitLines(after))) {
    for (const text of change.value) {
      if (change.removed) out.push({ kind: 'removed', text, oldLine: oldLine++, newLine: null });
      else if (change.added) out.push({ kind: 'added', text, oldLine: null, newLine: newLine++ });
      else out.push({ kind: 'same', text, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return out;
}

function splitLines(text: string | null): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * Differences between two JSON values as paths, e.g. `total_due` or
 * `duplicates[1][0]`. Objects are compared key by key and arrays index by
 * index, so a value that moved shows as changed at each index it touched.
 * A change of kind (object, array or scalar) is reported at that path whole.
 * The root itself is `$`.
 */
export function jsonDiff(before: JsonValue, after: JsonValue): JsonDiffEntry[] {
  const out: JsonDiffEntry[] = [];
  walk(before, after, '', out);
  return out;
}

function walk(before: JsonValue, after: JsonValue, path: string, out: JsonDiffEntry[]): void {
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let i = 0; i < length; i++) {
      const child = `${path}[${i}]`;
      if (i >= after.length)
        out.push({ path: child, kind: 'removed', before: before[i]!, after: null });
      else if (i >= before.length)
        out.push({ path: child, kind: 'added', before: null, after: after[i]! });
      else walk(before[i]!, after[i]!, child, out);
    }
    return;
  }
  if (isObject(before) && isObject(after)) {
    const keys = [
      ...Object.keys(before),
      ...Object.keys(after).filter((k) => !Object.hasOwn(before, k)),
    ];
    for (const key of keys) {
      const child = childPath(path, key);
      if (!Object.hasOwn(after, key))
        out.push({ path: child, kind: 'removed', before: before[key]!, after: null });
      else if (!Object.hasOwn(before, key))
        out.push({ path: child, kind: 'added', before: null, after: after[key]! });
      else walk(before[key]!, after[key]!, child, out);
    }
    return;
  }
  if (!sameJson(before, after)) out.push({ path: path || '$', kind: 'changed', before, after });
}

/** `a.b` for identifier keys, `a["INV-1031"]` for any other key. */
function childPath(path: string, key: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return path ? `${path}.${key}` : key;
  return `${path}[${JSON.stringify(key)}]`;
}

const isObject = (value: JsonValue): value is { [key: string]: JsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Deep equality of two JSON values; object key order does not matter. */
export function sameJson(a: JsonValue, b: JsonValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameJson(item, b[i]!))
    );
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && sameJson(a[k]!, b[k]!))
    );
  }
  return a === b;
}
