/**
 * The words of a suite draft (SA.3): its changes as chips ("added `overdue_count`", "label
 * `0.3 → 0.4`"), the bar's line ("based on v6 · 3 changes · saved 16:31"), and each task
 * row's version and change. The conflict's sentences are in ../conflict/conflict.ts.
 */
import type { DraftChange, DraftTaskRow, SuiteDraftView } from '@/api/types/authoring';
import { formatClock, plural } from '@/lib/format';

/** 16:31, from an API or fixture time. */
export const hhmm = (iso: string): string => formatClock(iso).slice(0, 5);

export interface ChangeChip {
  kind: string;
  target: string;
}

export function changeChip(change: DraftChange): ChangeChip {
  switch (change.kind) {
    case 'added':
      return {
        kind: change.renamedFrom ? `renamed from ${change.renamedFrom}` : 'added',
        target: change.key,
      };
    case 'changed':
    case 'removed':
      return { kind: change.kind, target: change.key };
    case 'restored':
      return { kind: `restored from v${change.fromTaskVersion}`, target: change.key };
    case 'label':
      return { kind: 'label', target: `${change.from ?? '—'} → ${change.to}` };
    case 'description':
      return { kind: 'description', target: 'edited' };
    case 'order':
      return { kind: 'order', target: 'changed' };
  }
}

/** "based on v6 · 3 changes · saved 16:31"; "saving…" while a write is on its way. */
export function barMeta(draft: SuiteDraftView, saving: boolean): string {
  const saved = saving ? 'saving…' : `saved ${hhmm(draft.updatedAt)}`;
  const count = draft.changes.length;
  if (!draft.base) {
    const what = count === 0 ? 'not saved yet' : plural(count, 'change');
    return `new suite · ${what} · ${saved}`;
  }
  const base = draft.conflict ? draft.conflict.baseVersion : draft.base.versionNumber;
  return `based on v${base} · ${plural(count, 'change')} · ${saved}`;
}

/** The version column of the draft's task table: "v2 → v3 on save", "new · v1 on save". */
export function versionText(row: DraftTaskRow): string {
  if (row.state === 'added') return 'new · v1 on save';
  if (row.state === 'restored' && row.restoredFrom)
    return `v${row.baseVersion ?? '?'} → v${row.restoredFrom.taskVersion} on save`;
  if (row.state === 'changed' && row.baseVersion)
    return `v${row.baseVersion} → v${row.baseVersion + 1} on save`;
  return row.baseVersion ? `v${row.baseVersion}` : '—';
}

/** The change column: "added", "changed", "restored from v1", "removed". */
export function changeText(row: DraftTaskRow): string {
  if (row.state === 'restored' && row.restoredFrom)
    return `restored from v${row.restoredFrom.taskVersion}`;
  return row.state === 'unchanged' ? '' : row.state;
}

export const READINESS_WORDS = {
  ready: 'ready',
  warnings: 'warnings',
  problems: 'problems',
  not_run: 'self-check not run',
} as const;
