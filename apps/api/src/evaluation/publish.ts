/**
 * Publishing a score set (plan 9.4): one transaction that makes the scores
 * the run's result.
 *
 * 1. Lock the experiment, then the run (claim.ts lockExperimentAndRun).
 * 2. Re-read the evaluation FOR UPDATE with this delivery's claim token. No
 *    row means a newer delivery took the claim, or already published: this
 *    one changes nothing.
 * 3. Insert every score in one statement.
 * 4. Supersede the run's previous current evaluation, complete this one with
 *    its extracted answer, and move the run to `scored`.
 * 5. Reconcile the experiment (plan 7.4), which completes it once nothing is
 *    left in flight.
 *
 * The database checks the rest when the evaluation completes
 * (hermes_evaluations_publish_guard): it must grade the run's current
 * attempt, hold exactly the task's declared keys, and be the newest
 * generation published. Scores can only be inserted while the evaluation is
 * `running`, and the one-current-evaluation index needs the old result
 * superseded before the new one completes, which is the order used here.
 */
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { ExtractedAnswer } from '@hermes-evals/shared';
import { evaluations, runs, scores } from '../database/schema/index.js';
import type { AppDb, AppTx } from '../database/types.js';
import { reconcileExperiment, type ReconcileResult } from '../experiments/reconcile.js';
import { lockExperimentAndRun, type EvaluationClaim } from './claim.js';
import type { ScoreDraft, ScoredEvaluation } from './score.js';

/** The completion step: reconcileExperiment, or a stand-in a test passes. */
export type Reconcile = (tx: AppTx, experimentId: string) => Promise<ReconcileResult>;

/** `lost`: another delivery holds the claim, or already published; nothing was written. */
export type PublishOutcome = 'published' | 'lost';

/** The score rows of one evaluation, as one insert writes them. */
export function scoreRows(
  evaluationId: string,
  drafts: readonly ScoreDraft[],
): (typeof scores.$inferInsert)[] {
  return drafts.map(({ key, type, isPrimary, scorerVersion, result }) => ({
    evaluationId,
    key,
    type,
    status: result.status,
    isPrimary,
    score: result.score,
    comment: result.comment,
    expected: result.expected ?? null,
    observed: result.observed ?? null,
    evidence: result.evidence ?? {},
    scorerVersion,
  }));
}

/** Inserts the whole score set in one statement. The evaluation must be `running`. */
export async function insertScores(
  tx: AppTx,
  evaluationId: string,
  drafts: readonly ScoreDraft[],
): Promise<void> {
  if (drafts.length === 0) return;
  await tx.insert(scores).values(scoreRows(evaluationId, drafts));
}

/**
 * Supersedes the run's previous result, completes this evaluation and moves
 * the run to `scored`. The caller holds the experiment and run locks and has
 * inserted the scores. `error` records why grading failed when the scores
 * are the dead-letter handler's error set; null otherwise.
 */
export async function completeEvaluation(
  tx: AppTx,
  target: Pick<EvaluationClaim, 'evaluationId' | 'runId' | 'generation'>,
  answer: ExtractedAnswer | null,
  error: string | null,
): Promise<void> {
  await tx
    .update(evaluations)
    .set({ supersededAt: sql`now()` })
    .where(
      and(
        eq(evaluations.runId, target.runId),
        eq(evaluations.status, 'completed'),
        isNull(evaluations.supersededAt),
        lt(evaluations.generation, target.generation),
      ),
    );
  await tx
    .update(evaluations)
    .set({ status: 'completed', finishedAt: sql`now()`, answer, error })
    .where(eq(evaluations.id, target.evaluationId));
  // A re-score grades a run that is already scored; it keeps its status and finish time.
  await tx
    .update(runs)
    .set({ status: 'scored', finishedAt: sql`now()` })
    .where(and(eq(runs.id, target.runId), inArray(runs.status, ['executed', 'scoring'])));
}

/** Publishes what this delivery scored, if it still owns the claim. */
export function publishEvaluation(
  db: AppDb,
  claim: EvaluationClaim,
  scored: ScoredEvaluation,
  reconcile: Reconcile = reconcileExperiment,
): Promise<PublishOutcome> {
  return db.transaction(async (tx) => {
    await lockExperimentAndRun(tx, claim.experimentId, claim.runId);
    const [owned] = await tx
      .select({ id: evaluations.id })
      .from(evaluations)
      .where(
        and(
          eq(evaluations.id, claim.evaluationId),
          eq(evaluations.claimToken, claim.token),
          eq(evaluations.status, 'running'),
        ),
      )
      .for('update');
    if (!owned) return 'lost';
    await insertScores(tx, claim.evaluationId, scored.scores);
    await completeEvaluation(tx, claim, scored.answer, null);
    await reconcile(tx, claim.experimentId);
    return 'published';
  });
}
