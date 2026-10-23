import { sql } from 'drizzle-orm';
import { fromDrizzle, type DrizzleTransactionLike, type PgBoss } from 'pg-boss';
import type { QueueName } from './queues.js';

/**
 * Puts a job back to run later without ever losing it.
 *
 * The platform's queues use pg-boss's `exclusive` policy: one live job per
 * singleton key, where live means created, retry or active. A handler that
 * re-sends its own key while its job is still active is silently refused
 * (send returns null), and the run would be left with no job at all. So the
 * active job is completed and the delayed copy sent in the caller's
 * transaction: both commit together, and the key is never without a job.
 *
 * Use it for every "not now" answer a handler gives: a paused experiment, the
 * spend guard, or a full experiment concurrency slot.
 */
export async function deferJob<T extends object>(
  boss: PgBoss,
  tx: DrizzleTransactionLike,
  queue: QueueName,
  job: { id: string; data: T },
  options: { singletonKey: string; startAfterSeconds: number },
): Promise<string> {
  const db = fromDrizzle(tx, sql);
  await boss.complete(queue, job.id, null, { db });
  const id = await boss.send(queue, job.data, {
    singletonKey: options.singletonKey,
    startAfter: options.startAfterSeconds,
    db,
  });
  if (!id) {
    throw new Error(
      `could not defer ${queue} job ${job.id}: another live job holds ${options.singletonKey}`,
    );
  }
  return id;
}
