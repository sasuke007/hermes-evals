/**
 * YAML files as the loader reads them: parsed with positions, so an error
 * can say where it is (line, column, and the lines around it), and a schema
 * issue on a parsed value can be traced back to the line it came from.
 *
 * The excerpt is stored on suite_sources.last_error as plain text, one line
 * per source line: `  12 | text`, `> 14 | text` for the failing line, then a
 * caret line under the column. The read API turns it back into
 * SuiteLoadErrorView lines; the reload result builds the view directly.
 */
import { isMap, isPair, isScalar, isSeq, LineCounter, parseDocument, type Document } from 'yaml';
import type { z } from 'zod';
import type { SuiteLoadError, SuiteLoadErrorView } from '@hermes-evals/shared';

/** Lines quoted before the failing one. */
const CONTEXT_LINES = 2;
/** Longest source line quoted in an excerpt. */
const MAX_EXCERPT_CHARS = 200;

export interface ExcerptLine {
  line: number | null;
  text: string;
  highlight: boolean;
}

/** An error in one file, located when its position is known. */
export interface LocatedError {
  /** Relative to the suite directory, e.g. `suite.yaml`. */
  file: string;
  line: number | null;
  column: number | null;
  message: string;
  excerpt: ExcerptLine[];
}

export interface Position {
  line: number;
  column: number;
}

export type YamlParse =
  | { ok: true; value: unknown; doc: Document.Parsed; lines: LineCounter }
  | { ok: false; error: LocatedError };

/**
 * Parses one YAML document. Duplicate keys, a second document and aliases
 * that expand too far are errors, never a silently chosen value.
 */
export function parseYamlSource(file: string, source: string): YamlParse {
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines, prettyErrors: false, uniqueKeys: true });
  const first = doc.errors[0];
  if (first) {
    const pos = lines.linePos(first.pos[0]);
    return {
      ok: false,
      error: locatedError(file, source, { line: pos.line, column: pos.col }, first.message),
    };
  }
  try {
    // maxAliasCount bounds alias expansion (a "billion laughs" document).
    return { ok: true, value: doc.toJS({ maxAliasCount: 100 }), doc, lines };
  } catch (err) {
    // An unresolved alias or an expansion over the limit.
    return { ok: false, error: locatedError(file, source, null, (err as Error).message) };
  }
}

/** An error at `pos` in `source`, with the lines around it quoted. */
export function locatedError(
  file: string,
  source: string,
  pos: Position | null,
  message: string,
): LocatedError {
  return {
    file,
    line: pos?.line ?? null,
    column: pos?.column ?? null,
    message: firstLine(message),
    excerpt: pos ? excerptAround(source, pos) : [],
  };
}

const firstLine = (text: string): string => text.split('\n', 1)[0]!.trim();

/** The failing line, the CONTEXT_LINES before it, and a caret under the column. */
export function excerptAround(source: string, pos: Position): ExcerptLine[] {
  const all = source.split(/\r?\n/);
  if (pos.line < 1 || pos.line > all.length) return [];
  const out: ExcerptLine[] = [];
  for (let n = Math.max(1, pos.line - CONTEXT_LINES); n <= pos.line; n += 1) {
    out.push({ line: n, text: clip(all[n - 1]!), highlight: n === pos.line });
  }
  const column = Math.min(Math.max(pos.column, 1), MAX_EXCERPT_CHARS);
  out.push({ line: null, text: `${' '.repeat(column - 1)}^`, highlight: false });
  return out;
}

const clip = (text: string): string =>
  text.length > MAX_EXCERPT_CHARS ? `${text.slice(0, MAX_EXCERPT_CHARS)}…` : text;

/** The excerpt as stored text: `  12 | a`, `> 14 | b`, then the caret line as is. */
export function excerptText(lines: readonly ExcerptLine[]): string | null {
  if (lines.length === 0) return null;
  const width = Math.max(...lines.map((l) => String(l.line ?? '').length));
  return lines
    .map((l) =>
      l.line === null
        ? l.text
        : `${l.highlight ? '>' : ' '} ${String(l.line).padStart(width)} | ${l.text}`,
    )
    .join('\n');
}

/** For suite_sources.last_error. */
export const toStoredError = (e: LocatedError): SuiteLoadError => ({
  file: e.file,
  line: e.line,
  column: e.column,
  message: e.message,
  excerpt: excerptText(e.excerpt),
});

/** For the reload result. */
export const toErrorView = (e: LocatedError): SuiteLoadErrorView => ({
  file: e.file,
  line: e.line,
  column: e.column,
  message: e.message,
  excerpt: e.excerpt.map((l) => ({ ...l })),
});

/** `verification[1].params.path`: dotted keys, bracketed indices, quoted odd keys. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`;
    else {
      const key = String(segment);
      out += /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)
        ? `${out ? '.' : ''}${key}`
        : `[${JSON.stringify(key)}]`;
    }
  }
  return out;
}

/**
 * Where the value at `path` was written: the key of a mapping entry, or the
 * item of a list. A path that leaves the document (a missing key) resolves to
 * the deepest node that exists, so "summary is required" points at the
 * mapping that lacks it.
 */
export function positionOf(
  doc: Document.Parsed,
  lines: LineCounter,
  path: readonly PropertyKey[],
): Position | null {
  let node: unknown = doc.contents;
  let offset: number | null = rangeStart(node);
  for (const segment of path) {
    if (isMap(node)) {
      const pair = node.items.find(
        (p) => isPair(p) && (isScalar(p.key) ? p.key.value : p.key) === segment,
      );
      if (!pair) break;
      offset = rangeStart(pair.key) ?? rangeStart(pair.value) ?? offset;
      node = pair.value;
    } else if (isSeq(node) && typeof segment === 'number') {
      const item: unknown = node.items[segment];
      if (item === undefined) break;
      offset = rangeStart(item) ?? offset;
      node = item;
    } else {
      break;
    }
  }
  if (offset === null) return null;
  const pos = lines.linePos(offset);
  return { line: pos.line, column: pos.col };
}

function rangeStart(node: unknown): number | null {
  const range = (node as { range?: unknown } | null)?.range;
  return Array.isArray(range) && typeof range[0] === 'number' ? range[0] : null;
}

/**
 * The path a zod issue points at. An unknown key is reported on its parent;
 * the key itself is the more useful place to point.
 */
export function issueTarget(issue: z.core.$ZodIssue): PropertyKey[] {
  const path = [...issue.path];
  if (issue.code === 'unrecognized_keys' && issue.keys.length > 0) path.push(issue.keys[0]!);
  return path;
}
