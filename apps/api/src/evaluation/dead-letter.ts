/**
 * The evaluate-run dead letter (plan 9.4): what happens when grading has
 * failed on every delivery pg-boss allowed.
 *
 * - A run's first evaluation cannot fail (the database refuses it), because
 *   the run would never reach `scored` and its experiment would never
 *   complete. Instead one `error` score per declared key is published, each
 *   saying why grading failed, and the run is scored. An error never counts
 *   as a fail (plan 1, invariant 3), and a later re-score can replace it.
 * - A later generation (a re-score, Phase 3) is marked `failed` with the
 *   reason, and the previous result stays current.
 *
 * Which case applies is decided by the same condition the publish trigger
 * uses: whether the run has a current (completed, not superseded) result.
 *
 * The reason comes from pg-boss: a dead-lettered job carries the failed
 * job's output (its serialised error) and how many retries it used. Error
 * messages from the scoring path name keys, files and SQL, never a secret.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PinoLogger } from 'nestjs-pino';
import type { ExtractedAnswer, VerificationEntry } from '@hermes-evals/shared';
import { attempts, evaluations, runs, tasks } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import { reconcileExperiment } from '../experiments/reconcile.js';
import { extractAnswer } from '../scoring/extraction.js';
import { SCORER_VERSIONS } from '../scoring/registry.js';
import { scorerError } from '../scoring/result.js';
import { CLAIM_EXPIRY, evaluationTarget, lockExperimentAndRun } from './claim.js';
import { EvaluateRunJobSchema } from './job.js';
import { completeEvaluation, insertScores, type Reconcile } from './publish.js';
import type { ScoreDraft } from './score.js';

/** The parts of a pg-boss dead-letter job this handler reads (JobWithMetadata). */
export interface DeadLetterJob {
  data: unknown;
  /** The failed evaluate-run job's output, usually its serialised error. */
  sourceOutput?: object | null;
  /** Retries the failed job used before it was dead-lettered. */
  sourceRetryCount?: number | null;
}

/**
 * - `error_scores`: a first evaluation, published with one error score per key;
 * - `failed`: a re-score, marked failed; the previous result stays current;
 * - `finished`: the evaluation had already completed or failed, nothing changed;
 * - `missing`: no such evaluation.
 */
export type DeadLetterOutcome = 'error_scores' | 'failed' | 'finished' | 'missing';

export interface DeadLetterDeps {
  db: AppDb;
  reconcile?: Reconcile;
}

/** Longest error message kept in a score comment. */
const MAX_MESSAGE_CHARS = 500;

/**
 * The message and first stack frame of the failed job's output. A thrown
 * error is serialised as `{name, message, stack}`; a job pg-boss expired or
 * whose heartbeat stopped carries `{value: {message}}`, e.g. "job timed out".
 */
function errorOf(output: object | null | undefined): {
  message: string | null;
  detail: string | null;
} {
  if (!output) return { message: null, detail: null };
  const { message, stack, value } = output as {
    message?: unknown;
    stack?: unknown;
    value?: unknown;
  };
  if (typeof message !== 'string' && value && typeof value === 'object') return errorOf(value);
  const firstLine = typeof message === 'string' ? message.trim().split('\n')[0] : '';
  return {
    message: firstLine ? firstLine.slice(0, MAX_MESSAGE_CHARS) : null,
    detail: typeof stack === 'string' ? (stack.split('\n')[1]?.trim() ?? null) : null,
  };
}

/** Why grading failed, for the score comments and the evaluation's `error`. */
export function deadLetterReason(job: DeadLetterJob): { message: string; detail: string | null } {
  const tries = typeof job.sourceRetryCount === 'number' ? job.sourceRetryCount + 1 : null;
  const after = tries === null ? 'on every try' : `after ${tries} ${tries === 1 ? 'try' : 'tries'}`;
  const { message, detail } = errorOf(job.sourceOutput);
  return {
    message: message
      ? `grading failed ${after}: ${message}`
      : `grading failed ${after}; the worker log has the error`,
    detail,
  };
}

/** The extracted answer to store beside the error scores; null if even extraction breaks. */
function answerOf(finalText: string | null): ExtractedAnswer | null {
  try {
    return extractAnswer(finalText);
  } catch {
    return null;
  }
}

/** One error score per declared key. */
export function errorScores(
  verification: readonly VerificationEntry[],
  reason: { message: string; detail: string | null },
): ScoreDraft[] {
  return verification.map((entry) => ({
    key: entry.key,
    type: entry.type,
    isPrimary: entry.primary,
    scorerVersion: SCORER_VERSIONS[entry.type],
    result: scorerError(reason.message, reason.detail),
  }));
}

export async function handleEvaluateRunDeadJob(
  job: DeadLetterJob,
  deps: DeadLetterDeps,
  logger: Pick<PinoLogger, 'info' | 'warn' | 'error'>,
): Promise<DeadLetterOutcome> {
  const { evaluationId } = EvaluateRunJobSchema.parse(job.data);
  const reconcile = deps.reconcile ?? reconcileExperiment;
  const reason = deadLetterReason(job);
  const target = await evaluationTarget(deps.db, evaluationId);
  if (!target) {
    logger.warn({ evaluationId }, 'evaluate-run dead letter for an unknown evaluation');
    return 'missing';
  }

  const outcome = await deps.db.transaction(async (tx): Promise<DeadLetterOutcome> => {
    await lockExperimentAndRun(tx, target.experimentId, target.runId);
    const [evaluation] = await tx
      .select({ status: evaluations.status })
      .from(evaluations)
      .where(eq(evaluations.id, evaluationId))
      .for('update');
    if (!evaluation || evaluation.status === 'completed' || evaluation.status === 'failed') {
      return 'finished';
    }
    const [current] = await tx
      .select({ id: evaluations.id })
      .from(evaluations)
      .where(
        and(
          eq(evaluations.runId, target.runId),
          eq(evaluations.status, 'completed'),
          isNull(evaluations.supersededAt),
        ),
      )
      .limit(1);

    if (current) {
      await tx
        .update(evaluations)
        .set({
          status: 'failed',
          error: reason.message,
          startedAt: sql`coalesce(${evaluations.startedAt}, now())`,
          finishedAt: sql`now()`,
        })
        .where(eq(evaluations.id, evaluationId));
      await reconcile(tx, target.experimentId);
      return 'failed';
    }

    const [inputs] = await tx
      .select({ verification: tasks.verification, finalText: attempts.finalText })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .innerJoin(attempts, eq(attempts.id, target.attemptId))
      .where(eq(runs.id, target.runId));
    // Scores can only be added to a running evaluation. A fresh token also
    // fences out any delivery that might still be scoring.
    await tx
      .update(evaluations)
      .set({
        status: 'running',
        startedAt: sql`coalesce(${evaluations.startedAt}, now())`,
        claimToken: sql`gen_random_uuid()`,
        claimExpiresAt: CLAIM_EXPIRY,
      })
      .where(eq(evaluations.id, evaluationId));
    await insertScores(tx, evaluationId, errorScores(inputs?.verification ?? [], reason));
    await completeEvaluation(tx, target, answerOf(inputs?.finalText ?? null), reason.message);
    await reconcile(tx, target.experimentId);
    return 'error_scores';
  });

  const log = { evaluationId, runId: target.runId, outcome, reason: reason.message };
  if (outcome === 'finished') logger.info(log, 'evaluate-run dead letter: already finished');
  else logger.warn(log, 'evaluate-run dead letter: grading failed');
  return outcome;
}
