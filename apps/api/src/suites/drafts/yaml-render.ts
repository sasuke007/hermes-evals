/**
 * New YAML in the canonical style of the sample suites, for the byte-stable
 * patcher (yaml-patch.ts) and new files: block mappings at the top, `[a, b]`
 * for lists of scalars, `{ a: 1 }` for small mappings inside list items (a
 * check's params), scalars plain when YAML reads them back as the same value
 * and quoted otherwise, long descriptions folded (`>-`).
 */
import { Document, Scalar, stringify } from 'yaml';

export type Path = readonly (string | number)[];

export interface PatchOptions {
  /** Paths whose new string values are written as folded block scalars (`>-`) when long. */
  folded?: (path: Path) => boolean;
  /** Paths whose new non-empty collections are written in block style, even a list of scalars. */
  block?: (path: Path) => boolean;
}

export const FLOW_WIDTH = 72;
export const FOLD_WIDTH = 80;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const isCollection = (value: unknown): boolean =>
  typeof value === 'object' && value !== null;

export const spaces = (n: number): string => ' '.repeat(n);

/** One scalar on one line: plain when YAML reads it back as the same value, else quoted. */
export function inlineScalar(value: unknown, like?: Scalar.Type, flow = false): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'string') return stringify(value).trimEnd();
  const quoted = (type: 'QUOTE_SINGLE' | 'QUOTE_DOUBLE') => {
    const node = new Scalar(value);
    node.type = value.includes('\n') ? 'QUOTE_DOUBLE' : type;
    return stringify(node, { lineWidth: 0 }).trimEnd();
  };
  if (like === 'QUOTE_SINGLE' || like === 'QUOTE_DOUBLE') return quoted(like);
  const plain = stringify(value, { lineWidth: 0, singleQuote: true }).trimEnd();
  // A block scalar cannot sit on one line; flow indicators end a plain scalar in a flow collection.
  if (/^[|>]/.test(plain) || (flow && /^[^'"].*[,[\]{}]/.test(plain))) {
    return quoted('QUOTE_SINGLE');
  }
  return plain;
}

/** A value in flow style: `{ a: 1, b: [x, y] }`. */
export function flowValue(value: unknown, pad = { map: true, seq: false }): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const body = value.map((v) => flowValue(v)).join(', ');
    return pad.seq ? `[ ${body} ]` : `[${body}]`;
  }
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    const body = keys
      .map((k) => `${inlineScalar(k, undefined, true)}: ${flowValue(value[k])}`)
      .join(', ');
    return pad.map ? `{ ${body} }` : `{${body}}`;
  }
  return inlineScalar(value, undefined, true);
}

const depthOf = (value: unknown): number =>
  Array.isArray(value)
    ? 1 + Math.max(0, ...value.map(depthOf))
    : isRecord(value)
      ? 1 + Math.max(0, ...Object.values(value).map(depthOf))
      : 0;

const hasMultiline = (value: unknown): boolean =>
  typeof value === 'string'
    ? value.includes('\n')
    : isCollection(value) && Object.values(value as object).some(hasMultiline);

/**
 * Whether a new collection is written in flow style: a list of scalars
 * always, a small mapping (two levels, one short line) only inside a list
 * item (depth 3 and more, a check's params), never a top-level section.
 */
function flows(value: unknown, depth: number): boolean {
  if (!isCollection(value)) return false;
  if (Object.keys(value as object).length === 0) return true;
  if (hasMultiline(value)) return false;
  if (Array.isArray(value) && value.every((v) => !isCollection(v))) {
    return flowValue(value).length <= FLOW_WIDTH;
  }
  return depth >= 3 && depthOf(value) <= 2 && flowValue(value).length <= FLOW_WIDTH;
}

/** A long string as a folded block scalar, its lines indented by `indent`. */
function foldedScalar(value: string, indent: number): string {
  const doc = new Document({ v: value });
  (doc.get('v', true) as Scalar).type = 'BLOCK_FOLDED';
  const text = doc.toString({ lineWidth: FOLD_WIDTH, indent: 2 });
  // "v: >-\n  line\n" → ">-\n" + lines re-indented from 2 to `indent`.
  const [header, ...lines] = text.slice('v: '.length).split('\n');
  return [header, ...lines.map((l) => (l === '' ? l : spaces(indent) + l.slice(2)))].join('\n');
}

/**
 * What follows `key:` for a new value at `path`, up to and including the
 * pair's last newline: ` value\n`, or `\n` and the block lines below it.
 */
export function afterKey(
  value: unknown,
  keyColumn: number,
  path: Path,
  options: PatchOptions,
): string {
  const depth = path.length;
  if (!isCollection(value)) {
    if (typeof value === 'string' && options.folded?.(path) && value.length > FLOW_WIDTH) {
      return ` ${foldedScalar(value, keyColumn + 2)}`;
    }
    return ` ${inlineScalar(value)}\n`;
  }
  const empty = Object.keys(value as object).length === 0;
  if (flows(value, depth) && (empty || !options.block?.(path))) return ` ${flowValue(value)}\n`;
  return `\n${blockLines(value, keyColumn + 2, path, options)}`;
}

/** A collection in block style, every line indented by `indent` and ending in a newline. */
function blockLines(value: unknown, indent: number, path: Path, options: PatchOptions): string {
  if (Array.isArray(value)) {
    return value
      .map((item, i) => `${spaces(indent)}- ${itemText(item, indent + 2, [...path, i], options)}`)
      .join('');
  }
  return Object.entries(value as Record<string, unknown>)
    .map(
      ([k, v]) =>
        `${spaces(indent)}${inlineScalar(k)}:${afterKey(v, indent, [...path, k], options)}`,
    )
    .join('');
}

/** A list item after its `- `: a scalar, a flow collection, or a mapping whose first key shares the line. */
export function itemText(
  item: unknown,
  contentIndent: number,
  path: Path,
  options: PatchOptions,
): string {
  if (!isCollection(item) || flows(item, path.length) || Array.isArray(item)) {
    return `${isCollection(item) ? flowValue(item) : inlineScalar(item)}\n`;
  }
  const lines = blockLines(item, contentIndent, path, options);
  return lines.slice(contentIndent);
}

/** A whole document in the canonical style. */
export function renderYaml(value: Record<string, unknown>, options: PatchOptions = {}): string {
  return blockLines(value, 0, [], options);
}
