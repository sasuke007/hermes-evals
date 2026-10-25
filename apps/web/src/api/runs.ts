/**
 * Runs: the Runs tab table, bulk Re-score and Retry execution, and the run
 * inspector (detail, events, artifact previews, single-run actions).
 *
 * Live mode calls the endpoints of plan section 11 through apiGet/apiSend and
 * parses every answer with its shared schema; fixtures mode serves
 * src/fixtures/runs.ts and inspector.ts (src/api/README.md).
 */
import {
  BulkRescoreResultSchema,
  BulkRunActionResultSchema,
  RescoreRunResultSchema,
  RunActionResultSchema,
  RunDetailSchema,
  RunEventsPageSchema,
  RunListResultSchema,
  TablePreviewSchema,
} from '@hermes-evals/shared';
import type {
  BulkRescoreResult,
  BulkRunActionResult,
  RescoreRunResult,
  RunActionResult,
  RunDetail,
  RunEventsPage,
  RunFilters,
  RunListResult,
} from './types/runs';
import type { TablePreview } from './types/suites';
import { API_BASE, apiGet, apiGetText, apiSend, type TextStart } from './client';
import { apiMode, fixture, fixtureFailure, hasScenario, notFound, withQuery } from './source';
import { findSeed } from '@/fixtures/experiments';
import {
  artifactPreviewFixture,
  findRun,
  runDetailFixture,
  runEventsFixture,
} from '@/fixtures/inspector';
import {
  bulkRescoreFixture,
  bulkRetryFixture,
  rescoreRunFixture,
  runListFixture,
  runNeeds,
} from '@/fixtures/runs';

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
  if (apiMode === 'live') return apiGet(path, RunListResultSchema);
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
  if (apiMode === 'live') return apiGet(`/runs/${runId}`, RunDetailSchema);
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

/**
 * GET /runs/:id/events?after=: the timeline rows touched after a sequence number (live
 * timeline). A row already sent comes again, with the same seq, when a later event completed
 * it (a tool result): the caller replaces rows by seq and asks next with `lastSeq`.
 */
export function listRunEvents(runId: string, after = 0): Promise<RunEventsPage> {
  if (apiMode === 'live') {
    return apiGet(withQuery(`/runs/${runId}/events`, { after }), RunEventsPageSchema);
  }
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

/** GET /runs/:id/artifacts/:artifactId/preview: the first rows of a CSV or TSV, or null. */
export function getArtifactPreview(
  runId: string,
  artifactId: string,
): Promise<TablePreview | null> {
  const path = `/runs/${runId}/artifacts/${artifactId}/preview`;
  if (apiMode === 'live') return apiGet(path, TablePreviewSchema.nullable());
  return fixture(() => artifactPreviewFixture(hasScenario, runId, artifactId), {
    request: `GET ${API_BASE}${path}`,
  });
}

/** URL to download an artifact's bytes (a plain link, not a fetch). */
export function artifactDownloadUrl(runId: string, artifactId: string): string {
  return `${API_BASE}/runs/${runId}/artifacts/${artifactId}/content`;
}

/** The start of a text artifact, for its plain-text preview. */
export type ArtifactText = TextStart;

/** How much of a text artifact the preview reads. */
export const TEXT_PREVIEW_BYTES = 64 * 1024;

/**
 * GET /runs/:id/artifacts/:artifactId/content, read as text for the inline preview (the
 * Artifacts section's "plain text" pane): at most TEXT_PREVIEW_BYTES, shown as written and
 * never rendered. The endpoint answers the file's bytes, not JSON, so it goes through
 * apiGetText rather than apiGet; failures are ApiErrors all the same.
 */
export function getArtifactText(
  runId: string,
  artifactId: string,
  maxBytes = TEXT_PREVIEW_BYTES,
): Promise<ArtifactText> {
  const path = `/runs/${runId}/artifacts/${artifactId}/content`;
  if (apiMode === 'live') return apiGetText(path, maxBytes);
  const request = `GET ${API_BASE}${path}`;
  return fixture(
    () => {
      // The fixtures store tables, not bytes: a CSV artifact reads back as its rows.
      const preview = artifactPreviewFixture(hasScenario, runId, artifactId);
      if (!preview) throw notFound(request, `content of artifact ${artifactId}`);
      const text = [preview.columns, ...preview.rows].map((row) => row.join(',')).join('\n');
      return { text, truncated: preview.totalRows > preview.rows.length };
    },
    { request },
  );
}

/** Reasons a model-needing action is refused while Nous Portal is not connected. */
function providerRefusal(runId: string, action: 'rescore' | 'retry'): string | null {
  if (!hasScenario('nous-not-connected')) return null;
  const found = findRun(hasScenario, runId);
  if (!found) return null;
  const { judgeKeys } = runNeeds(found.run);
  if (action === 'rescore' && judgeKeys.length) {
    return `Re-score needs Nous Portal for the ${judgeKeys.join(' and ')} judge: Nous Portal is not connected.`;
  }
  if (action === 'retry') return 'Retry needs Nous Portal.';
  return null;
}

/**
 * POST /runs/:id/rescore: re-runs the scorers on the stored output; never
 * re-executes. The run stays `scored` and its current result stays current
 * until the new generation publishes; a re-score already pending is joined.
 */
export function rescoreRun(runId: string): Promise<RescoreRunResult> {
  if (apiMode === 'live') {
    return apiSend('POST', `/runs/${runId}/rescore`, {}, RescoreRunResultSchema);
  }
  const request = `POST /api/runs/${runId}/rescore`;
  const refusal = providerRefusal(runId, 'rescore');
  if (refusal) return fixtureFailure(request, 409, refusal);
  return fixture(
    () => {
      const found = findRun(hasScenario, runId);
      if (!found) throw notFound(request, `run ${runId}`);
      return rescoreRunFixture(runId);
    },
    { request },
  );
}

/** POST /runs/:id/retry: re-executes an execution_error run in a fresh trial container. */
export function retryRun(runId: string): Promise<RunActionResult> {
  if (apiMode === 'live') return apiSend('POST', `/runs/${runId}/retry`, {}, RunActionResultSchema);
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
  if (apiMode === 'live')
    return apiSend('POST', `/runs/${runId}/cancel`, {}, RunActionResultSchema);
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
export function rescoreRuns(experimentId: string, runIds: string[]): Promise<BulkRescoreResult> {
  if (apiMode === 'live') {
    const path = `/experiments/${experimentId}/runs/rescore`;
    return apiSend('POST', path, { runIds }, BulkRescoreResultSchema);
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
    const path = `/experiments/${experimentId}/runs/retry`;
    return apiSend('POST', path, { runIds }, BulkRunActionResultSchema);
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
