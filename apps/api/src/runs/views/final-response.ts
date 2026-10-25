/**
 * The inspector's Final response section (UI_FLOWS 18, plan 9.1): the final
 * text Hermes recorded, the range of the JSON block the scorer parsed and of
 * its fences, the parsed value or the parse error, and the task's reference
 * beside it (hidden from the agent; only the inspector shows it).
 *
 * The extraction shown is the one the scores were computed from, stored on
 * the evaluation. Before the run is scored there is none yet, so the same
 * extraction is computed here from the text; it is deterministic, so scoring
 * will find the same block.
 */
import type { ExtractedAnswer, FinalResponseView, JsonValue, TextSpan } from '@hermes-evals/shared';
import { extractAnswer, scanJsonFences } from '../../scoring/extraction.js';

/** The whole fenced block, fences included, whose body is `answer`'s range. */
function fenceOf(text: string, answer: ExtractedAnswer): TextSpan | null {
  if (answer.status === 'missing') return null;
  const scan = scanJsonFences(text);
  const block = scan.blocks.find((b) => b.bodyStart === answer.start && b.bodyEnd === answer.end);
  if (block) return { start: block.fenceStart, end: block.fenceEnd };
  if (scan.unclosed && scan.unclosed.bodyStart === answer.start) {
    return { start: scan.unclosed.fenceStart, end: text.length };
  }
  return null;
}

/** A stored range that does not fit the text (it never should) is dropped rather than misdrawn. */
const span = (text: string, start: number, end: number): TextSpan | null =>
  start >= 0 && end >= start && end <= text.length ? { start, end } : null;

export function finalResponseView(
  finalText: string,
  stored: ExtractedAnswer | null,
  reference: JsonValue | null,
): FinalResponseView {
  const answer = stored ?? extractAnswer(finalText);
  const base = { text: finalText, reference: reference ?? null, referenceNote: null };
  switch (answer.status) {
    case 'missing':
      return {
        ...base,
        extracted: null,
        fence: null,
        extraction: 'missing',
        parsed: null,
        parseError: null,
      };
    case 'found':
      return {
        ...base,
        extracted: span(finalText, answer.start, answer.end),
        fence: fenceOf(finalText, answer),
        extraction: 'found',
        parsed: answer.value,
        parseError: null,
      };
    case 'invalid':
      return {
        ...base,
        extracted: span(finalText, answer.start, answer.end),
        fence: fenceOf(finalText, answer),
        extraction: 'invalid',
        parsed: null,
        parseError: { message: answer.error, position: answer.position },
      };
  }
}
