/**
 * The one-line result of reloading a directory, as the suite list shows it
 * under "Last loaded" (UI_FLOWS 8.1): "All 12 self-checks passed",
 * "1 task now invalid: late_fees", "Unchanged since v3", "Reverted to v2",
 * "Could not reload: suite.yaml:4:3 · …", "Missing from disk".
 */
import type { SuiteChanges } from '@hermes-evals/shared';
import type { LocatedError } from './yaml-source.js';

/** Keys named in one phrase before the rest are counted. */
const MAX_NAMED = 5;

export const MISSING_MESSAGE = 'Missing from disk';

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function names(keys: readonly string[]): string {
  const shown = keys.slice(0, MAX_NAMED).join(', ');
  return keys.length > MAX_NAMED ? `${shown} and ${keys.length - MAX_NAMED} more` : shown;
}

const counted = (keys: readonly string[], what: string): string =>
  `${plural(keys.length, 'task')} ${what}: ${names(keys)}`;

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Validity phrases: what became invalid or valid again. */
function validityParts(changes: SuiteChanges): string[] {
  const parts: string[] = [];
  if (changes.now_invalid.length > 0) parts.push(counted(changes.now_invalid, 'now invalid'));
  if (changes.now_valid.length > 0) parts.push(`${names(changes.now_valid)} valid again`);
  return parts;
}

export interface CreatedSummary {
  /** No version of the directory was current before. */
  first: boolean;
  changes: SuiteChanges;
  tasks: readonly { key: string; valid: boolean }[];
  /** The latest earlier version with the same content hash, when only the check hash differs. */
  sameFilesAs: number | null;
}

export function createdMessage(s: CreatedSummary): string {
  const parts: string[] = [];
  if (!s.first) {
    if (s.changes.changed.length > 0) parts.push(counted(s.changes.changed, 'changed'));
    if (s.changes.added.length > 0) parts.push(counted(s.changes.added, 'added'));
    if (s.changes.removed.length > 0) parts.push(counted(s.changes.removed, 'removed'));
    if (parts.length === 0 && s.sameFilesAs !== null) {
      parts.push(`same files as v${s.sameFilesAs}, re-checked`);
    }
  }
  parts.push(...validityParts(s.changes));
  const invalid = s.tasks.filter((t) => !t.valid).map((t) => t.key);
  const stillInvalid = invalid.filter((k) => !s.changes.now_invalid.includes(k));
  if (stillInvalid.length > 0) parts.push(counted(stillInvalid, 'still invalid'));
  if (invalid.length === 0) {
    const n = s.tasks.length;
    if (n === 0) parts.push('no tasks found');
    else if (parts.length > 0) parts.push('all self-checks passed');
    else parts.push(n === 1 ? 'the self-check passed' : `all ${n} self-checks passed`);
  }
  return capitalise(parts.join(' · '));
}

export const unchangedMessage = (versionNumber: number): string =>
  `Unchanged since v${versionNumber}`;

export function revertedMessage(versionNumber: number, changes: SuiteChanges): string {
  return [`Reverted to v${versionNumber}`, ...validityParts(changes)].join(' · ');
}

/**
 * `Could not reload: vat_split/task.yaml:14:9 · <message>` (UI_FLOWS 8.1),
 * with the file's line and column when the error has them; the message
 * alone after the prefix when it has none.
 */
export function errorMessage(error: LocatedError): string {
  if (error.line === null) return `Could not reload: ${error.message}`;
  const at = error.column === null ? `${error.line}` : `${error.line}:${error.column}`;
  return `Could not reload: ${error.file}:${at} · ${error.message}`;
}

/**
 * Why a reload of every suite left a directory out (Phase 3 question 14):
 * the suites before it already declared most of the self-check time one
 * load-suites job may take. A reload of that directory alone has it all.
 */
export const deferredMessage = (
  path: string,
  seconds: number,
  usedS: number,
  budgetS: number,
): string =>
  `not loaded by this reload: its self-checks may take up to ${seconds} s, and the suites ` +
  `before it already declared ${usedS} of the ${budgetS} s one reload may take; reload ${path} ` +
  'on its own';
