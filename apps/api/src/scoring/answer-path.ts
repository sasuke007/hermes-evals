/**
 * Paths into an answer or a reference: dotted object keys plus `[n]` list
 * indices, e.g. `totals.vat`, `duplicates[0]`, `bands[2].net`, `[0]`. A key
 * segment reads only a plain object and an index reads only a list, so
 * `items.0` never silently means `items[0]`.
 */
import type { JsonValue } from '@hermes-evals/shared';

export type PathSegment = { key: string } | { index: number };

export class AnswerPathError extends Error {}

/** Parses a path; throws AnswerPathError on a malformed one (`a..b`, `a[x]`, `a[`). */
export function parseAnswerPath(path: string): PathSegment[] {
  const segments: PathSegment[] = [];
  const pattern = /([^.[\]]+)|\[(\d+)\]|(\.)/gy;
  let expectKey = true;
  let match: RegExpExecArray | null;
  while (pattern.lastIndex < path.length && (match = pattern.exec(path))) {
    if (match[1] !== undefined) {
      if (!expectKey) throw new AnswerPathError(`invalid path ${path}: missing '.'`);
      segments.push({ key: match[1] });
      expectKey = false;
    } else if (match[2] !== undefined) {
      if (expectKey && segments.length > 0) {
        throw new AnswerPathError(`invalid path ${path}: '[' after '.'`);
      }
      segments.push({ index: Number(match[2]) });
      expectKey = false;
    } else {
      if (expectKey) throw new AnswerPathError(`invalid path ${path}: empty key`);
      expectKey = true;
    }
  }
  if (pattern.lastIndex !== path.length || segments.length === 0 || expectKey) {
    throw new AnswerPathError(`invalid path ${path}`);
  }
  return segments;
}

export type PathLookup = { found: true; value: JsonValue } | { found: false };

const isPlainObject = (value: JsonValue): value is { [key: string]: JsonValue } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The value at `path`, or not found. No path means the whole value. */
export function resolveAnswerPath(value: JsonValue, path: string | undefined): PathLookup {
  if (path === undefined) return { found: true, value };
  let node = value;
  for (const segment of parseAnswerPath(path)) {
    if ('key' in segment) {
      if (!isPlainObject(node) || !Object.hasOwn(node, segment.key)) return { found: false };
      node = node[segment.key]!;
    } else {
      if (!Array.isArray(node) || segment.index >= node.length) return { found: false };
      node = node[segment.index]!;
    }
  }
  return { found: true, value: node };
}

/** `totals.vat`, or `the root` when the whole answer is compared. */
export const describePath = (path: string | undefined): string => path ?? 'the root';
