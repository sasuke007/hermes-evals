/**
 * How a draft conflict reads (DraftConflict board, SA.12): the folder changed on disk after
 * the draft began, so the draft must be combined onto the newer version, keeping one side of
 * each task both changed. The amber SuiteDraftBar and the resolver read the same sentences
 * from here; backticks mark code (CodeText). Pure.
 */
import type { DraftConflict, RebaseSuiteDraftRequest } from '@/api/types/authoring';
import { changePhrases } from '@/components/suites/suiteFormat';
import { hhmm } from '@/components/suites/authoringFormat';

/** Which side of an overlapping task to keep: the draft's, or the version's on disk. */
export type ConflictChoice = 'mine' | 'disk';
export type ConflictChoices = Partial<Record<string, ConflictChoice>>;

const code = (keys: readonly string[]): string => keys.map((k) => `\`${k}\``).join(', ');

/** "`./suites/invoices-v1` changed on disk after this draft began." */
export const conflictHeadline = (path: string): string =>
  `\`${path}\` changed on disk after this draft began.`;

/** "A reload at 16:40 created v7 (`late_fees` now valid). Your draft is based on v6." */
export function conflictCause(conflict: DraftConflict): string {
  // What the reload did to validity says most; otherwise what it changed.
  const phrases = changePhrases(conflict.diskChanges, 'history');
  const validity = phrases.filter((p) => p.kind === 'now valid' || p.kind === 'now invalid');
  const what = (validity.length ? validity : phrases)
    .map((p) => `${code(p.keys)} ${p.kind}`)
    .join(', ');
  const verb =
    conflict.cause === 'disk_changed'
      ? `Saving found files edited on disk and loaded them as v${conflict.current.versionNumber}`
      : `A reload at ${hhmm(conflict.current.loadedAt)} created v${conflict.current.versionNumber}`;
  return `${verb}${what ? ` (${what})` : ''}. Your draft is based on v${conflict.baseVersion}.`;
}

/** Tasks the newer version changed (any kind), for "don't touch late_fees". */
function diskKeys(conflict: DraftConflict): string[] {
  const c = conflict.diskChanges;
  return [...new Set([...c.changed, ...c.added, ...c.removed, ...c.nowInvalid, ...c.nowValid])];
}

/**
 * The second line: whether the two sides touch the same tasks, and what to do.
 * "Your changes (`overdue_count`, `total_due`) don't touch `late_fees`. They can be combined."
 */
export function conflictGuidance(conflict: DraftConflict, choices: ConflictChoices): string {
  if (conflict.overlap.length === 0) {
    const theirs = diskKeys(conflict);
    const mine = conflict.draftKeys.length ? ` (${code(conflict.draftKeys)})` : '';
    return theirs.length
      ? `Your changes${mine} don't touch ${code(theirs)}. They can be combined.`
      : `Your changes${mine} can be combined onto it.`;
  }
  const both = `Both changed ${code(conflict.overlap)}.`;
  return unchosen(conflict, choices).length === 0
    ? `${both} You chose a version for ${conflict.overlap.length === 1 ? 'it' : 'each'}, so the draft can be combined.`
    : `${both} Choose which version to keep below, then combine.`;
}

/** Overlapping tasks with no choice yet. */
export const unchosen = (conflict: DraftConflict, choices: ConflictChoices): string[] =>
  conflict.overlap.filter((key) => !choices[key]);

/** Why Combine is disabled: "Choose a version for total_due first."; null when it is not. */
export function combineBlockedReason(
  conflict: DraftConflict,
  choices: ConflictChoices,
): string | null {
  const open = unchosen(conflict, choices);
  return open.length ? `Choose a version for ${open.join(', ')} first.` : null;
}

/** "Combine onto v7". */
export const combineLabel = (conflict: DraftConflict): string =>
  `Combine onto v${conflict.current.versionNumber}`;

/** The body of POST …/draft/rebase for the choices made. */
export function rebaseRequest(
  conflict: DraftConflict,
  choices: ConflictChoices,
): RebaseSuiteDraftRequest {
  return {
    onto: conflict.current.versionNumber,
    choices: conflict.overlap.map((key) => ({ key, keep: choices[key] ?? 'mine' })),
  };
}
