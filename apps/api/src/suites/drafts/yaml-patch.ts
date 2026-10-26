/**
 * Byte-stable edits of a YAML file (plan 4.6, V5): task.yaml and suite.yaml
 * are edited through the yaml Document API without re-printing the file.
 * The file is parsed into a Document, the parsed value is compared with the
 * value wanted, and only the nodes that differ are rewritten, by splicing the
 * file's text at the node's source range. So comments, key order, quoting,
 * flow or block style and the folding of every untouched node survive, and a
 * value that did not change never rewrites the file.
 *
 * - A changed scalar keeps its quoting style where the new value allows it,
 *   and a block scalar (`>-`, `|`) is re-folded in the same style.
 * - A flow collection (`{ path: total_due, abs: 0.01 }`, `[file, terminal]`)
 *   is re-printed whole, in its own padding style.
 * - A block mapping is patched key by key: a removed key loses its lines, a
 *   new key is appended after the last one at the same indentation.
 * - A block sequence is patched item by item when its items stay in place
 *   (matched by identity: an entry's `key`, a string's value), and otherwise
 *   rebuilt from the items' own source blocks in the new order, so a moved
 *   or untouched item keeps its text and comments.
 *
 * New content is written in one canonical style (yaml-render.ts).
 */
import {
  Document,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type Pair,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import {
  afterKey,
  flowValue,
  FOLD_WIDTH,
  inlineScalar,
  isCollection,
  isRecord,
  itemText,
  renderYaml,
  spaces,
  type PatchOptions,
  type Path,
} from './yaml-render.js';

export { flowValue, inlineScalar, renderYaml, type PatchOptions } from './yaml-render.js';

/** A file the patcher cannot edit in place (it does not parse, or its root is not a mapping). */
export class YamlPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YamlPatchError';
  }
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** The item a rewrite of its sequence item must replace (a deleted first key of an entry). */
class RewriteItem extends Error {}

/** Deep equality of parsed values; key order does not matter. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameValue(x, b[i]))
    );
  }
  if (isRecord(a) || isRecord(b)) {
    if (!isRecord(a) || !isRecord(b)) return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]))
    );
  }
  return a === b;
}

const jsOf = (node: unknown): unknown =>
  node === null || node === undefined ? null : (node as { toJSON(): unknown }).toJSON();

const isBlockScalar = (node: Scalar): boolean =>
  node.type === 'BLOCK_FOLDED' || node.type === 'BLOCK_LITERAL';

const isInline = (node: Node): boolean =>
  isScalar(node) ? !isBlockScalar(node) : Boolean((node as YAMLMap | YAMLSeq).flow);

/**
 * The style a new value of `node` keeps: its own, unless its old value
 * forced the quotes (`''` cannot be written plain), which says nothing of
 * the author's choice. A blank task's `summary: ''` then takes its first
 * summary plain, as a hand-written file would have it.
 */
const styleOf = (node: Scalar): Scalar.Type | undefined =>
  (node.type === 'QUOTE_SINGLE' || node.type === 'QUOTE_DOUBLE') &&
  typeof node.value === 'string' &&
  inlineScalar(node.value) !== node.value
    ? undefined
    : node.type;

// ---------------------------------------------------------------------------
// Patching
// ---------------------------------------------------------------------------

/** Item identity for matching list items: a check's `key`, or a string item itself. */
function identityOf(value: unknown): string | null {
  if (typeof value === 'string') return `s:${value}`;
  if (isRecord(value) && typeof value.key === 'string') return `k:${value.key}`;
  return null;
}

/** For each new item, the old item it continues, or null for a new one. */
function matchItems(old: unknown[], next: unknown[]): (number | null)[] {
  const oldIds = old.map(identityOf);
  const newIds = next.map(identityOf);
  const unique = (ids: (string | null)[]) =>
    ids.every((id) => id !== null) && new Set(ids).size === ids.length;
  const mapping: (number | null)[] = next.map(() => null);
  const used = new Set<number>();
  if (unique(oldIds) && unique(newIds)) {
    newIds.forEach((id, j) => {
      const i = oldIds.indexOf(id);
      if (i >= 0) {
        mapping[j] = i;
        used.add(i);
      }
    });
  }
  // What identity left unmatched pairs up with the most alike item left (the
  // same fields; then the earliest), so a renamed check keeps its text.
  const freeOld = old.map((_, i) => i).filter((i) => !used.has(i));
  mapping.forEach((m, j) => {
    if (m !== null || freeOld.length === 0) return;
    const likeness = (i: number) => {
      const [a, b] = [old[i], next[j]];
      if (!isRecord(a) || !isRecord(b)) return 0;
      return Object.keys(b).filter((k) => k !== 'key' && sameValue(a[k], b[k])).length;
    };
    const best = freeOld.reduce((x, y) => (likeness(y) > likeness(x) ? y : x));
    freeOld.splice(freeOld.indexOf(best), 1);
    mapping[j] = best;
  });
  return mapping;
}

class Patcher {
  constructor(
    private readonly src: string,
    private readonly options: PatchOptions,
  ) {}

  private lineStart(pos: number): number {
    return this.src.lastIndexOf('\n', pos - 1) + 1;
  }

  /** The end of the line `pos` is on, after its newline; `pos` itself when it already follows one. */
  private lineEnd(pos: number): number {
    if (pos > 0 && this.src[pos - 1] === '\n') return pos;
    const nl = this.src.indexOf('\n', pos);
    return nl < 0 ? this.src.length : nl + 1;
  }

  private column(pos: number): number {
    return pos - this.lineStart(pos);
  }

  private endOf(pair: Pair): number {
    const value = pair.value as Node | null;
    return value?.range ? value.range[1] : (pair.key as Node).range![1];
  }

  /** Edits that turn `node` into `next`; throws RewriteItem when only a whole-item rewrite works. */
  patch(node: Node, next: unknown, path: Path, edits: Edit[], seqItem = false): void {
    if (sameValue(jsOf(node), next)) return;
    const [start, end] = node.range!;
    if (isScalar(node)) {
      if (!isBlockScalar(node)) {
        edits.push({
          start,
          end,
          text: isCollection(next) ? flowValue(next) : inlineScalar(next, styleOf(node)),
        });
        return;
      }
      if (typeof next !== 'string') throw new RewriteItem();
      edits.push({ start, end, text: this.blockScalar(node, next) });
      return;
    }
    const collection = node as YAMLMap | YAMLSeq;
    // An empty `[]` or `{}` says nothing of the author's style (a blank task's
    // `verification: []`): its first content is written as a new key would be.
    if (collection.flow && collection.items.length === 0 && isCollection(next)) {
      throw new RewriteItem();
    }
    if (collection.flow) {
      const text = this.src.slice(start, end);
      const padded = /^[[{] /.test(text);
      edits.push({
        start,
        end,
        text: isCollection(next)
          ? flowValue(
              next,
              Array.isArray(next) ? { map: true, seq: padded } : { map: padded, seq: false },
            )
          : inlineScalar(next),
      });
      return;
    }
    if (isMap(node) && isRecord(next) && Object.keys(next).length > 0) {
      this.patchMap(node, next, path, edits, seqItem);
      return;
    }
    if (isSeq(node) && Array.isArray(next) && next.length > 0) {
      this.patchSeq(node, next, path, edits);
      return;
    }
    throw new RewriteItem();
  }

  /** A block scalar's new text in its own style and indentation. */
  private blockScalar(node: Scalar, next: string): string {
    const [start, end] = node.range!;
    const old = this.src.slice(start, end);
    const indent = /\n( *)\S/.exec(old)?.[1]?.length ?? 2;
    const doc = new Document({ v: next });
    (doc.get('v', true) as Scalar).type = node.type!;
    const lines = doc.toString({ lineWidth: FOLD_WIDTH, indent: 2 }).slice('v: '.length);
    const text = lines
      .split('\n')
      .map((l, i) => (i === 0 || l === '' ? l : spaces(indent) + l.slice(2)))
      .join('\n');
    return old.endsWith('\n') ? text : text.replace(/\n$/, '');
  }

  private patchMap(
    map: YAMLMap,
    next: Record<string, unknown>,
    path: Path,
    edits: Edit[],
    seqItem: boolean,
  ): void {
    const pairs = map.items as Pair[];
    const keys = pairs.map((p) => {
      if (!isScalar(p.key) || typeof p.key.value !== 'string')
        throw new YamlPatchError('only plain string keys can be edited');
      return p.key.value;
    });
    const indent = this.column((pairs[0]!.key as Node).range![0]);
    pairs.forEach((pair, i) => {
      const key = keys[i]!;
      if (!Object.hasOwn(next, key)) {
        // The first key of a list item shares the line with its `- `.
        if (seqItem && i === 0) throw new RewriteItem();
        edits.push({
          start: this.lineStart((pair.key as Node).range![0]),
          end: this.lineEnd(this.endOf(pair)),
          text: '',
        });
        return;
      }
      const value = pair.value as Node | null;
      const childPath = [...path, key];
      try {
        if (value === null) throw new RewriteItem();
        const inner: Edit[] = [];
        this.patch(value, next[key], childPath, inner);
        edits.push(...inner);
      } catch (err) {
        if (!(err instanceof RewriteItem)) throw err;
        // Rewrite the value after `key:`: a block collection became a scalar, or the reverse.
        const colon = this.src.indexOf(':', (pair.key as Node).range![1]);
        const end =
          value?.range && !isInline(value)
            ? this.lineEnd(value.range[1])
            : this.lineEnd(this.endOf(pair));
        edits.push({
          start: colon + 1,
          end,
          text: afterKey(next[key], indent, childPath, this.options),
        });
      }
    });
    const added = Object.keys(next).filter((k) => !keys.includes(k));
    if (added.length > 0) {
      const at = this.lineEnd(this.endOf(pairs.at(-1)!));
      const lead = at === this.src.length && !this.src.endsWith('\n') ? '\n' : '';
      const text = added
        .map(
          (k) =>
            `${spaces(indent)}${inlineScalar(k)}:${afterKey(next[k], indent, [...path, k], this.options)}`,
        )
        .join('');
      edits.push({ start: at, end: at, text: lead + text });
    }
  }

  private patchSeq(seq: YAMLSeq, next: unknown[], path: Path, edits: Edit[]): void {
    const items = seq.items as Node[];
    const mapping = matchItems(items.map(jsOf), next);
    const inPlace = next.length === items.length && mapping.every((m, j) => m === j);
    const first = items[0]!.range![0];
    const dash = this.src.lastIndexOf('-', first);
    const dashColumn = this.column(dash);
    const contentColumn = this.column(first);
    const fresh = (value: unknown, j: number) =>
      `${spaces(dashColumn)}- ${itemText(value, contentColumn, [...path, j], this.options)}`;

    if (inPlace) {
      items.forEach((item, i) => {
        const inner: Edit[] = [];
        try {
          this.patch(item, next[i], [...path, i], inner, true);
          edits.push(...inner);
        } catch (err) {
          if (!(err instanceof RewriteItem)) throw err;
          edits.push({
            start: this.lineStart(item.range![0]),
            end: this.lineEnd(item.range![1]),
            text: fresh(next[i], i),
          });
        }
      });
      return;
    }
    // Rebuild the list from the items' own blocks, each with the comments above it.
    const blocks: { start: number; end: number }[] = [];
    items.forEach((item, i) => {
      const start = i === 0 ? this.lineStart(first) : blocks[i - 1]!.end;
      blocks.push({ start, end: this.lineEnd(item.range![1]) });
    });
    const text = next
      .map((value, j) => {
        const i = mapping[j];
        if (i === null || i === undefined) return fresh(value, j);
        const block = blocks[i]!;
        const inner: Edit[] = [];
        try {
          this.patch(items[i]!, value, [...path, j], inner, true);
        } catch (err) {
          if (!(err instanceof RewriteItem)) throw err;
          return fresh(value, j);
        }
        const body = applyEdits(this.src.slice(block.start, block.end), inner, block.start);
        // A block that began with a comment line above the first item keeps its indentation.
        return body.endsWith('\n') ? body : `${body}\n`;
      })
      .join('');
    edits.push({ start: blocks[0]!.start, end: blocks.at(-1)!.end, text });
  }
}

/** `text` (which starts at `offset` in the file) with `edits` applied; edits never overlap. */
function applyEdits(text: string, edits: readonly Edit[], offset = 0): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    out = out.slice(0, edit.start - offset) + edit.text + out.slice(edit.end - offset);
  }
  return out;
}

/**
 * `source` changed so that it parses to `next`, rewriting only the nodes
 * whose values differ. An empty file becomes the canonical rendering of
 * `next`. Throws YamlPatchError when `source` does not parse or its root is
 * not a mapping.
 */
export function patchYaml(
  source: string,
  next: Record<string, unknown>,
  options: PatchOptions = {},
): string {
  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new YamlPatchError(`the file does not parse: ${doc.errors[0]!.message}`);
  }
  const root = doc.contents as Node | null;
  if (root === null || (isScalar(root) && root.value === null)) {
    return Object.keys(next).length === 0 ? source : renderYaml(next, options);
  }
  if (!isMap(root)) throw new YamlPatchError('the file is not a mapping of keys');
  const patcher = new Patcher(source, options);
  const edits: Edit[] = [];
  try {
    patcher.patch(root, next, [], edits);
  } catch (err) {
    if (err instanceof RewriteItem) return renderYaml(next, options);
    throw err;
  }
  return applyEdits(source, edits);
}
