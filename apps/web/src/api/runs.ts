/**
 * Runs: the Runs tab table, bulk Re-score and Retry execution, and the run
 * inspector (detail, events, artifact previews, single-run actions).
 *
 * Fixtures by default (src/fixtures/runs.ts and inspector.ts);
 * VITE_API_MODE=live calls the planned endpoints of plan section 11.
 */
import type {
  BulkRunActionResult,
  RunActionResult,
  RunDetail,
  RunEventsPage,
  RunFilters,
  RunListResult,
} from './types/runs';
import type { TablePreview } from './types/suites';
import {
  apiMode,
  fixture,
  fixtureFailure,
  hasScenario,
  liveGet,
  liveSend,
  notFound,
  withQuery,
} from './source';
import { findSeed } from '@/fixtures/experiments';
import {
  artifactPreviewFixture,
  findRun,
  runDetailFixture,
  runEventsFixture,
} from '@/fixtures/inspector';
import { bulkRescoreFixture, bulkRetryFixture, runListFixture, runNeeds } from '@/fixtures/runs';

/** GET /experiments/:id/runs with filters and sort (mirrored in the page URL). */
export function listRuns(experimentId: string, filters: RunFilters = {}): Promise<RunListResult> {
  const path = withQuery(`/experiments/${experimentId}/runs`, {
    config: filters.configuration,
    task: filters.task,
    status: filters.status,
    score_status: filters.scoreStatus,
    exec_error: filters.hasExecutionError || undefined,
    ungradable: filters.ungradable || undefined,
    sort: filters.sort,
    dir: filters.dir,
  });
  if (apiMode === 'live') return liveGet(path);
  const request = `GET /api/experiments/${experimentId}/runs`;
  return fixture(
    () => {
      const seed = findSeed(hasScenario, experimentId);
      if (!seed) throw notFound(request, `experiment ${experimentId}`);
      return runListFixture(seed, filters);
    },
    { request },
  );
}

/** GET /runs/:id: header, attempts, outcome, timeline, final response, artifacts, launch record. */
export function getRun(runId: string): Promise<RunDetail> {
  if (apiMode === 'live') return liveGet(`/runs/${runId}`);
  const request = `GET /api/runs/${runId}`;
  return fixture(
    () => {
      const detail = runDetailFixture(hasScenario, runId);
      if (!detail) throw notFound(request, `run ${runId}`);
      return detail;
    },
    { request },
  );
}

/** GET /runs/:id/events?after=: events after a sequence number (live timeline). */
export function listRunEvents(runId: string, after = 0): Promise<RunEventsPage> {
  if (apiMode === 'live') return liveGet(withQuery(`/runs/${runId}/events`, { after }));
  const request = `GET /api/runs/${runId}/events`;
  return fixture(
    () => {
      const page = runEventsFixture(hasScenario, runId, after);
      if (!page) throw notFound(request, `run ${runId}`);
      return page;
    },
    { request },
  );
}

/** GET /runs/:id/artifacts/:artifactId/content as a table preview (CSV), or null. */
export function getArtifactPreview(
  runId: string,
  artifactId: string,
): Promise<TablePreview | null> {
  if (apiMode === 'live') return liveGet(`/runs/${runId}/artifacts/${artifactId}/preview`);
  return fixture(() => artifactPreviewFixture(hasScenario, runId, artifactId), {
    request: `GET /api/runs/${runId}/artifacts/${artifactId}/content`,
  });
}

/** URL to download an artifact's bytes (a plain link, not a fetch). */
export function artifactDownloadUrl(runId: string, artifactId: string): string {
  return `/api/runs/${runId}/artifacts/${artifactId}/content`;
}

/** Reasons a model-needing action is refused while Nous Portal is not connected. */
function providerRefusal(runId: string, action: 'rescore' | 'retry'): string | null {
  if (!hasScenario('nous-not-connected')) return null;
  const found = findRun(hasScenario, runId);
  if (!found) return null;
  const { judgeKeys } = runNeeds(found.run);
  if (action === 'rescore' && judgeKeys.length) {
    return `Re-score needs Nous Portal for the ${judgeKeys.join(' and ')} judge.`;
  }
  if (action === 'retry') return 'Retry needs Nous Portal.';
  return null;
}

/** POST /runs/:id/rescore: re-runs the scorers on the stored output; never re-executes. */
export function rescoreRun(runId: string): Promise<RunActionResult> {
  if (apiMode === 'live') return liveSend('POST', `/runs/${runId}/rescore`);
  const request = `POST /api/runs/${runId}/rescore`;
  const refusal = providerRefusal(runId, 'rescore');
  if (refusal) return fixtureFailure(request, 409, refusal);
  return fixture(
    () => {
      const found = findRun(hasScenario, runId);
      if (!found) throw notFound(request, `run ${runId}`);
      return { runId, status: 'scoring' as const, attempt: null };
    },
    { request },
  );
}

/** POST /runs/:id/retry: re-executes an execution_error run in a fresh trial container. */
export function retryRun(runId: string): Promise<RunActionResult> {
  if (apiMode === 'live') return liveSend('POST', `/runs/${runId}/retry`);
  const request = `POST /api/runs/${runId}/retry`;
  const refusal = providerRefusal(runId, 'retry');
  if (refusal) return fixtureFailure(request, 409, refusal);
  const found = findRun(hasScenario, runId);
  if (found && found.run.status !== 'execution_error') {
    return fixtureFailure(request, 409, `run is ${found.run.status}, not execution_error`);
  }
  return fixture(
    () => {
      if (!found) throw notFound(request, `run ${runId}`);
      return { runId, status: 'queued' as const, attempt: found.run.attempts + 1 };
    },
    { request },
  );
}

/** POST /runs/:id/cancel: stops a queued or running run. */
export function cancelRun(runId: string): Promise<RunActionResult> {
  if (apiMode === 'live') return liveSend('POST', `/runs/${runId}/cancel`);
  const request = `POST /api/runs/${runId}/cancel`;
  return fixture(
    () => {
      if (!findRun(hasScenario, runId)) throw notFound(request, `run ${runId}`);
      return { runId, status: 'cancelled' as const, attempt: null };
    },
    { request },
  );
}

/** POST /experiments/:id/runs/rescore (bulk bar). `refused` names runs that could not be enqueued. */
export function rescoreRuns(experimentId: string, runIds: string[]): Promise<BulkRunActionResult> {
  if (apiMode === 'live') {
    return liveSend('POST', `/experiments/${experimentId}/runs/rescore`, { runIds });
  }
  const request = `POST /api/experiments/${experimentId}/runs/rescore`;
  return fixture(
    () => {
      const seed = findSeed(hasScenario, experimentId);
      if (!seed) throw notFound(request, `experiment ${experimentId}`);
      return bulkRescoreFixture(seed, runIds, hasScenario('bulk-refused'));
    },
    { request },
  );
}

/** POST /experiments/:id/runs/retry (bulk bar): only execution_error runs are re-queued. */
export function retryRuns(experimentId: string, runIds: string[]): Promise<BulkRunActionResult> {
  if (apiMode === 'live') {
    return liveSend('POST', `/experiments/${experimentId}/runs/retry`, { runIds });
  }
  const request = `POST /api/experiments/${experimentId}/runs/retry`;
  return fixture(
    () => {
      const seed = findSeed(hasScenario, experimentId);
      if (!seed) throw notFound(request, `experiment ${experimentId}`);
      return bulkRetryFixture(seed, runIds, hasScenario('bulk-refused'));
    },
    { request },
  );
}
