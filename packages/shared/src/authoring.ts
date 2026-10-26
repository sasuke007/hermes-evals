/**
 * Rules of suite authoring (plan 4.6) that the API and the web app must
 * apply the same way: the limits of uploads and imports, the paths drafts
 * refuse, the answer instructions the editor and the CSV import append to a
 * prompt, the check a reference suggests, and the names of generated keys
 * and downloads. The contracts of the authoring routes are in
 * ./contracts/drafts.ts, ./contracts/draft-tasks.ts and
 * ./contracts/suite-import.ts.
 */
import type { JsonValue } from './records.js';
import type { ScorerType } from './vocab.js';

const MiB = 1024 * 1024;

/**
 * The bounds of authoring (plan 4.6). A suite folder's own bounds are the
 * loader's (SUITE_WALK_LIMITS and MAX_SUITE_FILE_BYTES in the api), repeated
 * here so a zip, an upload and a reload refuse the same things with the
 * same numbers.
 */
export const AUTHORING_LIMITS = {
  /** A CSV or JSONL file of tasks to import. */
  taskImportMaxBytes: 5 * MiB,
  taskImportMaxRows: 500,
  /** A suite .zip to import. */
  suiteZipMaxBytes: 100 * MiB,
  /** Entries in a suite folder or zip, folders included. */
  suiteMaxEntries: 20_000,
  /** One file of a suite: an upload, a zip entry, a file on disk. */
  suiteMaxFileBytes: 25 * MiB,
  /** Folders a path may be nested in, counted from the suite folder. */
  suiteMaxDepth: 12,
  /** A text the forms edit (task.yaml, prompt.md, reference.json, a rubric), in characters. */
  draftTextMaxChars: 1 * MiB,
  /** A text fixture larger than this gets no line diff in a task diff, only its size and hash. */
  textFixtureDiffMaxBytes: 64 * 1024,
  /** Characters of the prompt an imported task without a summary column takes as its summary. */
  summaryFromPromptChars: 80,
} as const;

/** The task folder whose files are code; nothing under it is written through a draft (R7). */
export const TASK_VERIFY_DIR = 'verify';

/**
 * Whether a task-folder path is in `verify/`, which draft endpoints refuse to
 * write (plan 4.6, R7). The path is resolved first (`./`, `a/../`, repeated
 * and trailing slashes, backslashes as separators) and compared without case,
 * because the suites folder may sit on a case-insensitive disk (macOS), where
 * `Verify/` is `verify/`. A path that climbs out of the task folder counts as
 * in it: it is refused either way.
 */
export function isVerifyPath(path: string): boolean {
  const resolved: string[] = [];
  for (const segment of path.split(/[\\/]+/)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.pop() === undefined) return true;
      continue;
    }
    resolved.push(segment);
  }
  return resolved[0]?.toLowerCase() === TASK_VERIFY_DIR;
}

/** The opening of the paragraph that asks for the answer block. */
export const ANSWER_INSTRUCTIONS_LEAD =
  'End your reply with your answer as a fenced JSON block, exactly in this shape:';

/** A value of the same type as `value` that gives nothing away: 0, 0.0, "", false, [], {}. */
function placeholder(value: JsonValue | undefined): string {
  if (value === undefined || typeof value === 'number') {
    return value === undefined || Number.isInteger(value) ? '0' : '0.0';
  }
  if (typeof value === 'string') return '""';
  if (typeof value === 'boolean') return 'false';
  if (value === null) return 'null';
  return Array.isArray(value) ? '[]' : '{}';
}

/** `totals.vat` → [{key: totals}, {key: vat}]; `bands[2]` → [{key: bands}, {index: 2}]. Null when malformed. */
function pathSegments(path: string): Array<{ key: string } | { index: number }> | null {
  const segments: Array<{ key: string } | { index: number }> = [];
  for (const part of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) return null;
    if (match[1] !== '') segments.push({ key: match[1]! });
    for (const index of match[2]!.matchAll(/\[(\d+)\]/g))
      segments.push({ index: Number(index[1]) });
  }
  return segments.length > 0 ? segments : null;
}

/** The value at `path` in `value`, or undefined. */
function valueAt(value: JsonValue | undefined, path: string): JsonValue | undefined {
  let node = value;
  for (const segment of pathSegments(path) ?? []) {
    if (node === undefined || node === null || typeof node !== 'object') return undefined;
    if ('key' in segment) {
      if (Array.isArray(node) || !Object.hasOwn(node, segment.key)) return undefined;
      node = node[segment.key];
    } else {
      if (!Array.isArray(node)) return undefined;
      node = node[segment.index];
    }
  }
  return node;
}

/**
 * The JSON the answer block should hold, with a placeholder where the answer
 * goes, on one line: `{ "total_due": 0.0 }` for the path `total_due` and a
 * decimal reference, `{ "totals": { "vat": 0 } }` for `totals.vat`. Without a
 * path, an object reference shows its keys (`{ "duplicates": [] }`) and any
 * other reference its placeholder. The reference only picks each
 * placeholder's type, so the shape never shows the answer.
 */
export function answerShape(path: string | null, reference: JsonValue | undefined): string {
  const segments = path === null || path === '' ? null : pathSegments(path);
  if (segments === null) {
    if (reference !== null && typeof reference === 'object' && !Array.isArray(reference)) {
      const keys = Object.keys(reference);
      if (keys.length === 0) return '{}';
      const body = keys.map((k) => `${JSON.stringify(k)}: ${placeholder(reference[k])}`);
      return `{ ${body.join(', ')} }`;
    }
    return placeholder(reference);
  }
  let shape = placeholder(valueAt(reference, path!));
  for (const segment of [...segments].reverse()) {
    shape = 'key' in segment ? `{ ${JSON.stringify(segment.key)}: ${shape} }` : `[${shape}]`;
  }
  return shape;
}

/**
 * The paragraph "Add answer instructions" appends to a prompt, and that the
 * CSV import appends to every imported prompt when asked (SA.4, SA.9):
 * ANSWER_INSTRUCTIONS_LEAD, then the shape in a ```json fence. The loader's
 * check for an answer-block instruction (plan 4.2) accepts it.
 */
export function answerInstructions(path: string | null, reference: JsonValue | undefined): string {
  return `${ANSWER_INSTRUCTIONS_LEAD}\n\n\`\`\`json\n${answerShape(path, reference)}\n\`\`\``;
}

/** `prompt` with `paragraph` after one blank line, ending in one newline; just the paragraph for an empty prompt. */
export function appendParagraph(prompt: string, paragraph: string): string {
  const head = prompt.trimEnd();
  return head === '' ? `${paragraph}\n` : `${head}\n\n${paragraph}\n`;
}

/**
 * The answer check a reference value suggests in the check picker (SA.7):
 * a number is compared within a tolerance, an object or a list key by key,
 * a string or a boolean as exact text. Null without a reference value
 * ("Add the reference answer to get a suggestion.").
 */
export function suggestedCheckType(value: JsonValue | undefined): ScorerType | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') return 'numeric_tolerance';
  if (typeof value === 'object') return 'json_match';
  return 'exact_match';
}

/**
 * The key of the n-th imported row (1-based) when no column is mapped to
 * Task key (SA.9): the prefix and the row number, zero-padded to the width of
 * the row count with at least two digits, `overdue_q01`, `overdue_q02`, ….
 */
export function generatedTaskKey(prefix: string, row: number, rowCount: number): string {
  const width = Math.max(2, String(rowCount).length);
  return `${prefix}${String(row).padStart(width, '0')}`;
}

/**
 * An imported task's summary when no column is mapped to Summary (SA.9):
 * the first 80 characters of its prompt, on one line.
 */
export function summaryFromPrompt(prompt: string): string {
  const line = prompt.replace(/\s+/g, ' ').trim();
  return line.slice(0, AUTHORING_LIMITS.summaryFromPromptChars).trimEnd();
}

/** The file name of a suite version's download (SA.10): `invoices-v1-v6.zip`. */
export function suiteVersionZipName(folder: string, versionNumber: number): string {
  return `${folder}-v${versionNumber}.zip`;
}
