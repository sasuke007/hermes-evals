/**
 * Suite list, suite detail and suite history (GET /suites, /suites/:id,
 * /suites/:id/history). Reads rows, hands them to the view builders.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { SuiteDetail, SuiteHistoryEntry, SuiteListRow } from '@hermes-evals/shared';
import { DB } from '../database/db.provider.js';
import type { AppDb } from '../database/types.js';
import { notFound } from './http-errors.js';
import { failuresOf, groupByTask } from './suite-failures.js';
import {
  currentSuites,
  experimentsOn,
  filesOf,
  sourceOf,
  suiteById,
  taskStatesOf,
  tasksOf,
  versionsOf,
} from './suites.queries.js';
import type { SuiteRow } from './views/rows.js';
import { suiteDetail, suiteHistory, suiteListRow } from './views/suite-views.js';
import { suiteTaskRow } from './views/task-views.js';

@Injectable()
export class SuitesService {
  constructor(@Inject(DB) private readonly db: AppDb) {}

  /** One row per directory that serves a version, at that version. */
  async list(): Promise<SuiteListRow[]> {
    const current = await currentSuites(this.db);
    const states = await taskStatesOf(
      this.db,
      current.map((c) => c.suite.id),
    );
    return current.map(({ source, suite }) =>
      suiteListRow(
        suite,
        source,
        states.filter((t) => t.suiteId === suite.id),
      ),
    );
  }

  /** Any version of a directory, current or not, with its tasks and the version selector. */
  async detail(id: string): Promise<SuiteDetail> {
    const suite = await this.suite(id);
    const [source, versions, tasks] = await Promise.all([
      sourceOf(this.db, suite.sourcePath),
      versionsOf(this.db, suite.sourcePath),
      tasksOf(this.db, [suite.id]),
    ]);
    const filesByTask = groupByTask(
      await filesOf(
        this.db,
        tasks.map((t) => t.id),
      ),
    );
    const failures = await failuresOf(this.db, suite, tasks, filesByTask);
    return suiteDetail({
      suite,
      source,
      versions,
      verification: tasks,
      taskRows: tasks.map((task) =>
        suiteTaskRow(
          task,
          (filesByTask.get(task.id) ?? []).filter((f) => f.kind === 'fixture').length,
          failures.get(task.key) ?? null,
        ),
      ),
    });
  }

  /** Every version of the directory of suite `id`, newest first, with the experiments on each. */
  async history(id: string): Promise<SuiteHistoryEntry[]> {
    const suite = await this.suite(id);
    const [source, versions] = await Promise.all([
      sourceOf(this.db, suite.sourcePath),
      versionsOf(this.db, suite.sourcePath),
    ]);
    const ids = versions.map((v) => v.id);
    const [states, launched] = await Promise.all([
      taskStatesOf(this.db, ids),
      experimentsOn(this.db, ids),
    ]);
    return suiteHistory({
      versions,
      source,
      tasksBySuite: groupBy(states, (t) => t.suiteId),
      experimentsBySuite: new Map(
        ids.map((sid) => [
          sid,
          launched.filter((e) => e.suiteId === sid).map(({ id: eid, name }) => ({ id: eid, name })),
        ]),
      ),
    });
  }

  private async suite(id: string): Promise<SuiteRow> {
    const suite = await suiteById(this.db, id);
    if (!suite) throw notFound(`suite ${id}`);
    return suite;
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const list = out.get(key(item)) ?? [];
    list.push(item);
    out.set(key(item), list);
  }
  return out;
}
