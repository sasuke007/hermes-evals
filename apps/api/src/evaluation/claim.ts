/**
 * Claiming an evaluation (plan 9.4): the step that makes one delivery of an
 * evaluate-run job the owner of the scoring pass.
 *
 * The claim takes a fresh token every time, even from a delivery that finds
 * the evaluation already `running`: pg-boss only re-delivers a job it gave up
 * on (a failure, an expiry, a lost heartbeat), and recovery only re-sends one
 * whose claim expired, so the newest delivery is the one that should finish.
 * An older delivery still scoring keeps going, but its publish finds a token
 * that is no longer its own and changes nothing (publish.ts).
 *
 * Lock order (plan 3.3): experiment, then run, then evaluation. Moving the
 * run to `scoring` fires the results-revision trigger, which updates the
 * experiment row; taking that row first is what keeps two finishers of the
 * same experiment from deadlocking.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import { evaluations, experiments, runs } from '../database/schema/index.js';
import type { AppDb, AppTx } from '../database/types.js';

/** How long a claim lasts before recovery may re-send the job (plan 8.6 step 5). */
export const CLAIM_MINUTES = 10;

/** `now() + 10 minutes`. Inlined from the constant, so Postgres needs no parameter type. */
export const CLAIM_EXPIRY = sql`now() + interval '${sql.raw(String(CLAIM_MINUTES))} minutes'`;

/** The delivery that owns a scoring pass, and the rows it grades. */
export interface EvaluationClaim {
  evaluationId: string;
  runId: string;
  experimentId: string;
  attemptId: string;
  generation: number;
  /** The claim token this delivery took; publish succeeds only while it is still the evaluation's. */
  token: string;
}

/** Where an evaluation sits: its run, experiment and attempt. Null for an unknown id. */
export async function evaluationTarget(
  db: AppDb,
  evaluationId: string,
): Promise<Omit<EvaluationClaim, 'token'> | null> {
  const [row] = await db
    .select({
      evaluationId: evaluations.id,
      runId: evaluations.runId,
      experimentId: runs.experimentId,
      attemptId: evaluations.attemptId,
      generation: evaluations.generation,
    })
    .from(evaluations)
    .innerJoin(runs, eq(runs.id, evaluations.runId))
    .where(eq(evaluations.id, evaluationId));
  return row ?? null;
}

/**
 * Takes the experiment row, then the run row, in that order. Every
 * transaction here that changes a run's or an evaluation's status starts
 * with this.
 */
export async function lockExperimentAndRun(
  tx: AppTx,
  experimentId: string,
  runId: string,
): Promise<void> {
  await tx
    .select({ id: experiments.id })
    .from(experiments)
    .where(eq(experiments.id, experimentId))
    .for('no key update');
  await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for('no key update');
}

/**
 * Claims the evaluation for this delivery and moves its run from `executed`
 * to `scoring`, in one transaction. Null when there is nothing to do: the
 * evaluation already completed or failed, or does not exist.
 *
 * A re-score (Phase 3) grades a run that is already `scored`; the run keeps
 * that status, so only an `executed` run moves.
 */
export async function claimEvaluation(
  db: AppDb,
  evaluationId: string,
): Promise<EvaluationClaim | null> {
  const target = await evaluationTarget(db, evaluationId);
  if (!target) return null;
  return db.transaction(async (tx) => {
    await lockExperimentAndRun(tx, target.experimentId, target.runId);
    const [claimed] = await tx
      .update(evaluations)
      .set({
        status: 'running',
        startedAt: sql`now()`,
        claimToken: sql`gen_random_uuid()`,
        claimExpiresAt: CLAIM_EXPIRY,
      })
      .where(
        and(eq(evaluations.id, evaluationId), inArray(evaluations.status, ['queued', 'running'])),
      )
      .returning({ token: evaluations.claimToken });
    if (!claimed?.token) return null;
    await tx
      .update(runs)
      .set({ status: 'scoring' })
      .where(and(eq(runs.id, target.runId), eq(runs.status, 'executed')));
    return { ...target, token: claimed.token };
  });
}
