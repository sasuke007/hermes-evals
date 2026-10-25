import { describe, expect, it } from 'vitest';
import { segmentText, type TextRange } from '@/lib/textSegments';

/** Each segment as [kind, text], the error character in brackets. */
function flat(
  text: string,
  highlight: TextRange | null = null,
  ignored: TextRange[] = [],
  errorAt: number | null = null,
): [string, string][] {
  return segmentText(text, highlight, ignored, errorAt).map((s) => [
    s.kind,
    s.parts.map((p) => (p.error ? `[${p.text}]` : p.text)).join(''),
  ]);
}

describe('segmentText', () => {
  it('is one text segment without ranges', () => {
    expect(flat('hello')).toEqual([['text', 'hello']]);
    expect(flat('')).toEqual([['text', '']]);
  });

  it('cuts out the highlighted range', () => {
    expect(flat('ab```{}```cd', { start: 2, end: 10 })).toEqual([
      ['text', 'ab'],
      ['highlight', '```{}```'],
      ['text', 'cd'],
    ]);
  });

  it('orders ignored ranges, clamps them and drops overlaps', () => {
    expect(
      flat('0123456789', { start: 6, end: 99 }, [
        { start: 0, end: 2 },
        { start: 1, end: 3 },
        { start: 3, end: 4 },
      ]),
    ).toEqual([
      ['ignored', '01'],
      ['text', '2'],
      ['ignored', '3'],
      ['text', '45'],
      ['highlight', '6789'],
    ]);
  });

  it('marks the character where parsing stopped', () => {
    expect(flat('{"a": [1,]}', { start: 0, end: 11 }, [], 9)).toEqual([
      ['highlight', '{"a": [1,[]]}'],
    ]);
    expect(flat('abc', null, [], 0)).toEqual([['text', '[a]bc']]);
  });
});
