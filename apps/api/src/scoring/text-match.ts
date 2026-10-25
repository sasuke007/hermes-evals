/**
 * text_match (plan 9.3, DESIGN_CHECKS_FIX_PROMPT.md Part F, Phase 3 S6):
 * phrases and an optional regular expression looked for in the answer's
 * text at the key's path (scoring/answer.ts resolves the path; the primary
 * key inherits the task's answer path).
 *
 * - A string value is matched as it is; any other value as its JSON text.
 *   At most MAX_TEXT_MATCH_BYTES of it are matched.
 * - Each phrase and the pattern count once; the score is the share found,
 *   and the key passes when score >= pass_at (default 1). `case_sensitive`
 *   (default false) applies to both: phrases are compared lowercased
 *   (toLowerCase, no locale, as exact_match), and the pattern gets the `i`
 *   flag.
 * - Evidence: `evidence.text.items`, each phrase or the pattern with `found`
 *   (records.ts TextMatchEvidenceSchema), and `truncated` when the text was
 *   cut to the cap.
 * - Self-check mode `answer`: the reference itself must pass.
 *
 * The pattern is a JavaScript regular expression compiled with the `u` flag:
 * Unicode-aware, and strict about escapes, so a typo such as `\-` outside a
 * class is a load error rather than a pattern that quietly means something
 * else. No `m`, `s` or `g`: `^` and `$` are the ends of the whole text, and
 * the pattern is found anywhere in it.
 *
 * Catastrophic backtracking: the pattern is the suite author's but the text
 * is the agent's, and a pattern such as `(a+)+$` takes exponential time on
 * the right input. V8's backtracking engine has no step limit, so every
 * match runs under node:vm's synchronous `timeout` (PATTERN_TIMEOUT_MS),
 * which interrupts it; a match that runs out of time is the check's fault
 * (`error`), never a zero. A static refusal of nested quantifiers at load
 * was not chosen: it refuses safe patterns and misses unsafe ones (`(a|a)*`).
 */
import { Buffer } from 'node:buffer';
import { Script, createContext } from 'node:vm';
import type { JsonValue, TextMatchEvidence, TextMatchParams } from '@hermes-evals/shared';
import { graded, scorerError, type ScorerResult } from './result.js';

/** Most of the text matched, in UTF-8 bytes (plan 9.3: "capped at 64 KB before matching"). */
export const MAX_TEXT_MATCH_BYTES = 64 * 1024;

/**
 * How long one pattern may run on one text. A sane pattern on 64 KB takes
 * well under a millisecond; a second means it is backtracking.
 */
export const PATTERN_TIMEOUT_MS = 1_000;

/**
 * A pattern ready to run, or why it cannot be. `message` is what the loader
 * reports as a `params_invalid` load issue on the key, in the editor's words:
 * "The pattern is not valid: unterminated group."
 */
export type CompiledTextPattern = { ok: true; regex: RegExp } | { ok: false; message: string };

/**
 * V8's reason, without the `Invalid regular expression: /…/u: ` prefix that
 * repeats the pattern: "Unterminated group" becomes "unterminated group".
 */
function compileReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const reason = /: ([^:]+)$/.exec(message)?.[1]?.trim() ?? message;
  return reason.charAt(0).toLowerCase() + reason.slice(1);
}

/** Compiles a text_match pattern with the key's case rule. Never throws. */
export function compileTextPattern(pattern: string, caseSensitive: boolean): CompiledTextPattern {
  try {
    return { ok: true, regex: new RegExp(pattern, caseSensitive ? 'u' : 'iu') };
  } catch (err) {
    return { ok: false, message: `The pattern is not valid: ${compileReason(err)}.` };
  }
}

/** The text a value is matched as: a string as it is, anything else as its JSON text. */
export function textOf(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * The first MAX_TEXT_MATCH_BYTES of `text` in UTF-8, cut before any
 * character that would straddle the cap rather than through it.
 */
export function capText(text: string): { text: string; truncated: boolean } {
  // A UTF-16 unit is at most 3 UTF-8 bytes, so shorter strings cannot exceed the cap.
  if (text.length * 3 <= MAX_TEXT_MATCH_BYTES) return { text, truncated: false };
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_TEXT_MATCH_BYTES) return { text, truncated: false };
  let end = MAX_TEXT_MATCH_BYTES;
  // Back off continuation bytes (10xxxxxx) to the start of the straddling character.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

const MATCH = new Script('regex.test(text)', { filename: 'text-match-pattern.vm' });

/** Whether `regex` matches `text`, or null when it ran out of time. Throws only on a bug. */
export function testPattern(
  regex: RegExp,
  text: string,
  timeoutMs = PATTERN_TIMEOUT_MS,
): boolean | null {
  // A fresh, empty context per match: the regex and the text are all it sees.
  const context = createContext({ regex, text });
  try {
    return MATCH.runInContext(context, { timeout: timeoutMs }) === true;
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return null;
    throw err;
  }
}

const round = (score: number): number => Math.round(score * 1e6) / 1e6;

/** Long phrases and patterns are cut in the comment; the evidence keeps them whole. */
const LABEL_CHARS = 60;
const shortLabel = (label: string): string =>
  label.length <= LABEL_CHARS ? label : `${label.slice(0, LABEL_CHARS - 1)}…`;

/** `found 1 of 2: "1.5%" ✓ "30 days" ✗` (Part F's Try it line, without the score). */
function describeItems(items: TextMatchEvidence['items'], truncated: boolean): string {
  const found = items.filter((i) => i.found).length;
  const listed = items
    .map((i) => {
      const label =
        i.kind === 'pattern' ? `/${shortLabel(i.label)}/` : JSON.stringify(shortLabel(i.label));
      return `${label} ${i.found ? '✓' : '✗'}`;
    })
    .join(' ');
  const cut = truncated ? ` (only the first ${MAX_TEXT_MATCH_BYTES / 1024} KB were searched)` : '';
  return `found ${found} of ${items.length}: ${listed}${cut}`;
}

/** Grades the value at the key's path. Never throws: a broken pattern or a time-out is `error`. */
export function scoreTextMatch(value: JsonValue, params: TextMatchParams): ScorerResult {
  const { text, truncated } = capText(textOf(value));
  const folded = params.case_sensitive ? text : text.toLowerCase();
  const items: TextMatchEvidence['items'] = (params.contains ?? []).map((phrase) => ({
    kind: 'phrase',
    label: phrase,
    found: folded.includes(params.case_sensitive ? phrase : phrase.toLowerCase()),
  }));
  if (params.pattern !== undefined) {
    const compiled = compileTextPattern(params.pattern, params.case_sensitive);
    // The loader refuses such a pattern, so only a hand-edited row gets here.
    if (!compiled.ok) return scorerError(compiled.message, null, { observed: value });
    const found = testPattern(compiled.regex, text);
    if (found === null) {
      return scorerError(
        `the pattern took longer than ${PATTERN_TIMEOUT_MS / 1000} s on the answer's text, so it was stopped; simplify it (nested quantifiers such as (a+)+ backtrack)`,
        `pattern /${shortLabel(params.pattern)}/ on ${Buffer.byteLength(text, 'utf8')} bytes`,
        { observed: value },
      );
    }
    items.push({ kind: 'pattern', label: params.pattern, found });
  }
  if (items.length === 0) {
    // The params schema requires a phrase or a pattern; only a hand-edited row gets here.
    return scorerError('text_match needs at least one phrase or a pattern');
  }
  const score = round(items.filter((i) => i.found).length / items.length);
  return graded(score >= params.pass_at, score, describeItems(items, truncated), {
    observed: value,
    expected: {
      ...(params.contains ? { contains: params.contains } : {}),
      ...(params.pattern !== undefined ? { pattern: params.pattern } : {}),
    },
    evidence: { text: { items, truncated } },
  });
}
