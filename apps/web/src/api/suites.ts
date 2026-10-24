/**
 * Suites and tasks: list, detail, reload, version history, task detail,
 * task history and task diff, fixture previews. Suites are read-only in the
 * UI and never call a model.
 *
 * Fixtures by default (src/fixtures/suites.ts); VITE_API_MODE=live calls the
 * planned endpoints of plan section 11.
 */
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
import { apiMode, fixture, hasScenario, liveGet, liveSend, notFound, withQuery } from './source';
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

/** GET /suites: one row per suite directory, at its current version. */
export function listSuites(): Promise<SuiteListRow[]> {
  if (apiMode === 'live') return liveGet('/suites');
  return fixture(() => suiteListFixture(noSuitesFrom(hasScenario) ? 'none' : state()), {
    request: 'GET /api/suites',
  });
}

/** GET /suites/:id: a suite version with its tasks, validity and version selector. */
export function getSuite(id: string): Promise<SuiteDetail> {
  if (apiMode === 'live') return liveGet(`/suites/${id}`);
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
 * POST /suites/reload: re-reads ./suites and re-runs every self-check. The
 * result line per suite reads like "1 task now invalid: late_fees".
 */
export function reloadSuites(): Promise<SuiteReloadResult> {
  if (apiMode === 'live') return liveSend('POST', '/suites/reload');
  return fixture(() => suiteReloadFixture(state()), {
    request: 'POST /api/suites/reload',
    latencyMs: 1400,
  });
}

/** GET /suites/:id/history: every version of the directory with its changes and experiments. */
export function getSuiteHistory(id: string): Promise<SuiteHistoryEntry[]> {
  if (apiMode === 'live') return liveGet(`/suites/${id}/history`);
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
  if (apiMode === 'live') return liveGet(`/suites/${suiteId}/tasks/${key}`);
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

/** GET /suites/:id/tasks/:key/history: the task's versions, newest first. */
export function getTaskHistory(suiteId: string, key: string): Promise<TaskVersionEntry[]> {
  if (apiMode === 'live') return liveGet(`/suites/${suiteId}/tasks/${key}/history`);
  return fixture(() => taskHistoryFixture(state(), key), {
    request: `GET /api/suites/${suiteId}/tasks/${key}/history`,
  });
}

/** GET /suites/:id/tasks/:key/diff?against=: the task's changes from another suite version. */
export function getTaskDiff(
  suiteId: string,
  key: string,
  againstSuiteId: string,
): Promise<TaskDiff> {
  if (apiMode === 'live') {
    return liveGet(withQuery(`/suites/${suiteId}/tasks/${key}/diff`, { against: againstSuiteId }));
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

/** GET /suites/:id/tasks/:key/fixtures/:path as a table preview, or null when not tabular. */
export function getFixturePreview(
  suiteId: string,
  key: string,
  path: string,
): Promise<TablePreview | null> {
  if (apiMode === 'live') {
    return liveGet(`/suites/${suiteId}/tasks/${key}/fixtures/${encodeURIComponent(path)}/preview`);
  }
  return fixture(() => fixturePreviewFixture(path), {
    request: `GET /api/suites/${suiteId}/tasks/${key}/fixtures/${path}`,
  });
}

/** URL to download a fixture file (a plain link, not a fetch). */
export function fixtureDownloadUrl(suiteId: string, key: string, path: string): string {
  return `/api/suites/${suiteId}/tasks/${key}/fixtures/${encodeURIComponent(path)}`;
}
