/**
 * `self_check.answers_from_fixtures: true` (Phase 5b question 1, settled
 * for Phase 7): the one key of a hand-written task.yaml the generators own.
 *
 * The readiness rule `reference_leak` warns when a workspace file holds a
 * reference value. For a task whose answer is picked from its own data (a
 * list of invoice numbers or IBANs, a bin code, vendor totals equal to one
 * invoice's amount) that is expected, and the task says so with this key,
 * which silences the warning and changes nothing else. A generator marks
 * such a task (`answersFromFixtures` on its task), and writes the task's
 * task.yaml as the repository holds it with the block appended when it is
 * not there yet. The rest of the file stays the author's: an edit by hand
 * is reproduced as it is, so `--check` and the `--out` comparisons only
 * check that the key is set.
 *
 * Plain Node (25 strips the types): no enums, no parameter properties.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The block a marked task's task.yaml ends with. */
export const ANSWERS_FROM_FIXTURES_BLOCK = 'self_check:\n  answers_from_fixtures: true\n';

/** The repository root, where the hand-written task.yaml files are read (also under `--out`). */
const REPO = join(import.meta.dirname, '..', '..');

/**
 * `taskYaml` ending with the block: as it is when it does already, else
 * with the block appended. A task.yaml with a self_check block of its own
 * is refused: the key belongs in that block, written by hand.
 */
export function withAnswersFromFixtures(taskYaml: string, where: string): string {
  if (taskYaml.endsWith(ANSWERS_FROM_FIXTURES_BLOCK)) return taskYaml;
  if (/^self_check:/m.test(taskYaml)) {
    throw new Error(
      `${where}/task.yaml has a self_check block: add answers_from_fixtures: true to it by hand`,
    );
  }
  const body = taskYaml.endsWith('\n') ? taskYaml : `${taskYaml}\n`;
  return `${body}${ANSWERS_FROM_FIXTURES_BLOCK}`;
}

/** The task.yaml a generator writes for a marked task of `suite` (e.g. `suites/invoices-v1`). */
export function markedTaskYaml(suite: string, key: string): string {
  const where = `${suite}/${key}`;
  return withAnswersFromFixtures(readFileSync(join(REPO, where, 'task.yaml'), 'utf8'), where);
}
