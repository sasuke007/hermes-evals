/**
 * Grading. An evaluation is one pass of every scorer over one attempt's
 * stored evidence; Hermes is never re-run to grade. Re-scoring creates a new
 * evaluation and marks the previous one superseded, so old scores stay
 * readable and nothing is overwritten.
 */
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  EVALUATION_CAUSES,
  EVALUATION_STATUSES,
  SCORE_STATUSES,
  SCORER_TYPES,
  type EvaluationCause,
  type EvaluationStatus,
  type ExtractedAnswer,
  type JsonValue,
  type ScoreEvidence,
  type ScorerType,
  type ScoreStatus,
} from '@hermes-evals/shared';
import { attempts } from './experiments.js';
import { emptyJsonObject, id, jsonValue, oneOf, storableText, tstz } from './_columns.js';

export const evaluations = pgTable(
  'evaluations',
  {
    id: id(),
    runId: text('run_id').notNull(),
    attemptId: text('attempt_id').notNull(),
    cause: text('cause').$type<EvaluationCause>().notNull(),
    /** 1 for the first evaluation of a run, then +1 per re-score. Newer always wins. */
    generation: integer('generation').notNull(),
    status: text('status').$type<EvaluationStatus>().notNull().default('queued'),
    /** The answer extracted from the attempt's final text; null until extraction runs. */
    answer: jsonValue<ExtractedAnswer>('answer'),
    /** Why the evaluation itself failed. Scorer errors are score rows, not this. */
    error: storableText('error'),
    requestedAt: tstz('requested_at').notNull().defaultNow(),
    startedAt: tstz('started_at'),
    finishedAt: tstz('finished_at'),
    /** Set when a later evaluation of the same run completes. */
    supersededAt: tstz('superseded_at'),
    /**
     * Taken by the worker that starts scoring. A redelivered job takes a new
     * token, and only the holder of the current token can publish, so an older
     * or interrupted delivery can never replace the result.
     */
    claimToken: uuid('claim_token'),
    claimExpiresAt: tstz('claim_expires_at'),
  },
  (t) => [
    // The attempt must belong to the run this evaluation names.
    foreignKey({
      name: 'evaluations_attempt_fk',
      columns: [t.attemptId, t.runId],
      foreignColumns: [attempts.id, attempts.runId],
    }),
    index('evaluations_run_requested_idx').on(t.runId, t.requestedAt),
    uniqueIndex('evaluations_run_generation_uq').on(t.runId, t.generation),
    // At most one evaluation of a run waiting or in progress: double clicks collapse.
    uniqueIndex('evaluations_in_flight_uq')
      .on(t.runId)
      .where(sql`status in ('queued', 'running')`),
    // At most one current evaluation per run; its scores are the run's scores.
    uniqueIndex('evaluations_current_uq')
      .on(t.runId)
      .where(sql`status = 'completed' and superseded_at is null`),
    check('evaluations_cause_ck', oneOf(t.cause, EVALUATION_CAUSES)),
    check('evaluations_generation_ck', sql`${t.generation} >= 1`),
    check(
      'evaluations_claim_ck',
      sql`${t.status} <> 'running' or (${t.claimToken} is not null and ${t.claimExpiresAt} is not null)`,
    ),
    check('evaluations_status_ck', oneOf(t.status, EVALUATION_STATUSES)),
    check('evaluations_started_ck', sql`(${t.status} = 'queued') = (${t.startedAt} is null)`),
    check(
      'evaluations_finished_ck',
      sql`(${t.status} in ('completed', 'failed')) = (${t.finishedAt} is not null)`,
    ),
    check('evaluations_failed_ck', sql`${t.status} <> 'failed' or ${t.error} is not null`),
    check('evaluations_superseded_ck', sql`${t.supersededAt} is null or ${t.status} = 'completed'`),
  ],
);

/**
 * The result of one verification key in one evaluation. `failed` means the
 * agent was wrong; `error` means the check itself broke; `ungradable` means no
 * answer could be extracted. Only `passed` counts as a pass.
 */
export const scores = pgTable(
  'scores',
  {
    id: id(),
    evaluationId: text('evaluation_id')
      .notNull()
      .references(() => evaluations.id),
    key: text('key').notNull(),
    type: text('type').$type<ScorerType>().notNull(),
    status: text('status').$type<ScoreStatus>().notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    /** 0 to 1; null when the check errored or nothing was gradable. */
    score: doublePrecision('score'),
    comment: storableText('comment').notNull(),
    expected: jsonValue<JsonValue>('expected'),
    observed: jsonValue<JsonValue>('observed'),
    evidence: jsonValue<ScoreEvidence>('evidence').notNull().default(emptyJsonObject),
    /** Bumped whenever a scorer's behaviour changes. */
    scorerVersion: integer('scorer_version').notNull(),
  },
  (t) => [
    uniqueIndex('scores_evaluation_key_uq').on(t.evaluationId, t.key),
    uniqueIndex('scores_evaluation_primary_uq')
      .on(t.evaluationId)
      .where(sql`is_primary`),
    check('scores_status_ck', oneOf(t.status, SCORE_STATUSES)),
    check('scores_type_ck', oneOf(t.type, SCORER_TYPES)),
    check(
      'scores_score_range_ck',
      sql`${t.score} is null or (${t.score} >= 0 and ${t.score} <= 1)`,
    ),
    check('scores_score_status_ck', sql`${t.status} in ('passed', 'failed') or ${t.score} is null`),
    check('scores_scorer_version_ck', sql`${t.scorerVersion} >= 1`),
  ],
);
