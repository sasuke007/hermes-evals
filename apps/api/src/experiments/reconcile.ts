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
 *    Nor is there anything to record when verdict_revision already equals
 *    results_revision.
 * 3. Compute the verdict entries from the current scores: one per
 *    candidate, on the primary key, as final statistics
 *    (comparison/verdicts.ts). Holding the row, no run can change status
 *    and no score set can publish while they are read, since each of those
 *    updates the row (the 0001 results-revision triggers). The cause:
 *    `initial` for the first entries; `rescore` when the experiment had
 *    already completed and its results moved (a re-score published, the
 *    experiment staying completed); `retry` when Retry failed runs or a
 *    user retry reopened it and it settled again. The note counts what
 *    happened since the previous entries ("1 retry", "3 runs re-scored").
 * 4. Conditional update: `SET status = 'completed', finished_at = now(),
 *    verdict_history = verdict_history || $entries, verdict_revision =
 *    results_revision, pause_reason = null, paused_at = null WHERE id = $1
 *    AND verdict_revision IS DISTINCT FROM results_revision`, for a running
 *    or paused experiment (a cancelled one is running with cancelled_at set:
 *    experiments_cancelled_ck). Two finishers at the same moment complete it
 *    and append once: the second waits for the row and then finds the
 *    revisions equal. A failed experiment is left alone: the circuit breaker
 *    stopped it, and retry-failed reopens it. An already completed
 *    experiment whose results moved gets the same append, cause `rescore`,
 *    and its verdict_revision moved forward; it stays completed.
 *
 * Resolves 'completed' when this call completed the experiment, else
 * 'unchanged' (also when it appended to a completed one).
 */
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { VerdictCause, VerdictEntry } from '@hermes-evals/shared';
import { attempts, evaluations, experiments, runs } from '../database/schema/index.js';
import type { AppTx } from '../database/types.js';
import { loadExperimentResults } from './comparison/results.js';
import { verdictEntryOf, verdictFiguresOf } from './comparison/verdicts.js';

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
  // commits, so a second finisher sees the first one's `completed` and its
  // verdict revision.
  const [experiment] = await tx
    .select({
      status: experiments.status,
      resultsRevision: experiments.resultsRevision,
      verdictRevision: experiments.verdictRevision,
      verdictHistory: experiments.verdictHistory,
      now: sql<Date | string>`now()`,
    })
    .from(experiments)
    .where(eq(experiments.id, experimentId))
    .for('no key update');
  if (!experiment || experiment.status === 'failed') return 'unchanged';

  // Step 2.
  if (experiment.verdictRevision === experiment.resultsRevision) return 'unchanged';
  if (!(await isSettled(tx, experimentId))) return 'unchanged';

  // Step 3. now() is the transaction's start, the same instant finished_at takes.
  const at = new Date(experiment.now).toISOString();
  const completed = experiment.status === 'completed';
  const previous = experiment.verdictHistory.at(-1) ?? null;
  const cause: VerdictCause = previous === null ? 'initial' : completed ? 'rescore' : 'retry';
  const entries = await verdictEntries(tx, experimentId, {
    at,
    cause,
    note: previous === null ? null : await noteSince(tx, experimentId, cause, previous),
  });
  const append = {
    verdictHistory: sql`${experiments.verdictHistory} || ${JSON.stringify(entries)}::jsonb`,
    // verdict_revision only moves forward (experiments_guard) and
    // results_revision is at least verdict_revision (the CHECK), so copying
    // the current results revision is always allowed.
    verdictRevision: sql`${experiments.resultsRevision}`,
  };
  const pending = sql`${experiments.verdictRevision} is distinct from ${experiments.resultsRevision}`;

  // Step 4.
  if (completed) {
    await tx
      .update(experiments)
      .set(append)
      .where(and(eq(experiments.id, experimentId), eq(experiments.status, 'completed'), pending));
    return 'unchanged';
  }
  const done = await tx
    .update(experiments)
    .set({
      status: 'completed',
      finishedAt: sql`now()`,
      ...append,
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
        pending,
      ),
    )
    .returning({ id: experiments.id });
  return done.length > 0 ? 'completed' : 'unchanged';
}

/** One entry per candidate, in candidate order, from the results as they stand. */
async function verdictEntries(
  tx: AppTx,
  experimentId: string,
  meta: { at: string; cause: VerdictCause; note: string | null },
): Promise<VerdictEntry[]> {
  const results = await loadExperimentResults(tx, experimentId);
  if (!results) throw new Error(`experiment ${experimentId} vanished while it was locked`);
  const figures = verdictFiguresOf(results, { final: true });
  return [...figures.byCandidate].map(([candidateVersionId, stats]) =>
    verdictEntryOf(stats, {
      ...meta,
      candidateVersionId,
      resultsRevision: results.resultsRevision,
    }),
  );
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * What moved the results since the previous entries were appended, for the
 * VerdictCard's "Updated … after 1 retry": the runs a user or Retry failed
 * runs sent again, or the runs whose re-score published. Counted from the
 * previous entries' time, so a step that started just before them and
 * landed after may be missed; null when nothing is found.
 */
async function noteSince(
  tx: AppTx,
  experimentId: string,
  cause: VerdictCause,
  previous: VerdictEntry,
): Promise<string | null> {
  const since = new Date(previous.at);
  if (cause === 'retry') {
    const [row] = await tx
      .select({ n: sql<number>`count(distinct ${attempts.runId})`.mapWith(Number) })
      .from(attempts)
      .innerJoin(runs, eq(runs.id, attempts.runId))
      .where(
        and(
          eq(runs.experimentId, experimentId),
          inArray(attempts.trigger, ['user_retry', 'retry_failed']),
          gt(attempts.startedAt, since),
        ),
      );
    const n = row?.n ?? 0;
    return n === 0 ? null : plural(n, 'retry', 'retries');
  }
  const [row] = await tx
    .select({ n: sql<number>`count(distinct ${evaluations.runId})`.mapWith(Number) })
    .from(evaluations)
    .innerJoin(runs, eq(runs.id, evaluations.runId))
    .where(
      and(
        eq(runs.experimentId, experimentId),
        eq(evaluations.cause, 'rescore'),
        eq(evaluations.status, 'completed'),
        gt(evaluations.finishedAt, since),
      ),
    );
  const n = row?.n ?? 0;
  return n === 0 ? null : `${plural(n, 'run', 'runs')} re-scored`;
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
