import { and, desc, gte, isNull, sql } from 'drizzle-orm';
import { WORKER_TIMEOUT_MS } from '@hermes-evals/shared';
import { workers } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';

export type WorkerRow = typeof workers.$inferSelect;

/**
 * The most recently started worker that has not stopped and heartbeated in
 * the last `maxAgeMs`, or null. The API asks before it waits on a worker job
 * (sendAndWait), so it can answer 503 "no worker connected" at once instead
 * of timing out. Age is measured on the database clock, which the heartbeat
 * should write too (`last_heartbeat_at = now()`).
 */
export async function findLiveWorker(
  db: AppDb,
  maxAgeMs: number = WORKER_TIMEOUT_MS,
): Promise<WorkerRow | null> {
  const [row] = await db
    .select()
    .from(workers)
    .where(
      and(
        isNull(workers.stoppedAt),
        gte(workers.lastHeartbeatAt, sql`now() - (${maxAgeMs})::float8 * interval '1 millisecond'`),
      ),
    )
    .orderBy(desc(workers.startedAt), desc(workers.id))
    .limit(1);
  return row ?? null;
}
