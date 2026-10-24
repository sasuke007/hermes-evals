/**
 * Experiments: list, detail (header, snapshot, Overview), comparison, New
 * experiment options and estimate, launch, and the experiment controls.
 *
 * Fixtures by default (src/fixtures/experiments.ts and comparison.ts);
 * VITE_API_MODE=live calls the planned endpoints of plan section 11.
 * Components call these functions, never fetch.
 */
import type {
  ComparisonQuery,
  ComparisonView,
  EstimateQuery,
  ExperimentActionResult,
  ExperimentDetail,
  ExperimentEstimateView,
  ExperimentListRow,
  LaunchExperimentInput,
  NewExperimentDraft,
  NewExperimentOptions,
} from './types/experiments';
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
  if (apiMode === 'live') return liveGet('/experiments');
  return fixture(() => experimentSeeds(hasScenario).map(experimentListRowFixture), {
    request: 'GET /api/experiments',
  });
}

/** GET /experiments/:id: header, frozen snapshot, progress, feed, verdicts and aggregates. */
export function getExperiment(id: string): Promise<ExperimentDetail> {
  if (apiMode === 'live') return liveGet(`/experiments/${id}`);
  const request = `GET /api/experiments/${id}`;
  return fixture(
    () => experimentDetailFixture(seedOrThrow(request, id), suiteStateFrom(hasScenario)),
    { request },
  );
}

/** GET /experiments/:id/comparison?candidate=&key=&filter=: one candidate against the baseline. */
export function getComparison(id: string, query: ComparisonQuery = {}): Promise<ComparisonView> {
  const path = withQuery(`/experiments/${id}/comparison`, {
    candidate: query.candidate,
    key: query.key,
    filter: query.filter,
  });
  if (apiMode === 'live') return liveGet(path);
  const request = `GET /api/experiments/${id}/comparison`;
  return fixture(() => comparisonFixture(seedOrThrow(request, id), query), { request });
}

/**
 * Everything New experiment offers: suites with their tasks, configurations
 * with their per-run estimates, defaults, the concurrency limit and prices.
 * Live: GET /suites, /configurations and /system/summary, combined server-side
 * as GET /experiments/new-options until those endpoints exist.
 */
export function getNewExperimentOptions(): Promise<NewExperimentOptions> {
  if (apiMode === 'live') return liveGet('/experiments/new-options');
  return fixture(() => newExperimentOptionsFixture(hasScenario), {
    request: 'GET /api/experiments/new-options',
  });
}

/** GET /experiments/estimate: runs, waves, duration and cost for the summary panel. */
export function estimateExperiment(query: EstimateQuery): Promise<ExperimentEstimateView> {
  const path = withQuery('/experiments/estimate', {
    suite: query.suiteId,
    versions: query.versionIds,
    tasks: query.taskCount,
    repetitions: query.repetitions,
    concurrency: query.concurrency,
  });
  if (apiMode === 'live') return liveGet(path);
  return fixture(() => estimateFixture(newExperimentOptionsFixture(hasScenario), query), {
    request: 'GET /api/experiments/estimate',
  });
}

/**
 * POST /experiments. Resolves with the new experiment's id; the page routes to
 * its Overview. Rejects with an ApiError (409) when a provider is not
 * connected or a configuration changed since the form loaded; the form keeps
 * its values. In fixtures a launch opens the running sample experiment.
 */
export function launchExperiment(input: LaunchExperimentInput): Promise<{ id: string }> {
  if (apiMode === 'live') return liveSend('POST', '/experiments', input);
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
  if (apiMode === 'live') return liveSend('POST', `/experiments/${id}/pause`);
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
  if (apiMode === 'live') return liveSend('POST', `/experiments/${id}/resume`, options);
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
  if (apiMode === 'live') return liveSend('POST', `/experiments/${id}/cancel`);
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
  if (apiMode === 'live') return liveSend('POST', `/experiments/${id}/retry-failed`);
  const request = `POST /api/experiments/${id}/retry-failed`;
  return fixture(
    () => {
      seedOrThrow(request, id);
      return { id, status: 'running' as const };
    },
    { request },
  );
}

/** POST /experiments/:id/duplicate: a prefilled New experiment form on the suite's current version. */
export function duplicateExperiment(id: string): Promise<NewExperimentDraft> {
  if (apiMode === 'live') return liveSend('POST', `/experiments/${id}/duplicate`);
  const request = `POST /api/experiments/${id}/duplicate`;
  return fixture(() => duplicateDraftFixture(hasScenario, seedOrThrow(request, id)), { request });
}

export { EXPERIMENT_IDS };
