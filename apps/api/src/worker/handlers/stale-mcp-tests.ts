/**
 * Clears the `running` records of MCP tests whose job has ended without
 * writing a result. The handler writes `running` before it starts the
 * container; if the worker is killed then, nothing writes the result, and the
 * API only marks the job failed while it is still waiting (MCP_TEST_TIMEOUT_S).
 * A test cut short late would otherwise show `running` until tested again.
 *
 * The queue's heartbeat makes pg-boss fail a dead worker's job about a
 * minute after it stopped beating. Each worker runs this at start and then
 * every RECONCILE_INTERVAL_MS, and changes only records whose job is settled
 * or gone: a live job may belong to another worker, which still writes its
 * own result. The write is guarded by the same status and job id, so a newer
 * result is never overwritten.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { mcpServerVersions } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { QUEUES } from '../../queue/queues.js';
import { readTestRecord, type McpTestRecord } from '../../resources/mcp/test-record.js';

/** How often a worker looks for stale records: about the heartbeat expiry plus pg-boss's supervise pass. */
export const RECONCILE_INTERVAL_MS = 60_000;

export const STALE_TEST_ERROR = 'The worker stopped before the test finished; test it again.';

const LIVE: ReadonlySet<string> = new Set(['created', 'retry', 'active']);

/** The pg-boss call this needs, so a test can answer it. */
export type JobLookup = Pick<PgBoss, 'findJobs'>;

/** Marks failed every `running` record whose job is no longer live. Returns how many it changed. */
export async function reconcileStaleMcpTests(
  db: AppDb,
  boss: JobLookup,
  now: () => Date = () => new Date(),
): Promise<number> {
  const rows = await db
    .select({ id: mcpServerVersions.id, lastTest: mcpServerVersions.lastTest })
    .from(mcpServerVersions)
    .where(sql`${mcpServerVersions.lastTest} ->> 'status' = 'running'`);
  let changed = 0;
  for (const row of rows) {
    const record = readTestRecord(row.lastTest);
    if (record.status !== 'running') continue;
    const [job] = await boss.findJobs(QUEUES.testMcpServer, { id: record.job_id });
    if (job && LIVE.has(job.state)) continue;
    const failed: Extract<McpTestRecord, { status: 'failed' }> = {
      status: 'failed',
      job_id: record.job_id,
      requested_at: record.requested_at,
      finished_at: now().toISOString(),
      error: STALE_TEST_ERROR,
      exit_code: null,
      missing_secret_names: [],
    };
    const written = await db
      .update(mcpServerVersions)
      .set({ lastTest: failed })
      .where(
        and(
          eq(mcpServerVersions.id, row.id),
          sql`${mcpServerVersions.lastTest} ->> 'status' = 'running'`,
          sql`${mcpServerVersions.lastTest} ->> 'job_id' = ${record.job_id}`,
        ),
      )
      .returning({ id: mcpServerVersions.id });
    changed += written.length;
  }
  return changed;
}
