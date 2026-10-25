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

/** A claim's length in seconds; tests pass a shorter one. */
export const CLAIM_SECONDS = CLAIM_MINUTES * 60;

/**
 * `now() + <seconds> seconds`. Inlined as an integer literal, so Postgres
 * needs no parameter type.
 */
export function claimExpiry(seconds: number = CLAIM_SECONDS) {
  if (!Number.isSafeInteger(seconds) || seconds < 1) {
    throw new RangeError(`claim length ${seconds} s is not a positive whole number`);
  }
  return sql`now() + interval '${sql.raw(String(seconds))} seconds'`;
}

/** `now() + 10 minutes`: the claim length every caller uses outside tests. */
export const CLAIM_EXPIRY = claimExpiry();

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
  claimSeconds: number = CLAIM_SECONDS,
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
        claimExpiresAt: claimExpiry(claimSeconds),
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

/**
 * Extends this delivery's claim to a full claim length from now, while the
 * claim is still its own (Phase 3 S8). The scoring loop calls it after each
 * key, so a task whose verifiers together run longer than one claim is not
 * re-sent by recovery while it is being scored. False when the token no
 * longer matches: a newer delivery took the claim, or the evaluation
 * finished, and this delivery must drop its work.
 *
 * One statement on the evaluation row alone. It changes neither the status
 * nor supersession, so the results-revision trigger touches no experiment
 * and the lock order of claim and publish is not involved.
 */
export async function renewClaim(
  db: AppDb,
  claim: Pick<EvaluationClaim, 'evaluationId' | 'token'>,
  claimSeconds: number = CLAIM_SECONDS,
): Promise<boolean> {
  const renewed = await db
    .update(evaluations)
    .set({ claimExpiresAt: claimExpiry(claimSeconds) })
    .where(
      and(
        eq(evaluations.id, claim.evaluationId),
        eq(evaluations.claimToken, claim.token),
        eq(evaluations.status, 'running'),
      ),
    )
    .returning({ id: evaluations.id });
  return renewed.length > 0;
}
