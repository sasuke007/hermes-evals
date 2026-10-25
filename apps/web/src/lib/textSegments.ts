/**
 * Cuts a text into the pieces JsonBlock draws: plain text, the highlighted range (the block
 * the scorer used), ignored ranges (other blocks, dimmed), and the one character where a
 * parse stopped. Ranges are half-open UTF-16 offsets [start, end), as the API sends them
 * (TextSpan); they are clamped to the text, and ranges that overlap an earlier one are
 * dropped.
 */
export interface TextRange {
  start: number;
  end: number;
}

export type SegmentKind = 'text' | 'highlight' | 'ignored';

export interface TextSegment {
  kind: SegmentKind;
  /** Pieces of this segment; `error` marks the character where parsing stopped. */
  parts: { text: string; error: boolean }[];
}

function clamp(range: TextRange, length: number): TextRange | null {
  const start = Math.max(0, Math.min(length, range.start));
  const end = Math.max(start, Math.min(length, range.end));
  return end > start ? { start, end } : null;
}

export function segmentText(
  text: string,
  highlight: TextRange | null = null,
  ignored: readonly TextRange[] = [],
  errorAt: number | null = null,
): TextSegment[] {
  const ranges: (TextRange & { kind: SegmentKind })[] = [];
  for (const [kind, range] of [
    ...(highlight ? [['highlight', highlight] as const] : []),
    ...ignored.map((r) => ['ignored', r] as const),
  ]) {
    const r = clamp(range, text.length);
    if (r) ranges.push({ ...r, kind });
  }
  ranges.sort((a, b) => a.start - b.start);
  const kept: typeof ranges = [];
  for (const r of ranges) {
    const last = kept[kept.length - 1];
    if (!last || r.start >= last.end) kept.push(r);
  }

  const split = (start: number, end: number): TextSegment['parts'] => {
    if (errorAt === null || errorAt < start || errorAt >= end) {
      return [{ text: text.slice(start, end), error: false }];
    }
    return [
      { text: text.slice(start, errorAt), error: false },
      { text: text.slice(errorAt, errorAt + 1), error: true },
      { text: text.slice(errorAt + 1, end), error: false },
    ].filter((p) => p.text !== '');
  };

  const out: TextSegment[] = [];
  let at = 0;
  for (const r of kept) {
    if (r.start > at) out.push({ kind: 'text', parts: split(at, r.start) });
    out.push({ kind: r.kind, parts: split(r.start, r.end) });
    at = r.end;
  }
  if (at < text.length || out.length === 0) {
    out.push({ kind: 'text', parts: split(at, text.length) });
  }
  return out;
}
