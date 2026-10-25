/**
 * Experiments: list, detail (header, snapshot, Overview), comparison, New
 * experiment options and estimate, launch, and the experiment controls.
 *
 * Live mode calls the endpoints of plan section 11 through apiGet/apiSend and
 * parses every answer with its shared schema; fixtures mode serves
 * src/fixtures/experiments.ts and comparison.ts (src/api/README.md).
 * Components call these functions, never fetch.
 */
import {
  ComparisonViewSchema,
  EXPERIMENT_EVENT_TYPES,
  ExperimentActionResultSchema,
  ExperimentDetailSchema,
  ExperimentEstimateViewSchema,
  ExperimentEventSchema,
  ExperimentListRowSchema,
  LaunchExperimentResultSchema,
  NewExperimentDraftSchema,
  NewExperimentOptionsSchema,
} from '@hermes-evals/shared';
import type {
  ComparisonQuery,
  ComparisonView,
  EstimateQuery,
  ExperimentActionResult,
  ExperimentDetail,
  ExperimentEstimateView,
  ExperimentListRow,
  LaunchExperimentInput,
  LaunchExperimentResult,
  NewExperimentDraft,
  NewExperimentOptions,
} from './types/experiments';
import { apiGet, apiSend } from './client';
import {
  apiMode,
  fixture,
  fixtureFailure,
  hasScenario,
  livePath,
  notFound,
  withQuery,
} from './source';
import { comparisonFixture } from '@/fixtures/comparison';
import {
  duplicateDraftFixture,
  estimateFixture,
  EXPERIMENT_IDS,
  experimentDetailFixture,
  experimentListRowFixture,
  experimentSeeds,
  type ExperimentSeed,
  findSeed,
  newExperimentOptionsFixture,
} from '@/fixtures/experiments';
import { suiteStateFrom } from '@/fixtures/suites';

function seedOrThrow(request: string, id: string): ExperimentSeed {
  const seed = findSeed(hasScenario, id);
  if (!seed) throw notFound(request, `experiment ${id}`);
  return seed;
}

/** GET /experiments: newest first. */
export function listExperiments(): Promise<ExperimentListRow[]> {
  if (apiMode === 'live') return apiGet('/experiments', ExperimentListRowSchema.array());
  return fixture(() => experimentSeeds(hasScenario).map(experimentListRowFixture), {
    request: 'GET /api/experiments',
  });
}

/** GET /experiments/:id: header, frozen snapshot, progress, feed, verdicts and aggregates. */
export function getExperiment(id: string): Promise<ExperimentDetail> {
  if (apiMode === 'live') return apiGet(`/experiments/${id}`, ExperimentDetailSchema);
  const request = `GET /api/experiments/${id}`;
  return fixture(
    () => experimentDetailFixture(seedOrThrow(request, id), suiteStateFrom(hasScenario)),
    { request },
  );
}

/**
 * GET /experiments/:id/comparison?candidate=&key=&filter=: one candidate against the
 * baseline, parsed with ComparisonViewSchema. 404 for an unknown experiment, 400 for a
 * candidate it does not test or a key some selected task lacks.
 */
export function getComparison(id: string, query: ComparisonQuery = {}): Promise<ComparisonView> {
  const path = withQuery(`/experiments/${id}/comparison`, {
    candidate: query.candidate,
    key: query.key,
    filter: query.filter,
  });
  if (apiMode === 'live') return apiGet(path, ComparisonViewSchema);
  const request = `GET /api/experiments/${id}/comparison`;
  return fixture(() => comparisonFixture(seedOrThrow(request, id), query), { request });
}

/**
 * GET /experiments/new-options: everything New experiment offers before the
 * user types anything: suites with their tasks, configurations (latest
 * versions, config hashes and per-run estimates), the defaults, the
 * concurrency limit of the live workers and the price table.
 */
export function getNewExperimentOptions(): Promise<NewExperimentOptions> {
  if (apiMode === 'live') return apiGet('/experiments/new-options', NewExperimentOptionsSchema);
  return fixture(() => newExperimentOptionsFixture(hasScenario), {
    request: 'GET /api/experiments/new-options',
  });
}

/**
 * GET /experiments/estimate: runs, waves, duration and cost for the summary
 * panel. `budgetS` is the form's per-run time budget override, sent as
 * `budget`: it replaces every configuration's own budget, as the runs do.
 */
export function estimateExperiment(query: EstimateQuery): Promise<ExperimentEstimateView> {
  const path = withQuery('/experiments/estimate', {
    suite: query.suiteId,
    versions: query.versionIds,
    tasks: query.taskCount,
    repetitions: query.repetitions,
    concurrency: query.concurrency,
    budget: query.budgetS,
  });
  if (apiMode === 'live') return apiGet(path, ExperimentEstimateViewSchema);
  return fixture(() => estimateFixture(newExperimentOptionsFixture(hasScenario), query), {
    request: 'GET /api/experiments/estimate',
  });
}

/**
 * POST /experiments. Resolves with the new experiment's id; the page routes to
 * its Overview. Rejects with an ApiError: 409 when a provider or the LLM
 * judge is not ready, no proven worker is connected, or a configuration
 * changed since the form loaded; 400 with issues per field. The form keeps
 * its values. In fixtures a launch opens the running sample experiment.
 */
export function launchExperiment(input: LaunchExperimentInput): Promise<LaunchExperimentResult> {
  if (apiMode === 'live') {
    return apiSend('POST', '/experiments', input, LaunchExperimentResultSchema);
  }
  const request = 'POST /api/experiments';
  if (hasScenario('launch-refused') || hasScenario('nous-not-connected')) {
    return fixtureFailure(request, 409, 'Nous Portal is not connected');
  }
  if (hasScenario('launch-conflict')) {
    return fixtureFailure(
      request,
      409,
      'configuration with-skill changed since you opened this form (now v2)',
    );
  }
  return fixture({ id: EXPERIMENT_IDS.mcpVsBaseline }, { request, latencyMs: 600 });
}

/** POST /experiments/:id/pause: stops dispatching; in-flight runs finish. */
export function pauseExperiment(id: string): Promise<ExperimentActionResult> {
  if (apiMode === 'live') {
    return apiSend('POST', `/experiments/${id}/pause`, {}, ExperimentActionResultSchema);
  }
  const request = `POST /api/experiments/${id}/pause`;
  return fixture(
    () => {
      seedOrThrow(request, id);
      return { id, status: 'paused' as const };
    },
    { request },
  );
}

/**
 * POST /experiments/:id/resume. A spend-ceiling pause needs a higher ceiling
 * (`spendCeilingUsd`); a provider pause needs the provider connected.
 */
export function resumeExperiment(
  id: string,
  options: { spendCeilingUsd?: number } = {},
): Promise<ExperimentActionResult> {
  if (apiMode === 'live') {
    return apiSend('POST', `/experiments/${id}/resume`, options, ExperimentActionResultSchema);
  }
  const request = `POST /api/experiments/${id}/resume`;
  const seed = findSeed(hasScenario, id);
  if (seed?.pauseReason === 'spend_ceiling') {
    const ceiling = seed.spendCeilingUsd ?? 0;
    if (options.spendCeilingUsd === undefined || options.spendCeilingUsd <= ceiling) {
      return fixtureFailure(
        request,
        409,
        `raise the spend ceiling above $${ceiling.toFixed(2)} to resume`,
      );
    }
  }
  if (seed?.pauseReason === 'provider_disconnected' && hasScenario('nous-not-connected')) {
    return fixtureFailure(request, 409, 'Nous Portal is not connected');
  }
  return fixture(
    () => {
      seedOrThrow(request, id);
      return { id, status: 'running' as const };
    },
    { request },
  );
}

/** POST /experiments/:id/cancel: queued runs will not start; scored runs are kept. */
export function cancelExperiment(id: string): Promise<ExperimentActionResult> {
  if (apiMode === 'live') {
    return apiSend('POST', `/experiments/${id}/cancel`, {}, ExperimentActionResultSchema);
  }
  const request = `POST /api/experiments/${id}/cancel`;
  return fixture(
    () => {
      seedOrThrow(request, id);
      return { id, status: 'completed' as const };
    },
    { request },
  );
}

/** POST /experiments/:id/retry-failed: re-queues the errored runs of a failed experiment. */
export function retryFailedRuns(id: string): Promise<ExperimentActionResult> {
  if (apiMode === 'live') {
    return apiSend('POST', `/experiments/${id}/retry-failed`, {}, ExperimentActionResultSchema);
  }
  const request = `POST /api/experiments/${id}/retry-failed`;
  return fixture(
    () => {
      seedOrThrow(request, id);
      return { id, status: 'running' as const };
    },
    { request },
  );
}

/**
 * POST /experiments/:id/duplicate: a prefilled New experiment form on the
 * suite's current version, with what changed since the original (changed,
 * removed and now-invalid tasks, the last two left out). Nothing is stored.
 */
export function duplicateExperiment(id: string): Promise<NewExperimentDraft> {
  if (apiMode === 'live') {
    return apiSend('POST', `/experiments/${id}/duplicate`, {}, NewExperimentDraftSchema);
  }
  const request = `POST /api/experiments/${id}/duplicate`;
  return fixture(() => duplicateDraftFixture(hasScenario, seedOrThrow(request, id)), { request });
}

/**
 * GET /experiments/:id/events (SSE): `run`, `counts`, `experiment` and `feed` events, each
 * named on the wire (`event: <type>`), polled from Postgres every second. Null in fixtures
 * mode, where nothing streams. Use with useSse, ExperimentEventSchema and
 * EXPERIMENT_EVENT_NAMES; refetch getExperiment on reconnect (the API does not replay).
 */
export function experimentEventsPath(id: string): string | null {
  return livePath(`/experiments/${id}/events`);
}
export const EXPERIMENT_EVENT_NAMES = EXPERIMENT_EVENT_TYPES;
export { ExperimentEventSchema };

export { EXPERIMENT_IDS };
