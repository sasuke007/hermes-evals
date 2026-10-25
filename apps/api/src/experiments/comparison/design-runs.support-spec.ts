/**
 * One run of a design experiment played into the database the way the
 * worker leaves it (./design-world.support-spec.ts seeds the rest).
 */
import { eq } from 'drizzle-orm';
import type { ScorerType, ScoreStatus } from '@hermes-evals/shared';
import { attempts, evaluations, runs, scores } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import type { DesignRun } from './design-world.support-spec.js';

/** A score of the run's published evaluation, one per key of its task. */
export interface PlayedScore {
  key: string;
  type: ScorerType;
  primary: boolean;
  status: ScoreStatus;
  score: number | null;
  comment: string;
}

/**
 * Moves one queued run to `run.status`, in one transaction, as the worker
 * would: attempts (the earlier ones ended as execution errors and retried),
 * the run's lifecycle, and when scored its published evaluation.
 */
export async function playRun(
  db: AppDb,
  run: DesignRun,
  runId: string,
  workerId: string,
  keys: readonly PlayedScore[],
): Promise<void> {
  if (run.status === 'queued') return;
  if (run.status === 'cancelled') {
    await db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(eq(runs.id, runId));
    return;
  }
  const startedAt = new Date('2026-10-22T10:00:00.000Z');
  const finishedAt = new Date(startedAt.getTime() + (run.durationS ?? 60) * 1000);
  const number = Math.max(run.attempts, 1);
  await db.transaction(async (tx) => {
    // The attempts before the last ended in an execution error and were retried.
    for (let n = 1; n < number; n++) {
      const [earlier] = await tx
        .insert(attempts)
        .values({
          runId,
          number: n,
          trigger: n === 1 ? 'initial' : 'auto_retry',
          status: 'running',
          workerId,
          trialPath: `trials/${runId}/a${n}`,
          startedAt,
        })
        .returning({ id: attempts.id });
      await tx
        .update(runs)
        .set({ status: 'running', attemptCount: n, currentAttemptId: earlier!.id })
        .where(eq(runs.id, runId));
      await tx
        .update(attempts)
        .set({
          status: 'execution_error',
          finishedAt: startedAt,
          durationMs: 0,
          exitCode: 1,
          errorCategory: run.category ?? 'timeout',
        })
        .where(eq(attempts.id, earlier!.id));
      await tx.update(runs).set({ status: 'queued' }).where(eq(runs.id, runId));
    }
    const [attempt] = await tx
      .insert(attempts)
      .values({
        runId,
        number,
        trigger: number === 1 ? 'initial' : 'auto_retry',
        status: 'running',
        workerId,
        trialPath: `trials/${runId}/a${number}`,
        startedAt,
      })
      .returning({ id: attempts.id });
    await tx
      .update(runs)
      .set({ status: 'running', attemptCount: number, currentAttemptId: attempt!.id })
      .where(eq(runs.id, runId));
    if (run.status === 'running') return;
    const tokens = run.tokens && { ...run.tokens, cache_read: 0, cache_write: 0 };
    const ended = {
      finishedAt,
      durationMs: (run.durationS ?? 60) * 1000,
      tokens,
      costUsd: run.costUsd,
    };
    if (run.status === 'execution_error') {
      await tx
        .update(attempts)
        .set({
          ...ended,
          status: 'execution_error',
          exitCode: 1,
          errorCategory: run.category ?? 'other',
          errorMessage: `${run.category ?? 'other'} in ${run.taskKey}`,
        })
        .where(eq(attempts.id, attempt!.id));
      await tx
        .update(runs)
        .set({ status: 'execution_error', finishedAt })
        .where(eq(runs.id, runId));
      return;
    }
    await tx
      .update(attempts)
      .set({ ...ended, status: 'executed', exitCode: 0, finalText: '```json\n{}\n```' })
      .where(eq(attempts.id, attempt!.id));
    await tx.update(runs).set({ status: 'executed' }).where(eq(runs.id, runId));
    if (run.status === 'executed') return;
    await tx.update(runs).set({ status: 'scoring' }).where(eq(runs.id, runId));
    const [evaluation] = await tx
      .insert(evaluations)
      .values({
        runId,
        attemptId: attempt!.id,
        cause: 'initial',
        generation: 1,
        status: 'running',
        startedAt: finishedAt,
        claimToken: crypto.randomUUID(),
        claimExpiresAt: new Date(finishedAt.getTime() + 600_000),
      })
      .returning({ id: evaluations.id });
    if (run.status === 'scoring') return;
    await tx.insert(scores).values(
      keys.map((k) => ({
        evaluationId: evaluation!.id,
        key: k.key,
        type: k.type,
        status: k.status,
        isPrimary: k.primary,
        score: k.score,
        comment: k.comment,
        scorerVersion: 1,
      })),
    );
    await tx
      .update(evaluations)
      .set({ status: 'completed', finishedAt })
      .where(eq(evaluations.id, evaluation!.id));
    await tx.update(runs).set({ status: 'scored', finishedAt }).where(eq(runs.id, runId));
  });
}
