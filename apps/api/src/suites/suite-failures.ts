/**
 * Failure panels for the invalid tasks of one suite version. Each is compared
 * with the same task key as the previous load of its directory checked it,
 * which tells the panel how that check did then and which files changed since.
 */
import type { SelfCheckFailureView } from '@hermes-evals/shared';
import type { AppDb } from '../database/types.js';
import { filesOf, keyRowsInDirectory } from './suites.queries.js';
import { changedFiles } from './views/changes.js';
import { isoTime } from './views/format.js';
import type { SuiteRow, TaskFileRow, TaskRow } from './views/rows.js';
import { selfCheckFailureView } from './views/self-check-failure.js';
import { contentOf } from './views/task-views.js';

/** Panels by task key, for the invalid ones among `tasks` (all of suite version `suite`). */
export async function failuresOf(
  db: AppDb,
  suite: SuiteRow,
  tasks: readonly TaskRow[],
  filesByTask: ReadonlyMap<string, readonly TaskFileRow[]>,
): Promise<Map<string, SelfCheckFailureView>> {
  const invalid = tasks.filter((t) => !t.valid);
  const out = new Map<string, SelfCheckFailureView>();
  if (invalid.length === 0) return out;
  const earlier = await keyRowsInDirectory(
    db,
    suite.sourcePath,
    invalid.map((t) => t.key),
    suite.versionNumber,
  );
  // Rows come lowest suite version first, so the last one per key is the previous load's.
  const previousByKey = new Map(earlier.map((row) => [row.task.key, row]));
  const previousFiles = groupByTask(
    await filesOf(
      db,
      [...previousByKey.values()].map((p) => p.task.id),
    ),
  );
  for (const task of invalid) {
    const previous = previousByKey.get(task.key) ?? null;
    const view = selfCheckFailureView({
      sourcePath: suite.sourcePath,
      taskKey: task.key,
      valid: task.valid,
      invalidReason: task.invalidReason,
      verification: task.verification,
      selfCheck: task.selfCheck,
      loadIssues: task.loadIssues,
      loadedAt: isoTime(suite.loadedAt),
      previous: previous && {
        selfCheck: previous.task.selfCheck,
        verification: previous.task.verification,
        ranAt: isoTime(previous.suite.loadedAt),
      },
      changedSincePrevious: previous
        ? changedFiles(
            contentOf({ ...previous, files: previousFiles.get(previous.task.id) ?? [] }),
            contentOf({ task, suite, files: filesByTask.get(task.id) ?? [] }),
          )
        : [],
    });
    if (view) out.set(task.key, view);
  }
  return out;
}

/** Task files (or root files) grouped by task id, each group in the order given. */
export function groupByTask<T extends Pick<TaskFileRow, 'taskId'>>(
  files: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const file of files) {
    const list = out.get(file.taskId) ?? [];
    list.push(file);
    out.set(file.taskId, list);
  }
  return out;
}
