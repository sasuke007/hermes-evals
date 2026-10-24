/**
 * Answer extraction (plan 9.1): the last fenced block tagged `json` in the
 * agent's final text, parsed. The result is stored on the evaluation, so the
 * attempt stays immutable and each re-score keeps its own extraction.
 *
 * Fences are read line by line as CommonMark does, so a ```json block quoted
 * inside a longer fence is content, not an answer. An unclosed ```json block
 * after the last complete one makes the answer ungradable, rather than
 * grading an earlier block (often the echoed template).
 */
import { JsonValueSchema, type ExtractedAnswer } from '@hermes-evals/shared';

/** One closed ```json block. Offsets are UTF-16 indices into the text, half-open. */
export interface JsonFence {
  /** The whole block, fences included: what the inspector highlights. */
  fenceStart: number;
  fenceEnd: number;
  /** The body only, without the newline that ends its last line. */
  bodyStart: number;
  bodyEnd: number;
}

export interface JsonFenceScan {
  blocks: JsonFence[];
  /** A ```json block still open when the text ends, after every closed one. */
  unclosed: { fenceStart: number; bodyStart: number } | null;
}

/** Finds every closed fenced block tagged `json`, in order. */
export function scanJsonFences(text: string): JsonFenceScan {
  const blocks: JsonFence[] = [];
  let open: {
    char: string;
    length: number;
    json: boolean;
    start: number;
    bodyStart: number;
  } | null = null;
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length;
    const bare = line.replace(/\r$/, '');
    if (!open) {
      // Any indentation: answers often sit inside a list item.
      const opener = /^\s*(`{3,}|~{3,})(.*)$/.exec(bare);
      // A backtick fence's info string may not contain a backtick (CommonMark).
      if (opener && !(opener[1]![0] === '`' && opener[2]!.includes('`'))) {
        const info = opener[2]!.trim().split(/\s+/)[0]!.toLowerCase();
        open = {
          char: opener[1]![0]!,
          length: opener[1]!.length,
          json: info === 'json',
          start: offset,
          bodyStart: Math.min(lineEnd + 1, text.length),
        };
      }
    } else {
      const closer = /^\s*(`{3,}|~{3,})[ \t]*$/.exec(bare);
      if (closer && closer[1]![0] === open.char && closer[1]!.length >= open.length) {
        if (open.json) {
          blocks.push({
            fenceStart: open.start,
            fenceEnd: lineEnd,
            bodyStart: open.bodyStart,
            bodyEnd: trimLineEnd(text, open.bodyStart, offset),
          });
        }
        open = null;
      }
    }
    offset = lineEnd + 1;
  }
  return {
    blocks,
    unclosed: open?.json ? { fenceStart: open.start, bodyStart: open.bodyStart } : null,
  };
}

/** The error of an answer whose last ```json block never closes. */
export const UNCLOSED_BLOCK_ERROR = 'the last ```json block is not closed';

/** Moves `end` back over the line break that ends the body's last line. */
function trimLineEnd(text: string, start: number, end: number): number {
  let at = end;
  if (at > start && text[at - 1] === '\n') at -= 1;
  if (at > start && text[at - 1] === '\r') at -= 1;
  return at;
}

/** V8 reports most syntax errors as "... at position N ..." within the parsed string. */
function errorPosition(message: string): number | null {
  const match = /at position (\d+)/.exec(message);
  return match ? Number(match[1]) : null;
}

/** The answer in the final text, or why there is none. */
export function extractAnswer(finalText: string | null): ExtractedAnswer {
  if (!finalText) return { status: 'missing', block_count: 0 };
  const { blocks, unclosed } = scanJsonFences(finalText);
  if (unclosed) {
    return {
      status: 'invalid',
      block_count: blocks.length + 1,
      start: unclosed.bodyStart,
      end: finalText.length,
      error: UNCLOSED_BLOCK_ERROR,
      position: null,
    };
  }
  const last = blocks.at(-1);
  if (!last) return { status: 'missing', block_count: 0 };
  const range = { block_count: blocks.length, start: last.bodyStart, end: last.bodyEnd };
  const body = finalText.slice(last.bodyStart, last.bodyEnd);
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (err) {
    const message = (err as Error).message;
    const at = errorPosition(message);
    return {
      status: 'invalid',
      ...range,
      error: message,
      position: at === null ? null : last.bodyStart + Math.min(at, body.length),
    };
  }
  // JSON.parse accepts 1e999 as Infinity, which no JSON column can hold.
  const json = JsonValueSchema.safeParse(value);
  if (!json.success) {
    return {
      status: 'invalid',
      ...range,
      error: 'a number is out of range',
      position: null,
    };
  }
  return { status: 'found', ...range, value: json.data };
}

/** The comment an answer-based key gets when the answer is missing or invalid. */
export function extractionComment(answer: ExtractedAnswer): string {
  switch (answer.status) {
    case 'missing':
      return 'no fenced JSON block found in final response';
    case 'invalid':
      if (answer.error === UNCLOSED_BLOCK_ERROR) return UNCLOSED_BLOCK_ERROR;
      return answer.position === null
        ? `invalid JSON: ${answer.error}`
        : `invalid JSON at position ${answer.position}: ${answer.error}`;
    case 'found':
      return 'answer found';
  }
}
