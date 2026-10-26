/**
 * Suites and tasks: list, detail, reload and its per-folder progress, version
 * history, task detail, task history and task diff, fixture previews, a
 * version's download. Suites never call a model. Authoring calls are in
 * ./suites-authoring.ts.
 *
 * Live mode calls the endpoints of plan section 11 through apiGet/apiSend and
 * parses every answer with its shared schema; fixtures mode serves
 * src/fixtures/suites.ts (src/api/README.md).
 */
import {
  suiteVersionZipName,
  SuiteDetailSchema,
  SuiteHistoryEntrySchema,
  SuiteListRowSchema,
  SuiteReloadProgressSchema,
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
  SuiteReloadProgress,
  SuiteReloadResult,
  TablePreview,
  TaskDetail,
  TaskDiff,
  TaskVersionEntry,
} from './types/suites';
import { API_BASE, apiGet, apiSend } from './client';
import { apiMode, fixture, hasScenario, notFound, withQuery, type FixtureWorld } from './source';
import type { SuiteState } from '@/fixtures/suites';

/** The suite state of the active scenarios; a draft conflict implies the newer version on disk. */
const state = ({ suites, suitesAuthoring }: FixtureWorld): SuiteState =>
  suitesAuthoring.suiteStateForDraft(
    suitesAuthoring.draftStateFrom(hasScenario),
    suites.suiteStateFrom(hasScenario),
  );

/** The suite list's state, or 'none' when the scenario has no suites. */
const listState = (w: FixtureWorld): SuiteState | 'none' =>
  w.suites.noSuitesFrom(hasScenario) ? 'none' : state(w);

/** One path segment: ids and keys are slugs today, but a segment never splits the path. */
const seg = (value: string): string => encodeURIComponent(value);
const suitePath = (id: string): string => `/suites/${seg(id)}`;
const taskPath = (suiteId: string, key: string): string =>
  `${suitePath(suiteId)}/tasks/${seg(key)}`;

/** GET /suites: one row per suite directory, at its current version, missing folders included. */
export function listSuites(): Promise<SuiteListRow[]> {
  if (apiMode === 'live') return apiGet('/suites', SuiteListRowSchema.array());
  return fixture(
    (w) => [
      ...w.suites.suiteListFixture(listState(w)),
      ...(hasScenario('missing-folders') ? w.suitesAuthoring.missingFolderRows() : []),
    ],
    { request: 'GET /api/suites' },
  );
}

/** GET /suites/:id: a suite version with its tasks, validity and version selector. */
export function getSuite(id: string): Promise<SuiteDetail> {
  if (apiMode === 'live') return apiGet(suitePath(id), SuiteDetailSchema);
  const request = `GET /api/suites/${id}`;
  return fixture(
    (w) => {
      const detail = w.suites.noSuitesFrom(hasScenario)
        ? null
        : w.suites.suiteDetailFixture(state(w), id);
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
    (w) => {
      const result = w.suites.suiteReloadFixture(state(w));
      return path
        ? { ...result, suites: result.suites.filter((s) => s.sourcePath === path) }
        : result;
    },
    { request: 'POST /api/suites/reload', latencyMs: 1400 },
  );
}

/**
 * GET /suites/reload/progress: where each folder of the running Reload all
 * stands (one load-suites job per folder). The fixture shows the first
 * folder loading and the rest queued.
 */
export function getReloadProgress(): Promise<SuiteReloadProgress> {
  if (apiMode === 'live') return apiGet('/suites/reload/progress', SuiteReloadProgressSchema);
  return fixture(
    (w) =>
      w.suitesAuthoring.reloadProgressFixture(
        w.suites.suiteListFixture(listState(w)).map((r) => r.path),
      ),
    { request: 'GET /api/suites/reload/progress' },
  );
}

/**
 * GET /suites/:suite/versions/:n/zip: the version's files as
 * `<suite>-v<n>.zip` (a plain link, not a fetch). `folder` is the suite's
 * folder name, the last segment of its path.
 */
export function suiteVersionZipUrl(folder: string, versionNumber: number): string {
  return `${API_BASE}/suites/${seg(folder)}/versions/${versionNumber}/zip`;
}

/** The download's file name, as the API names it. */
export { suiteVersionZipName };

/** GET /suites/:id/history: every version of the directory with its changes and experiments. */
export function getSuiteHistory(id: string): Promise<SuiteHistoryEntry[]> {
  if (apiMode === 'live')
    return apiGet(`${suitePath(id)}/history`, SuiteHistoryEntrySchema.array());
  return fixture(
    (w) =>
      w.suites.suiteHistoryFixture(state(w)).map((entry) => ({
        ...entry,
        experiments: w.experiments.experimentsOnSuiteFixture(hasScenario, entry.suiteId),
      })),
    { request: `GET /api/suites/${id}/history` },
  );
}

/**
 * GET /suites/:id/tasks/:key: prompt, fixtures, home files, verification, reference,
 * self-check, usage.
 */
export function getTask(suiteId: string, key: string): Promise<TaskDetail> {
  if (apiMode === 'live') return apiGet(taskPath(suiteId, key), TaskDetailSchema);
  const request = `GET /api/suites/${suiteId}/tasks/${key}`;
  return fixture(
    (w) => {
      const detail = w.suites.taskDetailFixture(state(w), suiteId, key);
      if (!detail) throw notFound(request, `task ${key}`);
      return w.home.withHomeFiles(hasScenario, {
        ...detail,
        experiments: w.experiments.taskUsageFixture(hasScenario, key),
      });
    },
    { request },
  );
}

/** GET /suites/:id/tasks/:key/history: the task key's versions, newest first. */
export function getTaskHistory(suiteId: string, key: string): Promise<TaskVersionEntry[]> {
  if (apiMode === 'live') {
    return apiGet(`${taskPath(suiteId, key)}/history`, TaskVersionEntrySchema.array());
  }
  return fixture((w) => w.suites.taskHistoryFixture(state(w), key), {
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
    (w) => {
      const diff = w.suites.taskDiffFixture(state(w), key, againstSuiteId, suiteId);
      if (!diff) throw notFound(request, `task ${key} in suite ${againstSuiteId}`);
      return hasScenario('diff-not-recorded') ? w.suites.withReferenceNotRecorded(diff) : diff;
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
  return fixture((w) => w.suites.fixturePreviewFixture(path), {
    request: `GET /api/suites/${suiteId}/tasks/${key}/fixtures/${path}/preview`,
  });
}
