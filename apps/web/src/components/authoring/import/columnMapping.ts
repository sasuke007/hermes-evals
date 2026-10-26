/**
 * What each column of an imported CSV or JSONL file becomes (ColumnMapper,
 * SA.9 step 2), and what the mapping as a whole lacks. Pure, so the mapper,
 * the import page, the fixtures and their tests read the same rules; the API
 * checks the same ones again when it builds the preview.
 */
import {
  TASK_IMPORT_COLUMN_USE_LABELS,
  TASK_IMPORT_COLUMN_USES,
  type TaskImportColumnUse,
} from '@hermes-evals/shared';
import type { TaskTableColumn } from '@/api/types/authoring';

export interface ColumnMapping {
  column: string;
  use: TaskImportColumnUse;
}

export interface MappingMessage {
  severity: 'problem' | 'info';
  message: string;
  /** The column the problem sits on (its select is outlined), when there is one. */
  column: string | null;
}

/** The "Use as" options, in the board's order. */
export const USE_OPTIONS = TASK_IMPORT_COLUMN_USES.map((use) => ({
  value: use,
  label: TASK_IMPORT_COLUMN_USE_LABELS[use],
}));

/** Column names that suggest a use, so a typical file maps itself. */
const GUESSES: [TaskImportColumnUse, RegExp][] = [
  ['task_key', /^(task_?)?key$|^id$/i],
  ['summary', /^(summary|title)$/i],
  ['prompt', /^(prompt|question|task)$/i],
  ['reference', /^(reference|reference_json)$/i],
  ['reference_value', /^(expected|answer|value|reference_value)$/i],
];

/** A first mapping: each use to the first column whose name suggests it, the rest ignored. */
export function guessMapping(columns: readonly TaskTableColumn[]): ColumnMapping[] {
  const taken = new Set<TaskImportColumnUse>();
  return columns.map(({ name }) => {
    const hit = GUESSES.find(([use, pattern]) => !taken.has(use) && pattern.test(name.trim()));
    if (!hit) return { column: name, use: 'ignore' };
    taken.add(hit[0]);
    return { column: name, use: hit[0] };
  });
}

const usesOf = (mapping: readonly ColumnMapping[], use: TaskImportColumnUse) =>
  mapping.filter((m) => m.use === use);

/** True when a column gives every task its key; otherwise a key prefix generates them. */
export const hasKeyColumn = (mapping: readonly ColumnMapping[]): boolean =>
  usesOf(mapping, 'task_key').length > 0;

/**
 * What the mapping lacks, problems first: a prompt, a reference, a use given
 * to two columns. A missing summary is a note: summaries are then taken from
 * each prompt. The first two sentences are SA.9's; the others are ours.
 */
export function mappingMessages(mapping: readonly ColumnMapping[]): MappingMessage[] {
  const problems: MappingMessage[] = [];
  for (const use of TASK_IMPORT_COLUMN_USES) {
    const columns = usesOf(mapping, use);
    if (use !== 'ignore' && columns.length > 1) {
      problems.push({
        severity: 'problem',
        message: `Map only one column to ${TASK_IMPORT_COLUMN_USE_LABELS[use]}.`,
        column: columns[1]!.column,
      });
    }
  }
  const prompts = usesOf(mapping, 'prompt');
  if (prompts.length === 0) {
    const ignored = mapping.find((m) => m.use === 'ignore');
    problems.unshift({
      severity: 'problem',
      message: 'Map one column to Prompt.',
      column: ignored?.column ?? null,
    });
  }
  const whole = usesOf(mapping, 'reference');
  const value = usesOf(mapping, 'reference_value');
  if (whole.length === 0 && value.length === 0) {
    problems.push({
      severity: 'problem',
      message: 'Map one column to Reference or Reference value.',
      column: null,
    });
  } else if (whole.length > 0 && value.length > 0) {
    problems.push({
      severity: 'problem',
      message: 'Map Reference or Reference value, not both.',
      column: value[0]!.column,
    });
  }
  const notes: MappingMessage[] =
    usesOf(mapping, 'summary').length === 0
      ? [
          {
            severity: 'info',
            message:
              'No column is mapped to Summary. Summaries are taken from the first 80 characters of each prompt.',
            column: null,
          },
        ]
      : [];
  return [...problems, ...notes];
}

/** True when the mapping can be used: no problem in mappingMessages. */
export const mappingReady = (mapping: readonly ColumnMapping[]): boolean =>
  mappingMessages(mapping).every((m) => m.severity !== 'problem');

/** Where a column's values go (the "Goes to" column). */
export type ColumnZone = 'visible' | 'hidden' | 'metadata' | 'none';

export function zoneOf(use: TaskImportColumnUse): ColumnZone {
  if (use === 'prompt') return 'visible';
  if (use === 'reference' || use === 'reference_value') return 'hidden';
  if (use === 'task_key' || use === 'summary') return 'metadata';
  return 'none';
}
