/**
 * Small formatting rules shared by the suite and task views, so every page
 * writes thresholds, paths and timestamps the same way.
 */
import type { SuiteChangeSet, SuiteChanges } from '@hermes-evals/shared';

/** How suite directories are shown: relative to the repository, as authors edit them. */
export const SUITES_DISPLAY_ROOT = './suites';

/** `invoices-v1` → `./suites/invoices-v1`. */
export const suiteDisplayPath = (sourcePath: string): string =>
  `${SUITES_DISPLAY_ROOT}/${sourcePath}`;

/** `./suites/invoices-v1/total_due/task.yaml`. */
export const taskYamlDisplayPath = (sourcePath: string, key: string): string =>
  `${suiteDisplayPath(sourcePath)}/${key}/task.yaml`;

/** Fixtures are stored as `fixtures/<path>` and land at `<path>` in the workspace. */
const FIXTURES_PREFIX = 'fixtures/';

/** A fixture's path as the agent sees it in its workspace: `fixtures/a/b.csv` → `a/b.csv`. */
export const fixtureDisplayPath = (taskFilePath: string): string =>
  taskFilePath.startsWith(FIXTURES_PREFIX)
    ? taskFilePath.slice(FIXTURES_PREFIX.length)
    : taskFilePath;

/**
 * A 0 to 1 threshold or score as task.yaml authors write it: `1.0`, `0.7`,
 * `0.75`. Whole numbers keep one decimal so `1` and `1.0` read alike.
 */
export function formatThreshold(value: number): string {
  return Number.isInteger(value) ? value.toFixed(1) : String(round(value));
}

/** A plain number without floating-point noise: 0.1 + 0.2 → `0.3`. */
export function formatNumber(value: number): string {
  return String(round(value));
}

/** Rounds away binary noise (12 significant digits) without changing intended digits. */
export const round = (value: number): number => Number(value.toPrecision(12));

/** A database timestamp as the view models carry it. */
export const isoTime = (value: Date): string => value.toISOString();

export function emptyChangeSet(): SuiteChangeSet {
  return { added: [], removed: [], changed: [], nowInvalid: [], nowValid: [] };
}

/** suite_sources.last_changes (snake_case, nullable) → the view's change set. */
export function changeSetView(changes: SuiteChanges | null | undefined): SuiteChangeSet {
  if (!changes) return emptyChangeSet();
  return {
    added: [...changes.added],
    removed: [...changes.removed],
    changed: [...changes.changed],
    nowInvalid: [...changes.now_invalid],
    nowValid: [...changes.now_valid],
  };
}

/** `a, b and c` for headlines and explanations. */
export function listPhrase(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** The last path segment: `verify/check.py` → `check.py`. */
export const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
