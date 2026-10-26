/**
 * The finish transaction (plan 8.4, 7.3, 7.4): the runner's outcome becomes
 * the attempt's final state, the run's next state, and whatever follows
 * from it, all in one commit.
 *
 * Order, under the lock order experiment → run → attempt → evaluation. The
 * attempt is locked BEFORE the final events and artifacts go in: their
 * insert triggers take FOR SHARE on the attempt, and taking it ahead of the
 * experiment could deadlock with recovery.
 *
 * 1. Lock the experiment, the run, and the attempt under its lease; no lease
 *    means LeaseLostError and nothing is written.
 * 2. The final events (numbered after the streamed ones), then the blobs and
 *    artifacts. Both must precede step 3: the database refuses either once
 *    the attempt has finished.
 * 3. The fenced update that finishes the attempt, with its cost from the
 *    experiment's frozen price table (null when unpriced). The tokens priced
 *    and stored are billableTokens' (pricing.ts): Hermes's result, or what
 *    egress metered when there is no result or the result claims less, so
 *    an attempt stopped at its deadline still counts against the ceiling.
 * 4. By status:
 *    - executed: run executed, a generation-1 evaluation and its
 *      evaluate-run job, and the circuit breaker reset;
 *    - execution_error: the breaker counts it (at the threshold a running
 *      experiment fails with its ExperimentFailure); a provider or timeout
 *      error of attempt 1 is retried once automatically (attempt 2, 30 s
 *      later, the run back to queued with next_trigger `auto_retry`);
 *      anything else leaves the run execution_error for the user to retry;
 *    - cancelled: run cancelled.
 * 5. workers.in_flight down by one, then reconcile.
 */
import { and, eq, sql } from 'drizzle-orm';
import type {
  AttemptTrigger,
  ExecutionErrorCategory,
  ExperimentFailure,
  RunStatus,
} from '@hermes-evals/shared';
import {
  artifacts,
  attempts,
  blobs,
  evaluations,
  experiments,
  runs,
  workers,
} from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import { evaluateRunKey } from '../../evaluation/job.js';
import { reconcileExperiment, type ReconcileResult } from '../../experiments/reconcile.js';
import {
  executeRunKey,
  QUEUES,
  type EvaluateRunJob,
  type ExecuteRunJob,
} from '../../queue/queues.js';
import { LeaseLostError, type AttemptArtifact, type AttemptOutcome } from '../contracts.js';
import { attemptCost, billableTokens } from '../pricing.js';
import { fencedWrite, insertFencedEvents, leaseHeld } from './fence.js';
import { firstLine } from './first-line.js';
import type { ClaimedAttempt, LifecycleQueue, LifecycleSettings } from './types.js';

export interface FinishInput {
  claimed: ClaimedAttempt;
  /** The seq the first final event gets: the sink's nextSeq. */
  nextSeq: number;
  outcome: AttemptOutcome;
  queue: LifecycleQueue;
  settings: Pick<LifecycleSettings, 'maxConsecutiveExecutionErrors' | 'autoRetryDelayS'>;
}

export interface FinishResult {
  attemptStatus: AttemptOutcome['status'];
  runStatus: RunStatus;
  /** Set when an automatic retry was scheduled: the next attempt's number. */
  retryAttempt: number | null;
  /** Set when the run was executed: the evaluation queued for it. */
  evaluationId: string | null;
  /** Whether this finish tripped the circuit breaker. */
  experimentFailed: boolean;
  reconciled: ReconcileResult;
}

/** Categories retried once automatically (plan 8.4); the rest wait for the user. */
const AUTO_RETRY_CATEGORIES: ReadonlySet<ExecutionErrorCategory> = new Set(['provider', 'timeout']);

/**
 * Whether an execution error of the run's latest attempt is retried
 * automatically: a provider or timeout error of attempt 1 becomes attempt 2
 * (plan 8.4), unless the experiment is being cancelled. Only attempt 1
 * qualifies, so a run gets one automatic retry at most, and a job re-sent
 * later can tell the trigger from the attempt alone (queuedRunTrigger in
 * experiments/commands/jobs.ts reads the same rule back).
 */
export function autoRetries(
  category: ExecutionErrorCategory,
  attemptNumber: number,
  cancelling: boolean,
): boolean {
  return AUTO_RETRY_CATEGORIES.has(category) && attemptNumber === 1 && !cancelling;
}

/** Finishes the attempt; throws LeaseLostError, having written nothing, when the lease is gone. */
export function finishAttempt(db: AppDb, input: FinishInput): Promise<FinishResult> {
  return db.transaction((tx) => finishInTransaction(tx, input));
}

async function finishInTransaction(tx: AppTx, input: FinishInput): Promise<FinishResult> {
  const { claimed, queue, settings } = input;
  const lease = { attemptId: claimed.attemptId, leaseToken: claimed.leaseToken };

  // 1. Locks, in order.
  const [experiment] = await tx
    .select({ priceTable: experiments.priceTable, cancelledAt: experiments.cancelledAt })
    .from(experiments)
    .where(eq(experiments.id, claimed.experimentId))
    .for('no key update');
  const [run] = await tx
    .select({ attemptCount: runs.attemptCount, cancelRequestedAt: runs.cancelRequestedAt })
    .from(runs)
    .where(eq(runs.id, claimed.runId))
    .for('update');
  const [held] = await tx
    .select({ id: attempts.id })
    .from(attempts)
    .where(leaseHeld(lease))
    .for('update');
  if (!experiment || !run || !held) throw new LeaseLostError(claimed.attemptId);

  const outcome = normalise(input.outcome, run.cancelRequestedAt !== null);

  // 2. Evidence, while the attempt is still open.
  await insertFencedEvents(tx, lease, input.nextSeq, outcome.finalEvents);
  await insertArtifacts(tx, lease, outcome.artifacts);

  // 3. The attempt.
  const billed = billableTokens(outcome.tokens, outcome.egressUsage);
  const finished = await fencedWrite(lease, () =>
    tx
      .update(attempts)
      .set({
        status: outcome.status,
        finishedAt: sql`now()`,
        exitCode: outcome.exitCode,
        errorCategory: outcome.category,
        errorMessage: outcome.errorMessage,
        finalText: outcome.finalText,
        sessionId: outcome.sessionId,
        tokens: billed.tokens,
        durationMs:
          outcome.durationMs === null ? null : Math.max(0, Math.round(outcome.durationMs)),
        costUsd: attemptCost(experiment.priceTable, claimed.model, billed.tokens),
        stderrTail: outcome.stderrTail,
        redactions: outcome.redactions,
      })
      .where(leaseHeld(lease))
      .returning({ id: attempts.id }),
  );
  if (finished.length === 0) throw new LeaseLostError(claimed.attemptId);

  // 4. What follows from it.
  let runStatus: RunStatus;
  let retryAttempt: number | null = null;
  let evaluationId: string | null = null;
  let experimentFailed = false;
  if (outcome.status === 'executed') {
    runStatus = 'executed';
    await setRun(tx, claimed.runId, 'executed');
    evaluationId = await queueInitialEvaluation(tx, claimed, queue);
    await tx
      .update(experiments)
      .set({ consecutiveExecutionErrors: 0 })
      .where(eq(experiments.id, claimed.experimentId));
  } else if (outcome.status === 'cancelled') {
    runStatus = 'cancelled';
    await setRun(tx, claimed.runId, 'cancelled');
  } else {
    experimentFailed = await countExecutionError(tx, claimed, outcome, settings);
    if (autoRetries(outcome.category!, run.attemptCount, experiment.cancelledAt !== null)) {
      runStatus = 'queued';
      retryAttempt = run.attemptCount + 1;
      await setRun(tx, claimed.runId, 'queued', 'auto_retry');
      await queue.send(
        tx,
        QUEUES.executeRun,
        {
          runId: claimed.runId,
          attempt: retryAttempt,
          trigger: 'auto_retry',
        } satisfies ExecuteRunJob,
        {
          singletonKey: executeRunKey(claimed.runId, retryAttempt),
          startAfterSeconds: settings.autoRetryDelayS,
        },
      );
    } else {
      runStatus = 'execution_error';
      await setRun(tx, claimed.runId, 'execution_error');
    }
  }

  // 5.
  await releaseInFlight(tx, claimed.workerId);
  const reconciled = await reconcileExperiment(tx, claimed.experimentId);
  return {
    attemptStatus: outcome.status,
    runStatus,
    retryAttempt,
    evaluationId,
    experimentFailed,
    reconciled,
  };
}

/**
 * Makes the outcome one the database accepts and the plan means:
 * - a cancel the user asked for wins over an execution error it caused or
 *   met (a cancelled run is never retried);
 * - executed needs a final text (attempts_executed_text_ck);
 * - a category is set exactly when the status is execution_error.
 */
export function normalise(outcome: AttemptOutcome, cancelRequested: boolean): AttemptOutcome {
  if (outcome.status === 'execution_error' && cancelRequested) {
    return { ...outcome, status: 'cancelled', category: null };
  }
  if (outcome.status === 'executed' && outcome.finalText === null) {
    return {
      ...outcome,
      status: 'execution_error',
      category: 'other',
      errorMessage: outcome.errorMessage ?? 'Hermes ended without a final answer',
    };
  }
  if (outcome.status === 'execution_error') {
    return { ...outcome, category: outcome.category ?? 'other' };
  }
  return { ...outcome, category: null };
}

/** Blob rows (sorted, so two finishers never wait on each other in a cycle), then the artifact rows. */
async function insertArtifacts(
  tx: AppTx,
  lease: { attemptId: string; leaseToken: string },
  files: readonly AttemptArtifact[],
): Promise<void> {
  if (files.length === 0) return;
  const stored = new Map<string, number>();
  for (const file of files) if (file.sha256) stored.set(file.sha256, file.size);
  if (stored.size > 0) {
    await tx
      .insert(blobs)
      .values(
        [...stored]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([sha256, size]) => ({ sha256, size })),
      )
      .onConflictDoNothing();
  }
  await fencedWrite(lease, () =>
    tx.insert(artifacts).values(
      files.map((file) => ({
        attemptId: lease.attemptId,
        root: file.root,
        path: file.path,
        origin: file.origin,
        size: file.size,
        sha256: file.sha256,
        skippedReason: file.skippedReason,
      })),
    ),
  );
}

/**
 * Moves the run; finished_at is set exactly for the final statuses
 * (runs_finished_ck), and a run queued again records its next attempt's trigger.
 */
async function setRun(
  tx: AppTx,
  runId: string,
  status: RunStatus,
  nextTrigger: AttemptTrigger | null = null,
): Promise<void> {
  const final = status === 'execution_error' || status === 'cancelled' || status === 'scored';
  await tx
    .update(runs)
    .set({ status, finishedAt: final ? sql`now()` : null, nextTrigger })
    .where(eq(runs.id, runId));
}

/** Generation 1 of the run's scoring, and its job in the same transaction. */
async function queueInitialEvaluation(
  tx: AppTx,
  claimed: ClaimedAttempt,
  queue: LifecycleQueue,
): Promise<string> {
  // An earlier attempt of this run never reached executed, so this is 1; the
  // max keeps the unique (run, generation) safe whatever came before.
  const [{ next } = { next: 1 }] = await tx
    .select({ next: sql<number>`coalesce(max(${evaluations.generation}), 0)::int + 1` })
    .from(evaluations)
    .where(eq(evaluations.runId, claimed.runId));
  const [evaluation] = await tx
    .insert(evaluations)
    .values({
      runId: claimed.runId,
      attemptId: claimed.attemptId,
      cause: 'initial',
      generation: next,
      status: 'queued',
    })
    .returning({ id: evaluations.id });
  const evaluationId = evaluation!.id;
  await queue.send(tx, QUEUES.evaluateRun, { evaluationId } satisfies EvaluateRunJob, {
    singletonKey: evaluateRunKey(evaluationId),
  });
  return evaluationId;
}

/**
 * The circuit breaker (plan 7.3): +1 in SQL, so concurrent finishers never
 * lose a count. At the threshold a running experiment fails; a paused or
 * cancelled one is left as it is (cancel drains it; a paused one fails on
 * its next error after Resume). Returns whether this call failed it.
 */
async function countExecutionError(
  tx: AppTx,
  claimed: ClaimedAttempt,
  outcome: AttemptOutcome,
  settings: Pick<LifecycleSettings, 'maxConsecutiveExecutionErrors'>,
): Promise<boolean> {
  const [counted] = await tx
    .update(experiments)
    .set({ consecutiveExecutionErrors: sql`${experiments.consecutiveExecutionErrors} + 1` })
    .where(eq(experiments.id, claimed.experimentId))
    .returning({
      count: experiments.consecutiveExecutionErrors,
      status: experiments.status,
      cancelledAt: experiments.cancelledAt,
    });
  const threshold = settings.maxConsecutiveExecutionErrors;
  if (!counted || counted.count < threshold) return false;
  if (counted.status !== 'running' || counted.cancelledAt !== null) return false;
  const failure: ExperimentFailure = {
    at: new Date().toISOString(),
    threshold,
    category: outcome.category!,
    exit_code: outcome.exitCode,
    message: outcome.errorMessage ?? `execution error: ${outcome.category}`,
    stderr_first_line: firstLine(outcome.stderrTail),
    attempt_id: claimed.attemptId,
    run_id: claimed.runId,
  };
  const failed = await tx
    .update(experiments)
    .set({ status: 'failed', finishedAt: sql`now()`, failure })
    .where(and(eq(experiments.id, claimed.experimentId), eq(experiments.status, 'running')))
    .returning({ id: experiments.id });
  return failed.length > 0;
}

/** The finished attempt no longer occupies one of its worker's trials. */
export async function releaseInFlight(tx: AppTx, workerId: string): Promise<void> {
  await tx
    .update(workers)
    .set({ inFlight: sql`greatest(${workers.inFlight} - 1, 0)` })
    .where(eq(workers.id, workerId));
}
