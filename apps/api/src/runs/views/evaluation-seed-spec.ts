/**
 * Evaluations of the run views' seed (runs-seed-spec.ts), written the way
 * evaluate-run, Re-score and the dead letter leave them, so the 0001
 * triggers check every step: generation 1 published with its scores, and a
 * re-score left queued, failed, or published over the previous result.
 *
 * Test-only: the name ends in `spec.ts` so the build leaves it out, but not
 * in `.spec.ts`, so vitest does not run it as a test file.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { runningClaim } from '../../../test/support/seed.js';
import type { TestDb } from '../../../test/support/database.js';
import { evaluations, runs, scores } from '../../database/schema/index.js';
import { extractAnswer } from '../../scoring/extraction.js';
import type { ScoreSeed } from './run-fixtures-spec.js';

/** The score rows of one evaluation. */
const scoreValues = (evaluationId: string, list: readonly ScoreSeed[]) =>
  list.map((s) => ({
    evaluationId,
    key: s.key,
    type: s.type,
    status: s.status,
    isPrimary: s.primary ?? false,
    score: s.score ?? (s.status === 'passed' ? 1 : s.status === 'failed' ? 0 : null),
    comment: s.comment,
    expected: (s.expected ?? null) as never,
    observed: (s.observed ?? null) as never,
    evidence: s.evidence ?? {},
    scorerVersion: 1,
  }));

/** Scores an executed attempt and publishes generation 1; the run becomes scored. */
export async function publishInitial(
  db: TestDb,
  runId: string,
  attemptId: string,
  finalText: string,
  list: readonly ScoreSeed[],
): Promise<void> {
  await db.transaction(async (tx) => {
    const [evaluation] = await tx
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'initial', generation: 1, ...runningClaim() })
      .returning({ id: evaluations.id });
    await tx.insert(scores).values(scoreValues(evaluation!.id, list));
    await tx
      .update(evaluations)
      .set({ status: 'completed', finishedAt: new Date(), answer: extractAnswer(finalText) })
      .where(eq(evaluations.id, evaluation!.id));
    await tx
      .update(runs)
      .set({ status: 'scored', finishedAt: new Date() })
      .where(eq(runs.id, runId));
  });
}

/**
 * What a seeded re-score became: `pending` queued; `failed` as the dead
 * letter marks it, the previous result staying current; `published` with
 * `list` as the new score set, superseding the previous one.
 */
export type RescoreOutcome =
  | { kind: 'pending' }
  | { kind: 'failed'; error: string }
  | { kind: 'published'; finalText: string; list: readonly ScoreSeed[] };

/** A re-score of a scored run's attempt, generation n + 1. The run stays scored. */
export async function seedRescore(
  db: TestDb,
  runId: string,
  attemptId: string,
  outcome: RescoreOutcome,
) {
  return db.transaction(async (tx) => {
    const prior = await tx
      .select({ generation: evaluations.generation })
      .from(evaluations)
      .where(eq(evaluations.runId, runId));
    const generation = Math.max(0, ...prior.map((p) => p.generation)) + 1;
    const base = { runId, attemptId, cause: 'rescore' as const, generation };
    if (outcome.kind === 'pending') {
      const [row] = await tx.insert(evaluations).values(base).returning();
      return row!;
    }
    if (outcome.kind === 'failed') {
      const [row] = await tx.insert(evaluations).values(base).returning();
      const [failed] = await tx
        .update(evaluations)
        .set({
          status: 'failed',
          error: outcome.error,
          startedAt: new Date(),
          finishedAt: new Date(),
        })
        .where(eq(evaluations.id, row!.id))
        .returning();
      return failed!;
    }
    const [row] = await tx
      .insert(evaluations)
      .values({ ...base, ...runningClaim() })
      .returning();
    await tx.insert(scores).values(scoreValues(row!.id, outcome.list));
    // The publish order: the previous result is superseded while this one runs, then it completes.
    await tx
      .update(evaluations)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(evaluations.runId, runId),
          eq(evaluations.status, 'completed'),
          isNull(evaluations.supersededAt),
        ),
      );
    const [published] = await tx
      .update(evaluations)
      .set({
        status: 'completed',
        finishedAt: new Date(),
        answer: extractAnswer(outcome.finalText),
      })
      .where(eq(evaluations.id, row!.id))
      .returning();
    return published!;
  });
}

/**
 * Publishes a queued re-score the way publish.ts does: claimed, its score
 * set written, the previous result superseded, then completed.
 */
export async function publishQueuedRescore(
  db: TestDb,
  evaluation: { id: string; runId: string },
  finalText: string,
  list: readonly ScoreSeed[],
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(evaluations).set(runningClaim()).where(eq(evaluations.id, evaluation.id));
    await tx.insert(scores).values(scoreValues(evaluation.id, list));
    await tx
      .update(evaluations)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(evaluations.runId, evaluation.runId),
          eq(evaluations.status, 'completed'),
          isNull(evaluations.supersededAt),
        ),
      );
    await tx
      .update(evaluations)
      .set({ status: 'completed', finishedAt: new Date(), answer: extractAnswer(finalText) })
      .where(eq(evaluations.id, evaluation.id));
  });
}
