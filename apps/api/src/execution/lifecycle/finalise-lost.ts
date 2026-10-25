/**
 * Ending an attempt whose lease recovery revoked (plan 8.6 step 3, plan 8.4
 * "Lease revoked, found by recovery"), once its trial container is confirmed
 * gone. One transaction, in the lock order experiment → run → attempt:
 *
 * 1. Lock the three rows; the attempt must still be running and revoked,
 *    otherwise another pass already ended it.
 * 2. One platform event closing its timeline, numbered after the last one:
 *    `worker_lost`, or `cancelled` when a cancel had been requested. Migration
 *    0004 allows exactly these two on a revoked, unfinished attempt.
 * 3. End the attempt: `execution_error · worker_lost`, or `cancelled`.
 *    attempts_guard lets a revoked attempt change only its status, finish
 *    time, category, message, exit code and stderr tail, so nothing else is
 *    written (no tokens, cost or duration: the worker that knew them is gone).
 * 4. The run: cancelled when a cancel was requested or the experiment is
 *    being cancelled; otherwise queued again with attempt n+1 (trigger
 *    `recovery`) while it has had fewer than 3 attempts; otherwise
 *    execution_error, for the user to retry.
 * 5. The attempt's worker no longer runs it (in_flight), then reconcile.
 *
 * Recovery's worker_lost is not counted by the circuit breaker: a dead
 * worker says nothing about the configuration under test, and a run lost
 * three times stops being requeued on its own.
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { RunStatus } from '@hermes-evals/shared';
import { attempts, experiments, runs, workers } from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import { reconcileExperiment, type ReconcileResult } from '../../experiments/reconcile.js';
import { executeRunKey, QUEUES, type ExecuteRunJob } from '../../queue/queues.js';
import { storableJson } from './fence.js';
import { releaseInFlight } from './finish.js';
import type { LifecycleQueue } from './types.js';

/** A worker_lost run is requeued by recovery until it has had this many attempts (plan 8.4). */
export const RECOVERY_MAX_ATTEMPTS = 3;

export interface FinalisedAttempt {
  attemptId: string;
  runId: string;
  experimentId: string;
  attemptStatus: 'execution_error' | 'cancelled';
  runStatus: RunStatus;
  /** The attempt number recovery queued next, or null. */
  requeuedAttempt: number | null;
  reconciled: ReconcileResult;
}

/** Why the attempt was revoked, in the words its timeline and error message show. */
function lostReason(row: {
  workerStoppedAt: Date | null;
  leaseExpiresAt: Date;
  leaseRevokedAt: Date | null;
}): string {
  if (row.workerStoppedAt) return 'its worker stopped before the attempt finished';
  if (row.leaseRevokedAt && row.leaseExpiresAt <= row.leaseRevokedAt) {
    return 'its worker stopped renewing the lease';
  }
  return 'it ran past its deadline';
}

/** Finalises one revoked attempt; null when it was no longer running and revoked. */
export function finaliseLostAttempt(
  db: AppDb,
  attemptId: string,
  queue: LifecycleQueue,
): Promise<FinalisedAttempt | null> {
  return db.transaction((tx) => finaliseInTransaction(tx, attemptId, queue));
}

async function finaliseInTransaction(
  tx: AppTx,
  attemptId: string,
  queue: LifecycleQueue,
): Promise<FinalisedAttempt | null> {
  // run_id and experiment_id never change, so they are read before the locks.
  const [located] = await tx
    .select({ runId: attempts.runId, experimentId: runs.experimentId })
    .from(attempts)
    .innerJoin(runs, eq(runs.id, attempts.runId))
    .where(eq(attempts.id, attemptId));
  if (!located) return null;
  const { runId, experimentId } = located;

  // 1. Locks, in order.
  const [experiment] = await tx
    .select({ cancelledAt: experiments.cancelledAt })
    .from(experiments)
    .where(eq(experiments.id, experimentId))
    .for('no key update');
  const [run] = await tx
    .select({
      status: runs.status,
      attemptCount: runs.attemptCount,
      currentAttemptId: runs.currentAttemptId,
      cancelRequestedAt: runs.cancelRequestedAt,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .for('update');
  const [attempt] = await tx
    .select({
      number: attempts.number,
      workerId: attempts.workerId,
      leaseExpiresAt: attempts.leaseExpiresAt,
      leaseRevokedAt: attempts.leaseRevokedAt,
    })
    .from(attempts)
    .where(
      and(
        eq(attempts.id, attemptId),
        eq(attempts.status, 'running'),
        isNotNull(attempts.leaseRevokedAt),
      ),
    )
    .for('update', { of: attempts });
  if (!experiment || !run || !attempt) return null;
  const [worker] = await tx
    .select({ stoppedAt: workers.stoppedAt })
    .from(workers)
    .where(eq(workers.id, attempt.workerId));

  const cancelled = run.cancelRequestedAt !== null || experiment.cancelledAt !== null;
  const reason = lostReason({ ...attempt, workerStoppedAt: worker?.stoppedAt ?? null });
  const message = cancelled
    ? `Cancelled: ${reason}, and recovery confirmed its trial container is gone.`
    : `Worker lost: ${reason}. Recovery confirmed its trial container is gone.`;

  // 2. The closing event, after the last one the old owner wrote. Nobody
  // else can append to a revoked attempt, so max + 1 under its lock is gap-free.
  const payload = { type: 'platform', subtype: cancelled ? 'cancelled' : 'worker_lost', message };
  await tx.execute(sql`insert into run_events (attempt_id, seq, ts, type, payload)
    select ${attemptId}, coalesce(max(seq), 0) + 1, ${Date.now()}::bigint, 'platform', ${storableJson(payload)}::jsonb
      from run_events where attempt_id = ${attemptId}`);

  // 3. The attempt, with only the columns a revoked attempt may change.
  const attemptStatus = cancelled ? 'cancelled' : 'execution_error';
  await tx
    .update(attempts)
    .set({
      status: attemptStatus,
      finishedAt: sql`now()`,
      errorCategory: cancelled ? null : 'worker_lost',
      errorMessage: message,
    })
    .where(eq(attempts.id, attemptId));

  // 4. The run, when this attempt is still the one it is running.
  let runStatus: RunStatus = run.status;
  let requeuedAttempt: number | null = null;
  if (run.status === 'running' && run.currentAttemptId === attemptId) {
    if (cancelled) {
      runStatus = 'cancelled';
    } else if (run.attemptCount < RECOVERY_MAX_ATTEMPTS) {
      runStatus = 'queued';
      requeuedAttempt = run.attemptCount + 1;
      await queue.send(
        tx,
        QUEUES.executeRun,
        { runId, attempt: requeuedAttempt, trigger: 'recovery' } satisfies ExecuteRunJob,
        { singletonKey: executeRunKey(runId, requeuedAttempt) },
      );
    } else {
      runStatus = 'execution_error';
    }
    const final = runStatus !== 'queued';
    await tx
      .update(runs)
      .set({
        status: runStatus,
        finishedAt: final ? sql`now()` : null,
        nextTrigger: final ? null : 'recovery',
      })
      .where(eq(runs.id, runId));
  }

  // 5.
  await releaseInFlight(tx, attempt.workerId);
  const reconciled = await reconcileExperiment(tx, experimentId);
  return {
    attemptId,
    runId,
    experimentId,
    attemptStatus,
    runStatus,
    requeuedAttempt,
    reconciled,
  };
}
