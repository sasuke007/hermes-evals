/**
 * Strict reading of the judge's answer (Phase 3 S4): one JSON object with a
 * numeric `score` from 0 to 1 and a non-empty string `comment`. The only
 * leniency is surrounding whitespace and a single code fence around the
 * whole answer, which many models add even when told not to; nothing is
 * ever extracted from prose, and a score is never guessed. Anything else is
 * a reason the key is published as `error`, never a zero.
 */

/** What a stored comment keeps of the judge's own comment. */
export const JUDGE_COMMENT_MAX_CHARS = 1000;

/** How much of an unreadable answer the error quotes. */
const QUOTED_CHARS = 120;

export type JudgeVerdict =
  { ok: true; score: number; comment: string } | { ok: false; reason: string };

/** The whole answer inside one fence: ```json … ``` or ``` … ```. */
const WHOLE_FENCE = /^```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

const quote = (text: string): string =>
  JSON.stringify(text.length > QUOTED_CHARS ? `${text.slice(0, QUOTED_CHARS)}…` : text);

/** Why an answer ended early, when the finish reason says so. */
function cutShort(finishReason: string | null): string | null {
  if (finishReason === 'length') return 'it was cut off at the token limit';
  if (finishReason === 'content_filter') return "the provider's content filter stopped it";
  return null;
}

/** Reads the judge's answer text. `finishReason` only sharpens the reason of a failure. */
export function parseJudgeVerdict(text: string, finishReason: string | null = null): JudgeVerdict {
  const why = cutShort(finishReason);
  const trimmed = text.trim();
  if (trimmed === '') {
    return {
      ok: false,
      reason: why ? `The judge gave no answer: ${why}.` : 'The judge gave an empty answer.',
    };
  }
  const body = WHOLE_FENCE.exec(trimmed)?.[1]?.trim() ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return {
      ok: false,
      reason: `The judge's answer is not JSON${why ? ` (${why})` : ''}: ${quote(trimmed)}.`,
    };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, reason: `The judge's answer is not a JSON object: ${quote(trimmed)}.` };
  }
  const { score, comment } = value as { score?: unknown; comment?: unknown };
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    return {
      ok: false,
      reason: `The judge's answer has no numeric score: ${quote(JSON.stringify(score) ?? 'missing')}.`,
    };
  }
  if (score < 0 || score > 1) {
    return { ok: false, reason: `The judge's score ${score} is outside 0 to 1.` };
  }
  if (typeof comment !== 'string' || comment.trim() === '') {
    return { ok: false, reason: "The judge's answer has no comment." };
  }
  const tidy = comment.trim().replace(/\s+/g, ' ');
  return {
    ok: true,
    score,
    comment:
      tidy.length > JUDGE_COMMENT_MAX_CHARS ? `${tidy.slice(0, JUDGE_COMMENT_MAX_CHARS)}…` : tidy,
  };
}
