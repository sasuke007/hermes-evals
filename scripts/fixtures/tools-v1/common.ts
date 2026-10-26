/**
 * The shared pieces of the tools-v1 generator (../tools-v1.ts): the seeded
 * PRNG of each task, money in integer cents, the task shape, the prompt's
 * fixed parts, the mock scripts' phrases, and a model of what one Hermes
 * `read_file` call shows (the file-only arm's limit).
 *
 * The JSON printer, the CSV writer and the PRNG are invoices-v1's
 * (../invoices-v1/ledger.ts), so every generated JSON file is printed the
 * way prettier prints it and `prettier --check` passes on the suite.
 */
import { createHash } from 'node:crypto';
import {
  csv,
  json,
  jsonFile,
  mulberry32,
  type Json,
  type JsonObject,
  type Rng,
} from '../invoices-v1/ledger.ts';

export { csv, json, jsonFile, type Json, type JsonObject, type Rng };

/** The same seed as the Phase 6 generators; each task mixes in its key. */
export const SEED = 20261026;

/** FNV-1a, so each task's stream depends on its key only. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (const char of text) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

export const taskRng = (key: string): Rng => mulberry32(SEED ^ hash(key));
export const int = (r: Rng, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

export function shuffle<T>(r: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(r, 0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export const pickOne = <T>(r: Rng, items: readonly T[]): T => items[int(r, 0, items.length - 1)]!;

/** A construction a trap or a mock script relies on; a seed that breaks one is refused, not written. */
export function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`tools-v1 generator: ${message}; change SEED`);
}

/** Cents as the files write them: `4539.53`. Amounts here are never negative. */
export const money = (cents: number): string =>
  `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

/** Cents as a JSON number: 4539.53. */
export const eur = (cents: number): number => cents / 100;

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------------
// What one read_file call shows (Hermes v0.22.4, tools/file_tools.py)
// ---------------------------------------------------------------------------

/** read_file's line cap per call (tool_output.max_lines, default 2000). */
export const READ_FILE_LINES = 2000;
/** read_file's character budget per call (file_read_max_chars, default 100,000). */
export const READ_FILE_CHARS = 100_000;

/**
 * How many lines a read_file call from line 1 shows: at most 2,000, fewer
 * when the line-numbered page (`<n>|<line>`, joined by newlines) would pass
 * 100,000 characters. The file-only arm sees this much of a file unless it
 * pages on with `offset`.
 */
export function firstPageLines(text: string): number {
  const lines = text.replace(/\n$/, '').split('\n').slice(0, READ_FILE_LINES);
  let shown = 0;
  let kept = 0;
  for (const [i, line] of lines.entries()) {
    const width = `${i + 1}|`.length + line.length + (kept > 0 ? 1 : 0);
    if (shown + width > READ_FILE_CHARS) break;
    shown += width;
    kept++;
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Tasks and prompts
// ---------------------------------------------------------------------------

/** The scripted tool runs of a task: the same computation as Python for execute_code and as a shell command for terminal. */
export interface ToolRuns {
  /** Python source for execute_code; prints `codeMarker(key)` followed by `value`. */
  code: string;
  /** A shell command for terminal; prints `termMarker(key)` followed by `value`. */
  command: string;
  /** What both print after their marker when they ran on the task's fixtures. */
  value: string;
}

/** What the mock does with the file tools alone. */
export interface FileOnlyRun {
  /** Workspace files it opens with read_file, in order. */
  reads: string[];
  /** Workspace files it then writes with write_file. */
  writes?: { [path: string]: string };
  /** Its closing sentence and answer. */
  text: string;
  answer: JsonObject;
}

/** One task folder's generated content, its trap, and how the mock plays it in each arm. */
export interface ToolsTask {
  key: string;
  /** Path in the task folder → content: fixtures/, expected/, verify/ data and prompt.md. */
  files: Map<string, string>;
  /** The answer object a correct agent gives (reference.json). */
  reference: JsonObject;
  /** What an agent that falls into the trap answers, and leaves in the workspace. */
  trap: { answer: JsonObject; files?: { [path: string]: string }; note: string };
  /** The scripted execute_code and terminal runs; null for the control, which needs no tool beyond file. */
  tools: ToolRuns | null;
  /** The mock's run with the file tools alone. */
  fileOnly: FileOnlyRun;
  /** The control only: a phrase of a fixture that only reading it puts in a request. */
  readPhrase?: string;
  /**
   * The answer is picked from the task's own data (IBANs from the log, a
   * bin from the catalog), so task.yaml gets
   * `self_check.answers_from_fixtures: true` (../answers-from-fixtures.ts).
   */
  answersFromFixtures?: true;
}

/** Opens every prompt: the phrase its mock script matches, unique to tools-v1. */
export const requestLine = (key: string): string => `Request tv1-${key}.`;
/** The prompt script's `match`. */
export const promptPhrase = (key: string): string => `tv1-${key}.`;
/** What the scripted execute_code run prints before its result. */
export const codeMarker = (key: string): string => `tv1-${key}-code=`;
/** What the scripted terminal run prints before its result. */
export const termMarker = (key: string): string => `tv1-${key}-term=`;

const ANSWER_LEAD =
  'End your reply with your answer as a fenced JSON block, exactly in this shape:';

/** A whole prompt: the request line, the body, and the closing instruction with the answer's shape. */
export const prompt = (key: string, body: string, shape: string, lead = ANSWER_LEAD): string =>
  `${requestLine(key)}\n\n${body.trim()}\n\n${lead}\n\n\`\`\`json\n${shape}\n\`\`\`\n`;

/** A Python script as a terminal command: python3 reading the script from a quoted heredoc. */
export const pythonCommand = (script: string): string => `python3 - <<'PY'\n${script}\nPY`;
