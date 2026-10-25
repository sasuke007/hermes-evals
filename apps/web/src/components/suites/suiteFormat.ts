/**
 * How the Suites pages word versions, changes and load results (SuiteList,
 * SuiteDetail, TaskDetail, TaskDiff boards). Pure functions, so the pages and their tests
 * read the same words.
 */
import type { JsonValue } from '@hermes-evals/shared';
import type {
  SuiteChangeSet,
  SuiteLastLoad,
  SuiteListRow,
  SuiteReloadEntry,
  TaskVersionEntry,
} from '@/api/types/suites';
import { plural } from '@/lib/format';

/** "v2", or "v2 (reverted)" when the directory pointed back at that version's files. */
export const versionLabel = (versionNumber: number, reverted = false): string =>
  `v${versionNumber}${reverted ? ' (reverted)' : ''}`;

/** A task's folder from its task.yaml path: ./suites/invoices-v1/dup_invoices/. */
export const taskFolderOf = (taskYamlPath: string): string =>
  taskYamlPath.replace(/task\.yaml$/, '');

/** The kinds of change one reload records, in the order the list and History name them. */
export type ChangeKind = 'now invalid' | 'changed' | 'added' | 'removed' | 'now valid';

export interface ChangePhrase {
  kind: ChangeKind;
  keys: string[];
}

/**
 * The change set as phrases. `attention` (the list's one-line "Last change") puts what became
 * invalid first; `history` (the History panel) reads as the reload happened: what changed,
 * then what that did to validity.
 */
export function changePhrases(
  changes: SuiteChangeSet,
  order: 'attention' | 'history' = 'attention',
): ChangePhrase[] {
  const invalid: ChangePhrase = { kind: 'now invalid', keys: changes.nowInvalid };
  const files: ChangePhrase[] = [
    { kind: 'changed', keys: changes.changed },
    { kind: 'added', keys: changes.added },
    { kind: 'removed', keys: changes.removed },
  ];
  const valid: ChangePhrase = { kind: 'now valid', keys: changes.nowValid };
  const all = order === 'attention' ? [invalid, ...files, valid] : [...files, invalid, valid];
  return all.filter((p) => p.keys.length > 0);
}

/**
 * The keys of a change as one line: up to `max` names, then "+N". A first load's dozen
 * added tasks read "12 tasks", as History draws them.
 */
export function keysText(phrase: ChangePhrase, max = 3): string {
  if (phrase.kind === 'added' && phrase.keys.length > max)
    return plural(phrase.keys.length, 'task');
  const shown = phrase.keys.slice(0, max).join(', ');
  return phrase.keys.length > max ? `${shown} +${phrase.keys.length - max}` : shown;
}

/** History's chip colours per change kind (SuiteDetail board). */
export const CHANGE_CLASSES: Record<ChangeKind, string> = {
  added: 'bg-pass-soft text-pass-text',
  removed: 'bg-que-soft text-que-text',
  changed: 'bg-run-soft text-run-text',
  'now invalid': 'bg-fail-soft text-fail-text',
  'now valid': 'bg-pass-soft text-pass-text',
};

const validityTail = (load: SuiteLastLoad): string => {
  const invalid = load.changes.nowInvalid.length;
  if (invalid > 0) return `${plural(invalid, 'task')} now invalid`;
  if (load.changes.nowValid.length > 0) return `${load.changes.nowValid.join(', ')} valid again`;
  return '';
};

export interface LoadLine {
  text: string;
  /** The line is a problem: drawn in the fail colour. */
  problem: boolean;
}

/**
 * The caption under "Last loaded" for a row nobody reloaded in this session, from the
 * directory's last load: "All self-checks passed", "Created v6 · 1 task now invalid",
 * "Reverted to v1", "Could not reload", "Missing from disk".
 */
export function lastLoadLine(row: SuiteListRow): LoadLine {
  const load = row.lastLoad;
  const invalid = row.taskCount - row.validCount;
  const stillInvalid =
    invalid > 0 ? `${plural(invalid, 'task')} invalid` : 'All self-checks passed';
  switch (load.outcome) {
    case 'error':
      return { text: 'Could not reload', problem: true };
    case 'missing':
      return { text: 'Missing from disk', problem: true };
    case 'created': {
      const tail = validityTail(load) || (invalid > 0 ? stillInvalid : 'all self-checks passed');
      return { text: `Created v${row.versionNumber} · ${tail}`, problem: invalid > 0 };
    }
    case 'reverted': {
      const tail = validityTail(load);
      return {
        text: tail
          ? `Reverted to v${row.versionNumber} · ${tail}`
          : `Reverted to v${row.versionNumber}`,
        problem: invalid > 0,
      };
    }
    default:
      return { text: stillInvalid, problem: invalid > 0 };
  }
}

/** The caption after this session's reload: the API's own line, prefixed "Created v6 · ". */
export function reloadLine(entry: SuiteReloadEntry): LoadLine {
  const problem =
    entry.outcome === 'error' || entry.outcome === 'missing' || entry.changes.nowInvalid.length > 0;
  const text =
    entry.outcome === 'created' && entry.versionNumber !== null
      ? `Created v${entry.versionNumber} · ${entry.message}`
      : entry.message;
  return { text, problem };
}

/** History's title of a task version: "First version", "Changed fixtures/policy_terms.json only". */
export function taskVersionTitle(entry: TaskVersionEntry, oldest: boolean): string {
  if (oldest) return 'First version';
  if (entry.changedFiles.length === 0) return 'Same files, re-checked';
  if (entry.changedFiles.length === 1) return `Changed ${entry.changedFiles[0]} only`;
  return `Changed ${entry.changedFiles.join(', ')}`;
}

const isScalar = (v: JsonValue): v is string | number | boolean | null =>
  v === null || typeof v !== 'object';

/**
 * JSON as reference.json reads on TaskDetail: two-space indent, with a list of plain values
 * kept on one line (["INV-0988", "INV-1131"]).
 */
export function formatJson(value: JsonValue, indent = ''): string {
  if (isScalar(value)) return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every(isScalar)) return `[${value.map((v) => JSON.stringify(v)).join(', ')}]`;
    return `[\n${value.map((v) => inner + formatJson(v, inner)).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return '{}';
  return `{\n${entries
    .map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJson(v, inner)}`)
    .join(',\n')}\n${indent}}`;
}

/** A JSON value inline, for a reference diff entry: 48213.65, "INV-1031", ["a", "b"]. */
export function inlineJson(value: JsonValue | null): string {
  if (value === null) return 'null';
  return formatJson(value).replace(/\n\s*/g, ' ');
}
