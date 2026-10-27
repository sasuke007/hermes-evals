import { ExtractedAnswerSchema } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { extractAnswer, extractionComment, scanJsonFences } from './extraction.js';

/** The body the offsets bound, so tests read as the text they check. */
function body(text: string) {
  const answer = extractAnswer(text);
  expect(ExtractedAnswerSchema.safeParse(answer).success).toBe(true);
  return answer.status === 'missing' ? null : text.slice(answer.start, answer.end);
}

describe('extractAnswer', () => {
  it('takes the last fenced json block and bounds its body', () => {
    const text =
      'Draft:\n```json\n{"total_due": 1}\n```\nFinal:\n```json\n{"total_due": 2.5}\n```\n';
    expect(extractAnswer(text)).toMatchObject({
      status: 'found',
      block_count: 2,
      value: { total_due: 2.5 },
    });
    expect(body(text)).toBe('{"total_due": 2.5}');
  });

  it('reports the whole fence too, for the inspector', () => {
    const text = 'Total:\n```json\n{"a": 1}\n```';
    const [block] = scanJsonFences(text).blocks;
    expect(text.slice(block!.fenceStart, block!.fenceEnd)).toBe('```json\n{"a": 1}\n```');
    expect(text.slice(block!.bodyStart, block!.bodyEnd)).toBe('{"a": 1}');
  });

  it('is missing without a json block or without text', () => {
    expect(extractAnswer('The total is 3.')).toEqual({ status: 'missing', block_count: 0 });
    expect(extractAnswer('```python\nprint(1)\n```')).toEqual({
      status: 'missing',
      block_count: 0,
    });
    expect(extractAnswer(null)).toEqual({ status: 'missing', block_count: 0 });
    expect(extractAnswer('')).toEqual({ status: 'missing', block_count: 0 });
  });

  it('reports invalid JSON with the absolute error position', () => {
    const text = 'Answer:\n```json\n{total: 3}\n```\n';
    const answer = extractAnswer(text);
    expect(answer).toMatchObject({ status: 'invalid', block_count: 1 });
    if (answer.status !== 'invalid') throw new Error('expected invalid');
    expect(text.slice(answer.start, answer.end)).toBe('{total: 3}');
    // V8 points at the `t` of `total`, one past the brace.
    expect(answer.position).toBe(answer.start + 1);
    expect(extractionComment(answer)).toMatch(/^invalid JSON at position \d+: /);
  });

  it('refuses a number JSON cannot store', () => {
    expect(extractAnswer('```json\n{"x": 1e999}\n```')).toMatchObject({
      status: 'invalid',
      error: 'a number is out of range',
      position: null,
    });
  });

  it('does not fall back to an earlier block when the last one is not closed', () => {
    const text =
      'Shape:\n```json\n{"total_due": 0.00}\n```\nAnswer:\n```json\n{"total_due": 99760.52}\n';
    const answer = extractAnswer(text);
    expect(answer).toMatchObject({ status: 'invalid', block_count: 2, position: null });
    expect(extractionComment(answer)).toBe('the last ```json block is not closed');
    expect(body(text)).toBe('{"total_due": 99760.52}\n');
  });

  it('ignores a json fence quoted inside a longer fence', () => {
    const text =
      '```json\n{"total_due": 99760.52}\n```\nFor reference, the template was:\n' +
      '````markdown\n```json\n{"total_due": 0.00}\n```\n````\n';
    expect(extractAnswer(text)).toMatchObject({
      status: 'found',
      block_count: 1,
      value: { total_due: 99760.52 },
    });
  });

  it('finds a fence indented inside a list item', () => {
    const text = '1. Total:\n\n    ```json\n    {"total_due": 5}\n    ```\n';
    expect(extractAnswer(text)).toMatchObject({ status: 'found', value: { total_due: 5 } });
  });

  it('accepts tilde fences and CRLF line endings, keeping CR out of the body range', () => {
    const text = '~~~json\r\n{"a": 1}\r\n~~~\r\n';
    expect(extractAnswer(text)).toMatchObject({ status: 'found', value: { a: 1 } });
    expect(body(text)).toBe('{"a": 1}');
  });

  it('reads the info string case-insensitively and ignores attributes after it', () => {
    expect(extractAnswer('```JSON title="answer"\n[1, 2]\n```')).toMatchObject({
      status: 'found',
      value: [1, 2],
    });
  });

  it('does not treat a backtick fence with a backtick in its info string as a fence', () => {
    expect(extractAnswer('```json `x`\n{"a": 1}\n```')).toEqual({
      status: 'missing',
      block_count: 0,
    });
  });

  it('gives an empty body an empty range and an error', () => {
    const text = '```json\n```\n';
    const answer = extractAnswer(text);
    expect(answer).toMatchObject({ status: 'invalid', block_count: 1 });
    if (answer.status !== 'invalid') throw new Error('expected invalid');
    expect(answer.start).toBe(answer.end);
  });

  it('counts offsets in UTF-16 code units', () => {
    const text = 'Ünïcödé 😀 total:\n```json\n{"name": "😀"}\n```';
    const answer = extractAnswer(text);
    expect(answer).toMatchObject({ status: 'found', value: { name: '😀' } });
    expect(body(text)).toBe('{"name": "😀"}');
  });

  it('keeps a __proto__ key as data', () => {
    const answer = extractAnswer('```json\n{"__proto__": {"x": 1}}\n```');
    expect(answer.status).toBe('found');
    if (answer.status === 'found')
      expect(Object.keys(answer.value as object)).toEqual(['__proto__']);
  });
});

describe('extractAnswer on a reply without a fence (Phase 8 G5)', () => {
  const MISSING = { status: 'missing', block_count: 0 };

  it('takes a reply that is exactly one JSON object, flagged unfenced, over the trimmed reply', () => {
    const text = '\n  {\n  "total_due": 99760.52,\n  "currency": "USD"\n}\n\n';
    const answer = extractAnswer(text);
    expect(ExtractedAnswerSchema.parse(answer)).toEqual({
      status: 'found',
      block_count: 0,
      start: 3,
      end: text.length - 2,
      value: { total_due: 99760.52, currency: 'USD' },
      unfenced: true,
    });
    expect(body(text)).toBe(text.trim());
    expect(extractionComment(answer)).toBe('answer found');
  });

  it('takes a bare object with nothing around it, and an empty one', () => {
    expect(extractAnswer('{"a":1}')).toMatchObject({ start: 0, end: 7, unfenced: true });
    expect(extractAnswer('{}')).toMatchObject({ status: 'found', value: {}, unfenced: true });
  });

  it('keeps a reply with prose before or after the object missing', () => {
    for (const text of [
      'Here is the answer: {"total_due": 1}',
      'Here is the answer:\n{"total_due": 1}',
      '{"total_due": 1}\nLet me know if you need anything else.',
      '{"a": 1} {"b": 2}',
    ]) {
      expect(extractAnswer(text)).toEqual(MISSING);
      expect(extractionComment(extractAnswer(text))).toBe(
        'no fenced JSON block found in final response',
      );
    }
  });

  it('keeps arrays, scalars and invalid objects missing, never invalid', () => {
    for (const text of [
      '[1, 2]',
      '42',
      '"done"',
      'null',
      'true',
      '{total_due: 1}',
      '{"a": 1,}',
      '{',
    ]) {
      expect(extractAnswer(text)).toEqual(MISSING);
    }
    // An object JSON parses but no JSON column can hold.
    expect(extractAnswer('{"x": 1e999}')).toEqual(MISSING);
  });

  it('leaves fenced answers as they were: the fence wins and no flag is written', () => {
    const fenced = extractAnswer('```json\n{"a": 1}\n```');
    expect(fenced).toEqual({ status: 'found', block_count: 1, start: 8, end: 16, value: { a: 1 } });
    expect(fenced).not.toHaveProperty('unfenced');
    // A non-json fence around the object is not an answer, and not a bare object either.
    expect(extractAnswer('```\n{"a": 1}\n```')).toEqual(MISSING);
    expect(extractAnswer('```javascript\n{"a": 1}\n```')).toEqual(MISSING);
  });

  it('keeps an unclosed json block invalid, whatever follows it', () => {
    expect(extractAnswer('```json\n{"a": 1}')).toMatchObject({
      status: 'invalid',
      block_count: 1,
      error: 'the last ```json block is not closed',
    });
  });
});
