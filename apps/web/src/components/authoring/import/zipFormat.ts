/**
 * How ImportSuiteDialog words a validated zip (SA.10): the task counts, each task's line,
 * the chip beside the file and the scripts panel's sentence. Pure, so the dialog and its
 * tests read the same words.
 */
import { DIRECTORY_KEY_MESSAGE } from '@hermes-evals/shared';
import type { SuiteZipTask, SuiteZipValidation } from '@/api/types/authoring';
import { suiteNameProblem, type NameHolder } from '../new-suite/suiteName';
import { plural } from '@/lib/format';

/** How many tasks of the list show before "and N more valid: …". */
export const ZIP_TASKS_SHOWN = 8;

export const isInvalid = (task: SuiteZipTask): boolean => task.readiness === 'problems';
const isNotRun = (task: SuiteZipTask): boolean => task.readiness === 'not_run';

/** "12 · 11 valid", with the tasks whose self-check waits for the save. */
export function taskCountLine(tasks: readonly SuiteZipTask[]): string {
  const invalid = tasks.filter(isInvalid).length;
  const notRun = tasks.filter(isNotRun).length;
  const valid = tasks.length - invalid - notRun;
  const head = `${tasks.length} · ${valid} valid`;
  return notRun > 0 ? `${head} · ${notRun} self-check not run` : head;
}

/** The chip beside the file: "valid", or "1 invalid task". */
export function zipChip(validation: SuiteZipValidation): { text: string; tone: 'pass' | 'ung' } {
  const invalid = validation.tasks.filter(isInvalid).length;
  return invalid > 0
    ? { text: `${plural(invalid, 'invalid task')}`, tone: 'ung' }
    : { text: 'valid', tone: 'pass' };
}

/**
 * A task's line after its key: "valid · 2 workspace files · 1 check" in a one-task zip,
 * "valid" in a longer list; an invalid one names its problem.
 */
export function taskLine(task: SuiteZipTask, detailed: boolean): string {
  if (isInvalid(task)) return 'invalid';
  const state = isNotRun(task) ? 'self-check not run' : 'valid';
  if (!detailed) return state;
  return `${state} · ${plural(task.workspaceFiles, 'workspace file')} · ${plural(task.checks, 'check')}`;
}

/**
 * The tasks listed one by one, and the valid rest summed up on one line ("and 4 more valid:
 * per_vendor, …"): every invalid task, and every one whose self-check waits for the save,
 * is always listed.
 */
export function splitTasks(tasks: readonly SuiteZipTask[]): {
  shown: SuiteZipTask[];
  more: string[];
} {
  if (tasks.length <= ZIP_TASKS_SHOWN) return { shown: [...tasks], more: [] };
  const named = tasks.filter((t) => isInvalid(t) || isNotRun(t));
  const room = Math.max(0, ZIP_TASKS_SHOWN - named.length);
  const valid = tasks.filter((t) => !isInvalid(t) && !isNotRun(t));
  const keep = new Set([...named, ...valid.slice(0, room)]);
  return {
    shown: tasks.filter((t) => keep.has(t)),
    more: valid.slice(room).map((t) => t.key),
  };
}

/** "2 verifier scripts will run in the worker when the suite is checked and when runs are scored." */
export function scriptsSentence(count: number): string {
  return `${count === 1 ? '1 verifier script' : `${count} verifier scripts`} will run in the worker when the suite is checked and when runs are scored. Import only suites you trust.`;
}

/**
 * Why a new name cannot be used: not a folder name, or held by a suite or a draft.
 * Null when it can.
 */
export function newNameProblem(name: string, holders: readonly NameHolder[]): string | null {
  const problem = suiteNameProblem(name, holders);
  if (!problem) return null;
  if (problem.kind === 'empty') return 'Enter a name for the new suite.';
  if (problem.kind === 'invalid') return DIRECTORY_KEY_MESSAGE;
  return `${name} already exists.`;
}
