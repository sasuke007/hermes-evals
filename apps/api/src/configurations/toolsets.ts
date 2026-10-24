/**
 * The toolsets a configuration may enable. The worker runs `hermes tools
 * list` in the trial image at start and stores the result on its workers
 * row, so the list is the real one at the pinned revision; until a live
 * worker has reported one, HERMES_TOOLSETS (verified against the same image)
 * stands in.
 */
import { and, desc, gte, isNull, sql } from 'drizzle-orm';
import { HERMES_TOOLSETS, WORKER_TIMEOUT_MS } from '@hermes-evals/shared';
import { workers } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';

export interface AvailableToolsets {
  /** In the runtime's order. */
  names: string[];
  /** `worker` when a live worker reported the list, `fallback` for HERMES_TOOLSETS. */
  source: 'worker' | 'fallback';
}

/**
 * The newest live worker's toolset list (not stopped, heartbeat under
 * WORKER_TIMEOUT_MS old on the database clock, list not empty), else the
 * fallback.
 */
export async function availableToolsets(db: AppDb): Promise<AvailableToolsets> {
  const [row] = await db
    .select({ toolsets: workers.toolsets })
    .from(workers)
    .where(
      and(
        isNull(workers.stoppedAt),
        gte(
          workers.lastHeartbeatAt,
          sql`now() - (${WORKER_TIMEOUT_MS})::float8 * interval '1 millisecond'`,
        ),
        sql`cardinality(${workers.toolsets}) > 0`,
      ),
    )
    .orderBy(desc(workers.startedAt), desc(workers.id))
    .limit(1);
  return row
    ? { names: row.toolsets, source: 'worker' }
    : { names: [...HERMES_TOOLSETS], source: 'fallback' };
}
