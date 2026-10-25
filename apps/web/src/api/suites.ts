/**
 * Suites and tasks: list, detail, reload, version history, task detail,
 * task history and task diff, fixture previews. Suites never call a model.
 *
 * Live mode calls the endpoints of plan section 11 through apiGet/apiSend and
 * parses every answer with its shared schema; fixtures mode serves
 * src/fixtures/suites.ts (src/api/README.md).
 */
import {
  SuiteDetailSchema,
  SuiteHistoryEntrySchema,
  SuiteListRowSchema,
  SuiteReloadResultSchema,
  TablePreviewSchema,
  TaskDetailSchema,
  TaskDiffSchema,
  TaskVersionEntrySchema,
  type SuiteReloadRequest,
} from '@hermes-evals/shared';
import type {
  SuiteDetail,
  SuiteHistoryEntry,
  SuiteListRow,
  SuiteReloadResult,
  TablePreview,
  TaskDetail,
  TaskDiff,
  TaskVersionEntry,
} from './types/suites';
import { apiGet, apiSend } from './client';
import { apiMode, fixture, hasScenario, notFound, withQuery } from './source';
import { experimentsOnSuiteFixture, taskUsageFixture } from '@/fixtures/experiments';
import {
  fixturePreviewFixture,
  noSuitesFrom,
  suiteDetailFixture,
  suiteHistoryFixture,
  suiteListFixture,
  suiteReloadFixture,
  suiteStateFrom,
  taskDetailFixture,
  taskDiffFixture,
  taskHistoryFixture,
} from '@/fixtures/suites';

const state = () => suiteStateFrom(hasScenario);

/** One path segment: ids and keys are slugs today, but a segment never splits the path. */
const seg = (value: string): string => encodeURIComponent(value);
const suitePath = (id: string): string => `/suites/${seg(id)}`;
const taskPath = (suiteId: string, key: string): string =>
  `${suitePath(suiteId)}/tasks/${seg(key)}`;

/** GET /suites: one row per suite directory, at its current version. */
export function listSuites(): Promise<SuiteListRow[]> {
  if (apiMode === 'live') return apiGet('/suites', SuiteListRowSchema.array());
  return fixture(() => suiteListFixture(noSuitesFrom(hasScenario) ? 'none' : state()), {
    request: 'GET /api/suites',
  });
}

/** GET /suites/:id: a suite version with its tasks, validity and version selector. */
export function getSuite(id: string): Promise<SuiteDetail> {
  if (apiMode === 'live') return apiGet(suitePath(id), SuiteDetailSchema);
  const request = `GET /api/suites/${id}`;
  return fixture(
    () => {
      const detail = noSuitesFrom(hasScenario) ? null : suiteDetailFixture(state(), id);
      if (!detail) throw notFound(request, `suite ${id}`);
      return detail;
    },
    { request },
  );
}

/**
 * POST /suites/reload: re-reads one suite directory (`path`, as the list shows it:
 * `./suites/invoices-v1`) or every directory, and re-runs the self-checks in the worker.
 * The result line per suite reads like "1 task now invalid: late_fees". 503 without a live
 * worker, 504 when the load outlasts SUITE_RELOAD_TIMEOUT_S.
 */
export function reloadSuites(path?: string): Promise<SuiteReloadResult> {
  const body: SuiteReloadRequest = path ? { path } : {};
  if (apiMode === 'live') return apiSend('POST', '/suites/reload', body, SuiteReloadResultSchema);
  return fixture(
    () => {
      const result = suiteReloadFixture(state());
      return path
        ? { ...result, suites: result.suites.filter((s) => s.sourcePath === path) }
        : result;
    },
    { request: 'POST /api/suites/reload', latencyMs: 1400 },
  );
}

/** GET /suites/:id/history: every version of the directory with its changes and experiments. */
export function getSuiteHistory(id: string): Promise<SuiteHistoryEntry[]> {
  if (apiMode === 'live')
    return apiGet(`${suitePath(id)}/history`, SuiteHistoryEntrySchema.array());
  return fixture(
    () =>
      suiteHistoryFixture(state()).map((entry) => ({
        ...entry,
        experiments: experimentsOnSuiteFixture(hasScenario, entry.suiteId),
      })),
    { request: `GET /api/suites/${id}/history` },
  );
}

/** GET /suites/:id/tasks/:key: prompt, fixtures, verification, reference, self-check, usage. */
export function getTask(suiteId: string, key: string): Promise<TaskDetail> {
  if (apiMode === 'live') return apiGet(taskPath(suiteId, key), TaskDetailSchema);
  const request = `GET /api/suites/${suiteId}/tasks/${key}`;
  return fixture(
    () => {
      const detail = taskDetailFixture(state(), suiteId, key);
      if (!detail) throw notFound(request, `task ${key}`);
      return { ...detail, experiments: taskUsageFixture(hasScenario, key) };
    },
    { request },
  );
}

/** GET /suites/:id/tasks/:key/history: the task key's versions, newest first. */
export function getTaskHistory(suiteId: string, key: string): Promise<TaskVersionEntry[]> {
  if (apiMode === 'live') {
    return apiGet(`${taskPath(suiteId, key)}/history`, TaskVersionEntrySchema.array());
  }
  return fixture(() => taskHistoryFixture(state(), key), {
    request: `GET /api/suites/${suiteId}/tasks/${key}/history`,
  });
}

/**
 * GET /suites/:id/tasks/:key/diff?against=: the task's changes from suite version
 * `againstSuiteId` (the older side) to suite version `suiteId`. Against itself it lists the
 * version's files with nothing changed, which is how a first version's files are shown.
 */
export function getTaskDiff(
  suiteId: string,
  key: string,
  againstSuiteId: string,
): Promise<TaskDiff> {
  if (apiMode === 'live') {
    return apiGet(
      withQuery(`${taskPath(suiteId, key)}/diff`, { against: againstSuiteId }),
      TaskDiffSchema,
    );
  }
  const request = `GET /api/suites/${suiteId}/tasks/${key}/diff`;
  return fixture(
    () => {
      const diff = taskDiffFixture(state(), key, againstSuiteId, suiteId);
      if (!diff) throw notFound(request, `task ${key} in suite ${againstSuiteId}`);
      return diff;
    },
    { request },
  );
}

/**
 * GET /suites/:id/tasks/:key/fixtures/:path/preview: the first rows of a CSV or TSV fixture,
 * null for any other file. `path` is the fixture's workspace path (`invoices.csv`).
 */
export function getFixturePreview(
  suiteId: string,
  key: string,
  path: string,
): Promise<TablePreview | null> {
  if (apiMode === 'live') {
    return apiGet(
      `${taskPath(suiteId, key)}/fixtures/${seg(path)}/preview`,
      TablePreviewSchema.nullable(),
    );
  }
  return fixture(() => fixturePreviewFixture(path), {
    request: `GET /api/suites/${suiteId}/tasks/${key}/fixtures/${path}/preview`,
  });
}
