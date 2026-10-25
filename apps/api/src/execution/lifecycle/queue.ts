/**
 * The lifecycle's queue seam over pg-boss: every job it sends or defers goes
 * through the caller's Drizzle transaction (fromDrizzle), so the job and the
 * rows that need it commit together or not at all (plan 7.1, verified on
 * Postgres 17 in postgres.e2e-spec.ts).
 */
import { sql, type SQLWrapper } from 'drizzle-orm';
import { fromDrizzle, type DrizzleTransactionLike, type PgBoss } from 'pg-boss';
import type { AppTx } from '../../database/types.js';
import { deferJob } from '../../queue/defer.js';
import { QUEUES } from '../../queue/queues.js';
import type { LifecycleQueue } from './types.js';

/**
 * An AppTx as pg-boss's DrizzleTransactionLike. AppTx types execute()'s
 * result as unknown (it differs by driver); fromDrizzle only calls execute
 * with a drizzle `sql` query and reads its rows, which both drivers return.
 */
export const bossTransaction = (tx: AppTx): DrizzleTransactionLike => ({
  execute: (query) => tx.execute(query as SQLWrapper) as Promise<{ rows: unknown[] }>,
});

export function pgBossLifecycleQueue(boss: PgBoss): LifecycleQueue {
  return {
    async defer(tx, job, options) {
      await deferJob(boss, bossTransaction(tx), QUEUES.executeRun, job, options);
    },
    send(tx, queue, data, options) {
      return boss.send(queue, data, {
        singletonKey: options.singletonKey,
        ...(options.startAfterSeconds ? { startAfter: options.startAfterSeconds } : {}),
        db: fromDrizzle(bossTransaction(tx), sql),
      });
    },
    async sendMany(tx, queue, jobs) {
      if (jobs.length === 0) return 0;
      // insert ends in ON CONFLICT DO NOTHING: under the exclusive policy a
      // key with a live job is skipped, and only the created ids come back.
      const ids = await boss.insert(
        queue,
        jobs.map((job) => ({ data: job.data, singletonKey: job.singletonKey })),
        { db: fromDrizzle(bossTransaction(tx), sql), returnId: true },
      );
      return ids?.length ?? 0;
    },
  };
}
