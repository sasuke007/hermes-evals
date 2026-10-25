/**
 * execute-run jobs as the experiment and run commands send and cancel them
 * (plan 7.1 and 7.3). Every call takes the caller's transaction, so jobs
 * commit or roll back with the rows that explain them (fromDrizzle, verified
 * on PGlite and Postgres 17).
 *
 * The queue's exclusive policy keeps one live job per `runId:attempt` key.
 * Sending a key whose job is still waiting is a no-op, which is what makes
 * Resume and Retry failed runs safe to repeat: they re-send every queued
 * run, and only runs whose job was lost (completed by a worker while the
 * experiment was paused, say) get a new one.
 */
import { and, eq, sql, type SQLWrapper } from 'drizzle-orm';
import { fromDrizzle, type DrizzleTransactionLike, type PgBoss } from 'pg-boss';
import type { AttemptTrigger, ExecutionErrorCategory } from '@hermes-evals/shared';
import { attempts, runs } from '../../database/schema/index.js';
import type { AppTx } from '../../database/types.js';
import { executeRunKey, QUEUES, type ExecuteRunJob } from '../../queue/queues.js';

/** Most jobs one query reads back when cancelling; far above any experiment's queued runs. */
const FIND_LIMIT = 100_000;

/**
 * pg-boss's connection over the caller's transaction. AppTx types
 * execute()'s result loosely (it differs by driver); fromDrizzle only runs a
 * drizzle `sql` query through it and reads the rows, which both drivers return.
 */
export const inTransaction = (tx: AppTx) =>
  fromDrizzle(
    {
      execute: (query) => tx.execute(query as SQLWrapper) as Promise<{ rows: unknown[] }>,
    } satisfies DrizzleTransactionLike,
    sql,
  );

/**
 * Sends one execute-run job per entry, in one statement, inside `tx`.
 * Resolves the number of jobs created; a key that already has a live job is
 * skipped (ON CONFLICT DO NOTHING under the exclusive policy).
 */
export async function sendExecuteRuns(
  boss: PgBoss,
  tx: AppTx,
  jobs: readonly ExecuteRunJob[],
): Promise<number> {
  if (jobs.length === 0) return 0;
  const ids = await boss.insert(
    QUEUES.executeRun,
    jobs.map((data) => ({ data, singletonKey: executeRunKey(data.runId, data.attempt) })),
    { db: inTransaction(tx), returnId: true },
  );
  return ids?.length ?? 0;
}

/**
 * Cancels every waiting execute-run job of the given runs, inside `tx`. A
 * job a worker has already taken is left alone: its claim locks the
 * experiment first, finds the run cancelled, and completes it.
 */
export async function cancelExecuteRuns(
  boss: PgBoss,
  tx: AppTx,
  runIds: readonly string[],
): Promise<number> {
  if (runIds.length === 0) return 0;
  const db = inTransaction(tx);
  const wanted = new Set(runIds);
  const waiting = await boss.findJobs<Partial<ExecuteRunJob>>(QUEUES.executeRun, {
    queued: true,
    limit: FIND_LIMIT,
    db,
  });
  const ids = waiting
    .filter((job) => typeof job.data?.runId === 'string' && wanted.has(job.data.runId))
    .map((job) => job.id);
  if (ids.length === 0) return 0;
  await boss.cancel(QUEUES.executeRun, ids, { db });
  return ids.length;
}

/** What the trigger of a re-sent job depends on: the run's last attempt, if any. */
export interface LastAttempt {
  number: number;
  errorCategory: ExecutionErrorCategory | null;
}

/**
 * The trigger of the next attempt of a queued run whose job is sent again,
 * for a run queued before migration 0005 recorded it (runs.next_trigger,
 * which wins whenever it is set): a guess from the last attempt. The run was
 * queued by whatever ended its last attempt: nothing (attempt 1), recovery
 * (worker_lost), the automatic retry (a first attempt's provider or timeout
 * error, plan 8.4), or a user, who may have used Retry or Retry failed runs:
 * the guess cannot tell those apart, which is why the trigger is now stored.
 */
export function queuedRunTrigger(last: LastAttempt | null): AttemptTrigger {
  if (last === null) return 'initial';
  if (last.errorCategory === 'worker_lost') return 'recovery';
  if (
    last.number === 1 &&
    (last.errorCategory === 'provider' || last.errorCategory === 'timeout')
  ) {
    return 'auto_retry';
  }
  return 'user_retry';
}

/**
 * The jobs that put every queued run of an experiment back on the queue,
 * key `runId:(attempt_count + 1)`, each with the trigger the run recorded
 * when it was queued. Reads under the caller's experiment lock, which every
 * status change of these runs takes first, so the set is stable.
 */
export async function queuedRunJobs(tx: AppTx, experimentId: string): Promise<ExecuteRunJob[]> {
  const rows = await tx
    .select({
      runId: runs.id,
      attemptCount: runs.attemptCount,
      nextTrigger: runs.nextTrigger,
      lastNumber: attempts.number,
      lastCategory: attempts.errorCategory,
    })
    .from(runs)
    .leftJoin(attempts, eq(attempts.id, runs.currentAttemptId))
    .where(and(eq(runs.experimentId, experimentId), eq(runs.status, 'queued')))
    .orderBy(runs.id);
  return rows.map((row) => ({
    runId: row.runId,
    attempt: row.attemptCount + 1,
    trigger:
      row.nextTrigger ??
      queuedRunTrigger(
        row.lastNumber === null
          ? null
          : { number: row.lastNumber, errorCategory: row.lastCategory },
      ),
  }));
}
