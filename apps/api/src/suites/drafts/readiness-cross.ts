/**
 * The readiness rules that look across a draft task's files (plan 4.6, V3),
 * which no loader rule covers:
 *
 * - referenceValues (rule 6): every path an answer check reads resolves in
 *   the reference, and what it finds there ("Values the checks read");
 * - mentionedFiles (rule 9): the files the prompt names are in the
 *   workspace, the expected workspace or the home seeds;
 * - referenceLeaks (rule 10): no text fixture contains a reference leaf
 *   value of 4 or more characters, which the agent could simply read.
 *
 * Pure functions over the task's parts; the leak rule gets the fixtures'
 * bytes from the caller.
 */
import {
  HOME_SEED_PATHS,
  homeSeedTarget,
  type JsonValue,
  type MentionedFile,
  type ReferenceValue,
  type VerificationEntry,
} from '@hermes-evals/shared';
import { AnswerPathError, parseAnswerPath, resolveAnswerPath } from '../../scoring/answer-path.js';
import { isAnswerScorerType } from '../../scoring/registry.js';
import { FIXTURES_DIR } from '../loader/limits.js';

const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** `a`, `a` and `b`, `a`, `b` and `c`, each in backticks. */
export function codeList(items: readonly string[]): string {
  const coded = items.map((i) => `\`${i}\``);
  return coded.length <= 1
    ? (coded[0] ?? '')
    : `${coded.slice(0, -1).join(', ')} and ${coded.at(-1)!}`;
}

/** A value in a few words: `17`, `"Nordlys Freight"`, an object with 5 keys, a list of 2 items. */
export function describeValue(value: JsonValue): string {
  if (Array.isArray(value)) return `a list of ${plural(value.length, 'item')}`;
  if (isRecord(value)) return `an object with ${plural(Object.keys(value).length, 'key')}`;
  const text = JSON.stringify(value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

/** A value as compact JSON, cut to about 80 characters. */
export function preview(value: JsonValue): string {
  const text = JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export interface CheckRead extends ReferenceValue {
  type: VerificationEntry['type'];
  /** The value found, when found. */
  value: JsonValue | undefined;
  /** The path is not a valid path. */
  malformed: boolean;
}

/** What each answer check reads in the reference; `reference` undefined when it does not parse. */
export function referenceReads(
  verification: readonly VerificationEntry[],
  reference: JsonValue,
): CheckRead[] {
  return verification
    .filter((entry) => isAnswerScorerType(entry.type))
    .map((entry) => {
      const raw = entry.params.path;
      const path = typeof raw === 'string' && raw !== '' ? raw : null;
      const base = { key: entry.key, type: entry.type, path };
      try {
        if (path !== null) parseAnswerPath(path);
        const found = resolveAnswerPath(reference, path ?? undefined);
        return found.found
          ? {
              ...base,
              found: true,
              preview: preview(found.value),
              value: found.value,
              malformed: false,
            }
          : { ...base, found: false, preview: null, value: undefined, malformed: false };
      } catch (err) {
        if (!(err instanceof AnswerPathError)) throw err;
        return { ...base, found: false, preview: null, value: undefined, malformed: true };
      }
    });
}

// ---------------------------------------------------------------------------
// Files the prompt mentions
// ---------------------------------------------------------------------------

/** Extensions a bare (not backticked) word must end in to count as a file name. */
const BARE_EXTENSIONS =
  'csv|tsv|json|jsonl|ndjson|txt|md|pdf|xlsx|xls|parquet|log|xml|ya?ml|html|sql|zip|png|jpe?g|docx|py';

/**
 * File names the prompt mentions: `code spans` that read as a file name
 * (`invoices.csv`, `docs/payment-terms.pdf`, an extension starting with a
 * letter so `1234.50` is not one), and bare words with a common file
 * extension. Fenced code blocks (the answer's shape) are skipped, and so are
 * names under `docs/`, where configuration documents are placed.
 */
export function mentionedNames(prompt: string): string[] {
  const text = prompt.replace(/^(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm, '');
  const names: string[] = [];
  const add = (raw: string) => {
    const name = raw.replace(/^(\.\/|\/workspace\/)/, '').replace(/[.,;:]+$/, '');
    if (name.startsWith('docs/') || name.includes('..') || names.includes(name)) return;
    names.push(name);
  };
  for (const match of text.matchAll(/`([^`\s]+)`/g)) {
    if (/^[\w./-]*\w\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(match[1]!)) add(match[1]!);
  }
  const bare = new RegExp(
    `(?<![\\w./\`-])([\\w-][\\w./-]*\\.(?:${BARE_EXTENSIONS}))(?![\\w\`])`,
    'gi',
  );
  for (const match of text.matchAll(bare)) add(match[1]!);
  return names;
}

/** Where each mentioned name is: the workspace, the expected workspace, the home seeds, or nowhere. */
export function locateMentions(
  names: readonly string[],
  paths: readonly string[],
  expectedDir: string | null,
): MentionedFile[] {
  const within = (dir: string) =>
    paths.filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1));
  const workspace = within(FIXTURES_DIR);
  const expected = expectedDir === null ? [] : within(expectedDir);
  const home = HOME_SEED_PATHS.filter((p) => paths.includes(p)).map((p) => homeSeedTarget(p));
  const holds = (files: readonly string[], name: string) =>
    files.some(
      (f) => f === name || (!name.includes('/') && f.slice(f.lastIndexOf('/') + 1) === name),
    );
  return names.map((name) => ({
    name,
    location: holds(workspace, name)
      ? 'workspace'
      : holds(expected, name)
        ? 'expected'
        : holds(home, name) || holds(home, `memories/${name}`)
          ? 'home'
          : 'missing',
  }));
}

/** Row 9's line for files that are all present. */
export function mentionsPresent(files: readonly MentionedFile[]): string {
  const by = (location: MentionedFile['location']) =>
    files.filter((f) => f.location === location).map((f) => f.name);
  const verb = (names: readonly string[]) => (names.length === 1 ? 'is' : 'are');
  const parts: string[] = [];
  const workspace = by('workspace');
  const expected = by('expected');
  const home = by('home');
  if (workspace.length > 0)
    parts.push(`${codeList(workspace)} ${verb(workspace)} in workspace files.`);
  if (expected.length > 0) {
    parts.push(
      `${codeList(expected)} ${verb(expected)} in the expected workspace (written by the agent).`,
    );
  }
  if (home.length > 0) parts.push(`${codeList(home)} ${verb(home)} in the home seeds.`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Reference values in workspace files
// ---------------------------------------------------------------------------

/** Shortest leaf value worth looking for: a 3-character value turns up anywhere. */
const MIN_LEAK_CHARS = 4;

/** `a.b`, `a[0]`, `a["Fjord Software"]`: the path of a leaf, as Task diff writes paths. */
function childPath(path: string, key: string | number): string {
  if (typeof key === 'number') return `${path}[${key}]`;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return path ? `${path}.${key}` : key;
  return `${path}[${JSON.stringify(key)}]`;
}

export interface Leaf {
  path: string;
  text: string;
  numeric: boolean;
}

/** Every string and number leaf of the reference of at least 4 characters, as text. */
export function referenceLeaves(value: JsonValue, path = ''): Leaf[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => referenceLeaves(v, childPath(path, i)));
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([k, v]) => referenceLeaves(v, childPath(path, k)));
  }
  if (typeof value === 'number') {
    const text = JSON.stringify(value);
    return text.length >= MIN_LEAK_CHARS ? [{ path: path || '$', text, numeric: true }] : [];
  }
  if (typeof value === 'string' && value.trim().length >= MIN_LEAK_CHARS) {
    return [{ path: path || '$', text: value.trim(), numeric: false }];
  }
  return [];
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `content` holds `leaf` as a whole value: not inside a longer number or word. */
function holdsLeaf(content: string, leaf: Leaf): boolean {
  const pattern = leaf.numeric
    ? `(?<![0-9.])${escape(leaf.text)}(?![0-9]|\\.[0-9])`
    : `(?<![A-Za-z0-9_])${escape(leaf.text)}(?![A-Za-z0-9_])`;
  return new RegExp(pattern).test(content);
}

export interface Leak {
  /** The fixture's path in the task folder, e.g. `fixtures/notes.txt`. */
  file: string;
  leaf: Leaf;
}

/** The first reference leaf each text fixture contains. */
export function referenceLeaks(
  leaves: readonly Leaf[],
  fixtures: ReadonlyArray<{ path: string; text: string }>,
): Leak[] {
  const leaks: Leak[] = [];
  for (const fixture of fixtures) {
    const leaf = leaves.find((l) => fixture.text.includes(l.text) && holdsLeaf(fixture.text, l));
    if (leaf) leaks.push({ file: fixture.path, leaf });
  }
  return leaks;
}
