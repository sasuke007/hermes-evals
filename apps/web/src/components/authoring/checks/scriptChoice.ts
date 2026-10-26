/**
 * Which script a new Verifier script check runs (SA.7, Phase 5b question 19): the picker's
 * card asks for it among the task's `verify/` files before the check is added, rather than
 * taking the first file, which may be data (`expected_summary.json`). Pure, so the picker
 * and its tests read the same rule.
 */

const isPython = (name: string): boolean => name.toLowerCase().endsWith('.py');

/** The files the card offers, by their name under `verify/`: Python files first. */
export function scriptOptions(names: readonly string[]): string[] {
  return [...names.filter(isPython), ...names.filter((n) => !isPython(n))];
}

/**
 * The script the card starts on: the task's only Python file, as the board draws
 * `check_summary.py`; none when there are several or none, so the author picks one.
 */
export function initialScript(names: readonly string[]): string | null {
  const python = names.filter(isPython);
  return python.length === 1 ? python[0]! : null;
}

/** Said under the card's Script field when it is picked without one. */
export const CHOOSE_SCRIPT_FIRST = 'Choose the script first.';
