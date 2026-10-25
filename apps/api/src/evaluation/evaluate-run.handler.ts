/**
 * The evaluate-run job (plan 9.4, E1): claim, score, publish.
 *
 * 1. Claim (claim.ts): a fresh token for this delivery, and the run moves
 *    from `executed` to `scoring`. Nothing to claim means the evaluation
 *    already finished: the job completes.
 * 2. Score (score.ts): every declared key over stored evidence. Writes
 *    nothing but the claim's renewal after each key (claim.ts renewClaim),
 *    so a slow task keeps its claim; a delivery that finds its claim taken,
 *    or whose job pg-boss failed under it (job.signal), stops there and
 *    leaves no trace. The job's own expiry sits above the slowest pass a
 *    loaded task can declare (queues.ts EVALUATE_RUN_EXPIRE_SECONDS).
 * 3. Publish (publish.ts): one transaction that re-checks the token, writes
 *    the whole score set, supersedes the previous result, scores the run and
 *    reconciles the experiment.
 *
 * Anything thrown fails the job. pg-boss retries it (retryLimit 2, backoff
 * from 30 s) and then moves it to evaluate-run-dead, whose handler makes sure
 * the run still reaches `scored` (dead-letter.ts). Retrying is safe because
 * scoring reads only immutable evidence and publishing is all or nothing.
 *
 * Execution and evaluation are separate jobs (plan 1, invariant 8): a scoring
 * bug is fixed by re-queuing evaluation, never by running Hermes again.
 */
import type { PgBoss } from 'pg-boss';
import type { PinoLogger } from 'nestjs-pino';
import type { ScoreStatus } from '@hermes-evals/shared';
import { QUEUES, type EvaluateRunJob } from '../queue/queues.js';
import { CLAIM_SECONDS, claimEvaluation, renewClaim } from './claim.js';
import type { ScorerContextDeps } from './context.js';
import { handleEvaluateRunDeadJob, type DeadLetterOutcome } from './dead-letter.js';
import { loadEvidence } from './evidence.js';
import { EvaluateRunJobSchema } from './job.js';
import { publishEvaluation, type Reconcile } from './publish.js';
import { scoreEvidence } from './score.js';

export type EvaluationLogger = Pick<PinoLogger, 'info' | 'warn' | 'error'>;

/** What both evaluation handlers need: the database, the blob store and, for tests, the reconciler. */
export interface EvaluationDeps extends ScorerContextDeps {
  /** reconcileExperiment unless a test passes its own. */
  reconcile?: Reconcile;
  /** Claim length in seconds: CLAIM_SECONDS (10 minutes) unless a test passes a shorter one. */
  claimSeconds?: number;
}

/**
 * - `published`: this delivery's scores are the run's result;
 * - `lost`: a newer delivery took the claim, or published first, or pg-boss
 *   failed this delivery's job under it; nothing written;
 * - `finished`: the evaluation was already completed or failed, or does not exist.
 */
export type EvaluateRunOutcome = 'published' | 'lost' | 'finished';

/** The job's output, as pg-boss stores it. */
export interface EvaluateRunResult {
  evaluationId: string;
  outcome: EvaluateRunOutcome;
}

/**
 * Runs one delivery of an evaluate-run job. Throws (failing the job) on
 * anything unexpected. `signal` is the pg-boss job's (absent in tests that
 * call the handler directly).
 */
export async function handleEvaluateRunJob(
  data: unknown,
  deps: EvaluationDeps,
  logger: EvaluationLogger,
  signal?: AbortSignal,
): Promise<EvaluateRunResult> {
  const { evaluationId } = EvaluateRunJobSchema.parse(data);
  const claimSeconds = deps.claimSeconds ?? CLAIM_SECONDS;
  const claim = await claimEvaluation(deps.db, evaluationId, claimSeconds);
  if (!claim) {
    logger.info({ evaluationId }, 'evaluate-run: already finished');
    return { evaluationId, outcome: 'finished' };
  }
  const evidence = await loadEvidence(deps.db, claim);
  if (!evidence) {
    // Runs, tasks and attempts are never deleted, so this is a broken row: let it dead-letter.
    throw new Error(`evaluation ${evaluationId}: its run, task or attempt could not be read`);
  }
  const scored = await scoreEvidence(evidence, deps, {
    keepClaim: () => renewClaim(deps.db, claim, claimSeconds),
    signal,
  });
  if (!scored) {
    logger.info(
      { evaluationId, runId: claim.runId, generation: claim.generation },
      signal?.aborted
        ? 'evaluate-run: pg-boss gave up on this delivery while scoring; work dropped'
        : 'evaluate-run: claim lost while scoring; work dropped',
    );
    return { evaluationId, outcome: 'lost' };
  }
  const outcome = await publishEvaluation(deps.db, claim, scored, deps.reconcile);
  const statuses: Partial<Record<ScoreStatus, number>> = {};
  for (const { result } of scored.scores)
    statuses[result.status] = (statuses[result.status] ?? 0) + 1;
  logger.info(
    {
      evaluationId,
      runId: claim.runId,
      generation: claim.generation,
      outcome,
      answer: scored.answer.status,
      statuses,
    },
    outcome === 'published' ? 'evaluate-run: scores published' : 'evaluate-run: claim lost',
  );
  return { evaluationId, outcome };
}

/**
 * Starts consuming evaluate-run jobs, `localConcurrency` at a time
 * (WORKER_CONCURRENCY in the worker). Resolves the pg-boss worker id.
 */
export function registerEvaluateRunHandler(
  boss: PgBoss,
  deps: EvaluationDeps,
  logger: EvaluationLogger,
  localConcurrency: number,
): Promise<string> {
  const options = { batchSize: 1, localConcurrency } as const;
  return boss.work<EvaluateRunJob, EvaluateRunResult | null, typeof options>(
    QUEUES.evaluateRun,
    options,
    async ([job]) => (job ? handleEvaluateRunJob(job.data, deps, logger, job.signal) : null),
  );
}

/**
 * Starts consuming evaluate-run-dead jobs, one at a time. includeMetadata
 * gives the handler the failed job's error and retry count. A throw here is
 * retried by the dead-letter queue's own policy (queues.ts).
 */
export function registerEvaluateRunDeadHandler(
  boss: PgBoss,
  deps: Pick<EvaluationDeps, 'db' | 'reconcile'>,
  logger: EvaluationLogger,
): Promise<string> {
  const options = { batchSize: 1, localConcurrency: 1, includeMetadata: true } as const;
  return boss.work<EvaluateRunJob, { outcome: DeadLetterOutcome } | null, typeof options>(
    QUEUES.evaluateRunDead,
    options,
    async ([job]) => (job ? { outcome: await handleEvaluateRunDeadJob(job, deps, logger) } : null),
  );
}

/** Registers both evaluation handlers; resolves their pg-boss worker ids. */
export async function registerEvaluationHandlers(
  boss: PgBoss,
  deps: EvaluationDeps,
  logger: EvaluationLogger,
  localConcurrency: number,
): Promise<{ evaluateRun: string; evaluateRunDead: string }> {
  // The dead-letter queue first, so a job that fails at once always has a consumer.
  const evaluateRunDead = await registerEvaluateRunDeadHandler(boss, deps, logger);
  const evaluateRun = await registerEvaluateRunHandler(boss, deps, logger, localConcurrency);
  return { evaluateRun, evaluateRunDead };
}
