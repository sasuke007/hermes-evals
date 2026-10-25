/**
 * Lays the API's line diff (TextDiffLine[]: every line once, removed before added within a
 * change) out side by side, as the TaskDiff board draws it: the old version on the left,
 * the new on the right, a changed line paired with its replacement and the part that
 * differs marked, an added or removed line opposite an empty cell. Long unchanged stretches
 * fold to a few lines of context.
 */
import type { TextDiffLine } from '@/api/types/suites';

export interface DiffPart {
  text: string;
  /** The part of a changed line that differs from its pair. */
  marked: boolean;
}

export interface DiffCell {
  /** Line number on this side; null for an empty cell. */
  n: number | null;
  kind: 'same' | 'removed' | 'added' | 'empty';
  parts: DiffPart[];
}

export interface DiffRow {
  left: DiffCell;
  right: DiffCell;
  changed: boolean;
}

const EMPTY: DiffCell = { n: null, kind: 'empty', parts: [] };

/** Marks what differs between a removed line and the added line that replaces it. */
function markPair(before: string, after: string): [DiffPart[], DiffPart[]] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++;
  }
  const split = (text: string): DiffPart[] => {
    const middle = text.slice(start, text.length - end);
    // Nothing in common: the whole line is the change, and the row colour says so.
    if (start === 0 && end === 0) return [{ text, marked: false }];
    return [
      { text: text.slice(0, start), marked: false },
      { text: middle, marked: true },
      { text: text.slice(text.length - end), marked: false },
    ].filter((p) => p.text !== '');
  };
  return [split(before), split(after)];
}

const plain = (text: string): DiffPart[] => [{ text, marked: false }];

/** Side-by-side rows of a line diff. */
export function sideBySide(lines: readonly TextDiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === 'same') {
      rows.push({
        left: { n: line.oldLine, kind: 'same', parts: plain(line.text) },
        right: { n: line.newLine, kind: 'same', parts: plain(line.text) },
        changed: false,
      });
      i++;
      continue;
    }
    const removed: TextDiffLine[] = [];
    const added: TextDiffLine[] = [];
    while (i < lines.length && lines[i]!.kind === 'removed') removed.push(lines[i++]!);
    while (i < lines.length && lines[i]!.kind === 'added') added.push(lines[i++]!);
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const r = removed[k];
      const a = added[k];
      const [left, right] =
        r && a ? markPair(r.text, a.text) : [plain(r?.text ?? ''), plain(a?.text ?? '')];
      rows.push({
        left: r ? { n: r.oldLine, kind: 'removed', parts: left } : EMPTY,
        right: a ? { n: a.newLine, kind: 'added', parts: right } : EMPTY,
        changed: true,
      });
    }
  }
  return rows;
}

/** "1 line changed", "3 lines added", "new file". */
export function diffCaption(lines: readonly TextDiffLine[]): string {
  const removed = lines.filter((l) => l.kind === 'removed').length;
  const added = lines.filter((l) => l.kind === 'added').length;
  const lines_ = (n: number): string => `${n} line${n === 1 ? '' : 's'}`;
  if (removed === 0 && added > 0 && added === lines.length) return 'new file';
  if (added === 0 && removed > 0 && removed === lines.length) return 'file removed';
  if (removed === 0) return `${lines_(added)} added`;
  if (added === 0) return `${lines_(removed)} removed`;
  return `${lines_(Math.max(added, removed))} changed`;
}

export type DiffItem =
  { kind: 'row'; row: DiffRow } | { kind: 'fold'; id: number; rows: DiffRow[] };

/**
 * The rows with unchanged stretches longer than `context` lines either side of a change
 * folded into one item each (opened by the reader).
 */
export function foldRows(rows: readonly DiffRow[], context = 3): DiffItem[] {
  const near = rows.map((_, i) => rows.some((r, j) => r.changed && Math.abs(i - j) <= context));
  const items: DiffItem[] = [];
  let run: DiffRow[] = [];
  let id = 0;
  const flush = (): void => {
    // Folding fewer than three lines saves nothing.
    if (run.length < 3) items.push(...run.map((row) => ({ kind: 'row' as const, row })));
    else items.push({ kind: 'fold', id: id++, rows: run });
    run = [];
  };
  rows.forEach((row, i) => {
    if (row.changed || near[i]) {
      flush();
      items.push({ kind: 'row', row });
    } else run.push(row);
  });
  flush();
  return items;
}
