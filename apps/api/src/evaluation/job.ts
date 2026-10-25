/**
 * The evaluate-run job contract, and helpers that start an evaluation by
 * inserting its row and sending its job in the caller's transaction, so
 * neither exists without the other (plan 7.1, 8.4). The singleton key is the
 * evaluation id; with the exclusive policy a second send for the same
 * evaluation while its job is live is a no-op (recovery relies on that when
 * it re-sends jobs whose claim expired, plan 8.6 step 5).
 */
import { eq, sql, type SQLWrapper } from 'drizzle-orm';
import { fromDrizzle, type DrizzleTransactionLike, type PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { EvaluationCause } from '@hermes-evals/shared';
import { evaluations } from '../database/schema/index.js';
import type { AppTx } from '../database/types.js';
import { QUEUES, type EvaluateRunJob } from '../queue/queues.js';

/**
 * The caller's transaction as pg-boss's Drizzle adapter takes it. AppTx types
 * `execute` results loosely (database/types.ts); the adapter only runs a
 * drizzle `sql` query through it and reads the rows, which node-postgres and
 * PGlite both return.
 */
export const bossTx = (tx: AppTx): DrizzleTransactionLike => ({
  execute: (query) => tx.execute(query as SQLWrapper) as Promise<{ rows: unknown[] }>,
});

/** Jobs carry ids only; the handler re-reads the rows. */
export const EvaluateRunJobSchema = z.object({
  evaluationId: z.string().min(1),
}) satisfies z.ZodType<EvaluateRunJob>;

/** Singleton key of an evaluate-run job: one live job per evaluation. */
export const evaluateRunKey = (evaluationId: string): string => evaluationId;

/**
 * Sends the evaluate-run job inside the caller's transaction. Resolves the
 * job id, or null when a live job for this evaluation already exists.
 */
export function sendEvaluateRun(
  boss: PgBoss,
  tx: AppTx,
  evaluationId: string,
): Promise<string | null> {
  const job: EvaluateRunJob = { evaluationId };
  return boss.send(QUEUES.evaluateRun, job, {
    singletonKey: evaluateRunKey(evaluationId),
    db: fromDrizzle(bossTx(tx), sql),
  });
}

/**
 * Inserts the next evaluation of a run and sends its job, in the caller's
 * transaction. `initial` is the one the execution finish inserts beside the
 * executed attempt (generation 1); `rescore` is Phase 3's. The database
 * refuses an evaluation of an attempt that is not `executed`, and a second
 * one while another of the same run is queued or running
 * (evaluations_in_flight_uq).
 */
export async function queueEvaluation(
  boss: PgBoss,
  tx: AppTx,
  input: { runId: string; attemptId: string; cause: EvaluationCause },
): Promise<{ evaluationId: string; generation: number }> {
  const [latest] = await tx
    .select({ generation: sql<number>`coalesce(max(${evaluations.generation}), 0)::int` })
    .from(evaluations)
    .where(eq(evaluations.runId, input.runId));
  const generation = (latest?.generation ?? 0) + 1;
  const [created] = await tx
    .insert(evaluations)
    .values({ runId: input.runId, attemptId: input.attemptId, cause: input.cause, generation })
    .returning({ id: evaluations.id });
  await sendEvaluateRun(boss, tx, created!.id);
  return { evaluationId: created!.id, generation };
}
