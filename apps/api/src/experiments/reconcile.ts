/**
 * Completion: the one function that decides an experiment is done (plan
 * 7.4, UI_FLOWS 13.1). It is called inside every transaction that finishes a
 * run (scores published, final execution error, cancellation, recovery), and
 * by the periodic recovery pass as a safety net. Retries are scheduled
 * before it runs, in the same transaction, so a run waiting for its retry is
 * still `queued`.
 *
 * Steps, in the caller's transaction:
 * 1. `SELECT … FROM experiments WHERE id = $1 FOR NO KEY UPDATE`. The
 *    experiment row is the first lock of every status-changing transaction;
 *    a caller that already holds it takes it again at no cost.
 * 2. Settled means no run in queued, running, executed or scoring, and no
 *    evaluation in queued or running. If not settled, return 'unchanged'.
 * 3. Phase 4 computes the verdict entries here. Until then none are
 *    appended: verdict_history stays as it is.
 * 4. Conditional update: `SET status = 'completed', finished_at = now(),
 *    verdict_revision = results_revision, pause_reason = null, paused_at =
 *    null WHERE id = $1 AND verdict_revision IS DISTINCT FROM
 *    results_revision`, for a running or paused experiment (a cancelled one
 *    is running with cancelled_at set: experiments_cancelled_ck). Two
 *    finishers at the same moment complete it once. A failed experiment is
 *    left alone: the circuit breaker stopped it, and retry-failed reopens it.
 *    An already completed experiment whose results moved (a re-score) only
 *    gets verdict_revision moved forward.
 *
 * Resolves 'completed' when this call completed the experiment, else
 * 'unchanged'.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { experiments, evaluations, runs } from '../database/schema/index.js';
import type { AppTx } from '../database/types.js';

export type ReconcileResult = 'completed' | 'unchanged';

/** Run statuses that mean the experiment still has work in flight. */
const UNSETTLED_RUN_STATUSES = ['queued', 'running', 'executed', 'scoring'] as const;
/** Evaluation statuses that mean a score set may still land. */
const UNSETTLED_EVALUATION_STATUSES = ['queued', 'running'] as const;

export async function reconcileExperiment(
  tx: AppTx,
  experimentId: string,
): Promise<ReconcileResult> {
  // Step 1. Under READ COMMITTED a waiter re-reads the row once the holder
  // commits, so a second finisher sees the first one's `completed`.
  const [experiment] = await tx
    .select({ status: experiments.status })
    .from(experiments)
    .where(eq(experiments.id, experimentId))
    .for('no key update');
  if (!experiment || experiment.status === 'failed') return 'unchanged';

  // Step 2.
  if (!(await isSettled(tx, experimentId))) return 'unchanged';

  // Step 4. verdict_revision only moves forward (experiments_guard) and
  // results_revision is at least verdict_revision (the CHECK), so copying
  // the current results revision is always allowed.
  if (experiment.status === 'completed') {
    await tx
      .update(experiments)
      .set({ verdictRevision: sql`${experiments.resultsRevision}` })
      .where(
        and(
          eq(experiments.id, experimentId),
          eq(experiments.status, 'completed'),
          sql`${experiments.verdictRevision} is distinct from ${experiments.resultsRevision}`,
        ),
      );
    return 'unchanged';
  }
  const completed = await tx
    .update(experiments)
    .set({
      status: 'completed',
      finishedAt: sql`now()`,
      verdictRevision: sql`${experiments.resultsRevision}`,
      // A paused experiment that drains (cancel while paused, or the last
      // in-flight run ending after a pause) completes too; the pause CHECKs
      // require its reason and time to go with it.
      pauseReason: null,
      pausedAt: null,
    })
    .where(
      and(
        eq(experiments.id, experimentId),
        inArray(experiments.status, ['running', 'paused']),
        sql`${experiments.verdictRevision} is distinct from ${experiments.resultsRevision}`,
      ),
    )
    .returning({ id: experiments.id });
  return completed.length > 0 ? 'completed' : 'unchanged';
}

/** No run is still to execute or score, and no evaluation is waiting or running. */
async function isSettled(tx: AppTx, experimentId: string): Promise<boolean> {
  const [busyRun] = await tx
    .select({ id: runs.id })
    .from(runs)
    .where(
      and(eq(runs.experimentId, experimentId), inArray(runs.status, [...UNSETTLED_RUN_STATUSES])),
    )
    .limit(1);
  if (busyRun) return false;
  const [busyEvaluation] = await tx
    .select({ id: evaluations.id })
    .from(evaluations)
    .innerJoin(runs, eq(runs.id, evaluations.runId))
    .where(
      and(
        eq(runs.experimentId, experimentId),
        inArray(evaluations.status, [...UNSETTLED_EVALUATION_STATUSES]),
      ),
    )
    .limit(1);
  return !busyEvaluation;
}
