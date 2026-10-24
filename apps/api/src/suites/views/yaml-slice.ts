/**
 * Verbatim YAML of each verification entry, cut from task.yaml as the author
 * wrote it (comments, flow maps and quoting kept), for Task detail's "YAML"
 * toggle. The yaml library's node ranges give each sequence item's source
 * offsets; the slice starts at the item's `- ` and is de-indented so it reads
 * as a top-level list item.
 *
 * An entry whose source cannot be found (task.yaml missing or no longer
 * parseable, which only happens for invalid tasks) falls back to the stored
 * entry written out as YAML.
 */
import { isMap, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import type { VerificationEntry } from '@hermes-evals/shared';

/** The YAML of each entry, in the order of `entries`. */
export function verificationYamlSlices(
  taskYaml: string | null,
  entries: readonly VerificationEntry[],
): string[] {
  const byKey = taskYaml === null ? new Map<string, string>() : slicesByKey(taskYaml);
  return entries.map((entry) => byKey.get(entry.key) ?? fallbackYaml(entry));
}

/** task.yaml's `answer.path`, which the primary key scores when its params name no path. */
export function answerPathOf(taskYaml: string | null): string | undefined {
  if (taskYaml === null) return undefined;
  const doc = parseDocument(taskYaml);
  if (doc.errors.length > 0) return undefined;
  const path: unknown = doc.getIn(['answer', 'path']);
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function slicesByKey(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return out;
  const list = doc.get('verification', true);
  if (!isSeq(list)) return out;
  for (const item of list.items) {
    if (!isMap(item) || !item.range) continue;
    const key = item.get('key', true);
    if (!isScalar(key) || typeof key.value !== 'string' || out.has(key.value)) continue;
    out.set(key.value, sliceItem(text, item.range[0], item.range[1]));
  }
  return out;
}

/**
 * The source of one sequence item. For a block item (`  - key: a`) the slice
 * begins at the dash and every later line loses the dash's indentation; a flow
 * item (`[{ key: a }]`) is its own source.
 */
function sliceItem(text: string, start: number, end: number): string {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const lead = /^( *)- +$/.exec(text.slice(lineStart, start));
  const body = text.slice(start, end).replace(/\s+$/, '');
  if (!lead) return body;
  const indent = lead[1]!.length;
  const [first = '', ...rest] = text
    .slice(lineStart + indent, start)
    .concat(body)
    .split('\n');
  return [first, ...rest.map((line) => dedent(line, indent))].join('\n');
}

/** Removes up to `n` leading spaces; a line indented less (only blank lines are) keeps its text. */
function dedent(line: string, n: number): string {
  let i = 0;
  while (i < n && line[i] === ' ') i++;
  return line.slice(i);
}

function fallbackYaml(entry: VerificationEntry): string {
  const item: Record<string, unknown> = { key: entry.key, type: entry.type };
  if (entry.primary) item.primary = true;
  if (Object.keys(entry.params).length > 0) item.params = entry.params;
  return stringify([item]).replace(/\s+$/, '');
}
