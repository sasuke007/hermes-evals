/**
 * The shared settings of Import tasks (SA.9 step 3): the settings a file starts with, the
 * check its reference values suggest, the sentence a new check reads as, and the sample
 * reference the paragraph's shape is built from. Pure.
 */
import {
  suggestedCheckType,
  type JsonValue,
  type ScorerType,
  type TaskImportColumnUse,
} from '@hermes-evals/shared';
import type { TaskFormCheck, TaskImportSettings, TaskTableFile } from '@/api/types/authoring';
import { guessMapping, type ColumnMapping } from './columnMapping';

/** The picker's words for a check type (CheckPicker board). */
export const TYPE_LABELS: Record<ScorerType, string> = {
  numeric_tolerance: 'Number within tolerance',
  json_match: 'JSON match',
  exact_match: 'Exact text',
  text_match: 'Text match',
  file_check: 'File check',
  trajectory_match: 'Tool use',
  llm_judge: 'Rubric judge',
  verifier_script: 'Verifier script',
};

/** The value the primary check reads: the reference's value at the answer path, or all of it. */
export function valueAtAnswer(
  reference: JsonValue | undefined,
  answerPath: string | null,
): JsonValue | undefined {
  if (
    !answerPath ||
    reference === null ||
    typeof reference !== 'object' ||
    Array.isArray(reference)
  )
    return reference;
  return reference[answerPath];
}

/**
 * The one check a new import starts with: the type the value at the answer path suggests,
 * primary, key `answer`.
 */
export function newCheckFor(value: JsonValue | undefined): TaskFormCheck {
  const type = suggestedCheckType(value) ?? 'exact_match';
  return {
    key: 'answer',
    type,
    primary: true,
    params: type === 'numeric_tolerance' ? { abs: 0 } : {},
  };
}

/** "numeric_tolerance on `answer`, abs 0". */
export function checkSentence(check: TaskFormCheck, answerPath: string | null): string {
  const on = answerPath ? ` on ${answerPath}` : '';
  const abs = check.params.abs;
  return `${check.type}${on}${typeof abs === 'number' ? `, abs ${abs}` : ''}`;
}

const parse = (text: string): JsonValue => {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
};

/**
 * The reference the first row gives under the mapping: its whole-JSON column, or its value
 * column put at the answer path. Undefined without a sample.
 */
export function sampleReference(
  file: TaskTableFile,
  mapping: readonly ColumnMapping[],
  answerPath: string | null,
): JsonValue | undefined {
  const column = (use: TaskImportColumnUse) =>
    file.columns.find((c) => mapping.find((m) => m.column === c.name)?.use === use);
  const whole = column('reference');
  if (whole?.samples[0] !== undefined) return parse(whole.samples[0]);
  const value = column('reference_value');
  if (value?.samples[0] === undefined) return undefined;
  const v = parse(value.samples[0]);
  return answerPath ? { [answerPath]: v } : v;
}

/** The key prefix a file suggests: its name's first word and `_q` (`overdue_questions.csv` → `overdue_q`). */
export function suggestedPrefix(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, '').toLowerCase();
  const word = /^[a-z0-9]+/.exec(stem)?.[0] ?? 'task';
  return `${word}_q`;
}

/** The settings a file starts with: its guessed mapping, shared files and checks from the draft's first task. */
export function initialSettings(
  file: TaskTableFile,
  taskKeys: readonly string[],
): TaskImportSettings {
  const mapping = guessMapping(file.columns);
  const answerPath = 'answer';
  const first = taskKeys[0];
  return {
    mapping,
    keyPrefix: suggestedPrefix(file.fileName),
    answerPath,
    workspace: first ? { from: 'task', key: first } : { from: 'none' },
    checks: {
      from: 'new',
      checks: [newCheckFor(valueAtAnswer(sampleReference(file, mapping, answerPath), answerPath))],
    },
    limits: { maxTurns: 20, runBudgetSeconds: 300, toolsetsNeeded: ['file', 'terminal'] },
    appendAnswerInstructions: true,
    keyFixes: [],
  };
}
