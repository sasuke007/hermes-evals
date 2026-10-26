/**
 * How the Suites pages word drafts and a Reload all in progress (SA.1, Phase 5b): the draft
 * chip and its tooltip, a folder's line while Reload all runs one folder at a time, and the
 * "Last change" of a row from the changes that created its current version. Pure.
 */
import type { DraftSummary } from '@/api/types/authoring';
import type { SuiteListRow, SuiteReloadProgressEntry } from '@/api/types/suites';
import { MISSING, plural } from '@/lib/format';
import {
  changePhrases,
  keysText,
  reloadLine,
  type ChangePhrase,
  type LoadLine,
} from './suiteFormat';

/** 16:31, local time: when a draft was last edited. */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return MISSING;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "draft · 3 changes". */
export const draftChipText = (draft: DraftSummary): string =>
  `draft · ${plural(draft.changeCount, 'change')}`;

/** "Draft based on v6, last edited 16:31", and when the folder moved on, that too. */
export function draftTooltip(draft: DraftSummary): string {
  const base =
    draft.baseVersion === null
      ? `Draft of a new suite, last edited ${hhmm(draft.updatedAt)}`
      : `Draft based on v${draft.baseVersion}, last edited ${hhmm(draft.updatedAt)}`;
  return draft.conflict ? `${base}. The suite changed on disk since.` : base;
}

/** A folder's line under "Last loaded" while Reload all runs. */
export function progressLine(entry: SuiteReloadProgressEntry): LoadLine {
  switch (entry.state) {
    case 'queued':
      return { text: 'Waiting to reload…', problem: false };
    case 'loading':
      return { text: 'Reloading and running self-checks…', problem: false };
    case 'failed':
      return { text: `Could not reload: ${entry.error ?? 'the job failed'}`, problem: true };
    default:
      return entry.entry ? reloadLine(entry.entry) : { text: 'Reloaded', problem: false };
  }
}

/**
 * "Last change" of a row: the first phrase of the changes that created its current version
 * (what became invalid first), so an unchanged reload keeps saying "1 changed: total_due".
 */
export function lastChangeOf(row: SuiteListRow): ChangePhrase | null {
  return changePhrases(row.currentChanges)[0] ?? null;
}

/** "1 changed: total_due", or "12 tasks added" for a first version's dozen. */
export function lastChangeText(phrase: ChangePhrase): { lead: string; keys: string } {
  const keys = keysText(phrase);
  if (phrase.kind === 'added' && keys === plural(phrase.keys.length, 'task'))
    return { lead: `${keys} added`, keys: '' };
  return { lead: `${phrase.keys.length} ${phrase.kind}:`, keys };
}

/** True for a folder whose last load found it gone from disk. */
export const isMissing = (row: SuiteListRow): boolean => row.lastLoad.outcome === 'missing';
