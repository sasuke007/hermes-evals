/**
 * Experiments, the run matrix and attempts.
 *
 * An experiment runs every selected task under the baseline and each candidate
 * configuration version, `repetitions` times. Each cell of that matrix is a
 * run. Each launch of Hermes for a run is an attempt; a run gets a new attempt
 * only when its previous one ended in `execution_error` and it is retried.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  numeric,
  bigint,
  uuid,
  pgTable,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  ATTEMPT_STATUSES,
  ATTEMPT_TRIGGERS,
  EXECUTION_ERROR_CATEGORIES,
  EXPERIMENT_STATUSES,
  PAUSE_REASONS,
  RUN_STATUSES,
  type AttemptStatus,
  type AttemptTrigger,
  type ExecutionErrorCategory,
  type ExperimentEstimate,
  type ExperimentFailure,
  type ExperimentStatus,
  type LaunchRecord,
  type PauseReason,
  type PriceTable,
  type RunStatus,
  type Tokens,
  type VerdictEntry,
} from '@hermes-evals/shared';
import { configurationVersions } from './configurations.js';
import { suites, tasks } from './suites.js';
import { workers } from './workers.js';
import {
  createdAt,
  emptyJsonArray,
  id,
  isRelativePath,
  jsonValue,
  nullOrOneOf,
  oneOf,
  storableText,
  tstz,
} from './_columns.js';

/** Most attempts a run may have: the first plus up to four retries. */
export const MAX_ATTEMPTS_PER_RUN = 5;

/**
 * One comparison of candidate configuration versions against a baseline on a
 * set of tasks. Everything it tests is frozen at launch: the suite row, the
 * configuration versions, the Hermes revision and the price table.
 */
export const experiments = pgTable(
  'experiments',
  {
    id: id(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').$type<ExperimentStatus>().notNull().default('running'),
    pauseReason: text('pause_reason').$type<PauseReason>(),
    pausedAt: tstz('paused_at'),
    /** Set by Cancel. Queued runs are cancelled at once; running ones drain. */
    cancelledAt: tstz('cancelled_at'),
    suiteId: text('suite_id')
      .notNull()
      .references(() => suites.id),
    /** Selected tasks of that suite row, in display order. */
    taskIds: text('task_ids').array().notNull(),
    baselineVersionId: text('baseline_version_id')
      .notNull()
      .references(() => configurationVersions.id),
    /** One or more candidates, in display order. */
    candidateVersionIds: text('candidate_version_ids').array().notNull(),
    repetitions: integer('repetitions').notNull(),
    /** Most runs of this experiment allowed to execute at once. */
    concurrency: integer('concurrency').notNull(),
    spendCeilingUsd: numeric('spend_ceiling_usd', { precision: 10, scale: 2, mode: 'number' }),
    /** Optional cap on every run's time budget, in seconds. */
    timeBudgetOverrideS: integer('time_budget_override_s'),
    hermesVersion: text('hermes_version').notNull(),
    hermesRevision: text('hermes_revision').notNull(),
    priceTable: jsonValue<PriceTable>('price_table').notNull(),
    estimate: jsonValue<ExperimentEstimate>('estimate'),
    /** Circuit breaker counter; reset by any successful execution. */
    consecutiveExecutionErrors: integer('consecutive_execution_errors').notNull().default(0),
    failure: jsonValue<ExperimentFailure>('failure'),
    /** Append-only; the last entry per candidate is the current verdict. */
    verdictHistory: jsonValue<VerdictEntry[]>('verdict_history').notNull().default(emptyJsonArray),
    /**
     * Bumped by triggers whenever a run changes status or a score set is
     * published or superseded. Comparisons are cached by it, so a retry,
     * cancel or re-score can never serve a stale verdict.
     */
    resultsRevision: bigint('results_revision', { mode: 'number' }).notNull().default(0),
    /** The results revision the last verdict entries were computed from. */
    verdictRevision: bigint('verdict_revision', { mode: 'number' }),
    createdAt: createdAt(),
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    check('experiments_status_ck', oneOf(t.status, EXPERIMENT_STATUSES)),
    check('experiments_pause_reason_ck', nullOrOneOf(t.pauseReason, PAUSE_REASONS)),
    check('experiments_paused_ck', sql`(${t.status} = 'paused') = (${t.pauseReason} is not null)`),
    check('experiments_paused_at_ck', sql`(${t.pauseReason} is null) = (${t.pausedAt} is null)`),
    check(
      'experiments_finished_ck',
      sql`(${t.status} in ('completed', 'failed')) = (${t.finishedAt} is not null)`,
    ),
    check('experiments_failure_ck', sql`${t.status} <> 'failed' or ${t.failure} is not null`),
    check(
      'experiments_cancelled_ck',
      sql`${t.cancelledAt} is null or ${t.status} in ('running', 'completed')`,
    ),
    check('experiments_repetitions_ck', sql`${t.repetitions} >= 1`),
    check('experiments_concurrency_ck', sql`${t.concurrency} between 1 and 16`),
    check(
      'experiments_spend_ceiling_ck',
      // numeric accepts NaN and sorts it above every number, so `> 0` alone lets it in.
      sql`${t.spendCeilingUsd} is null or (${t.spendCeilingUsd} > 0 and ${t.spendCeilingUsd} <> 'NaN'::numeric)`,
    ),
    check(
      'experiments_time_budget_ck',
      sql`${t.timeBudgetOverrideS} is null or ${t.timeBudgetOverrideS} between 30 and 3600`,
    ),
    check(
      'experiments_verdict_revision_ck',
      sql`${t.verdictRevision} is null or ${t.verdictRevision} <= ${t.resultsRevision}`,
    ),
    check('experiments_verdict_history_ck', sql`jsonb_typeof(${t.verdictHistory}) = 'array'`),
    check('experiments_consecutive_errors_ck', sql`${t.consecutiveExecutionErrors} >= 0`),
    check('experiments_tasks_ck', sql`cardinality(${t.taskIds}) >= 1`),
    check('experiments_candidates_ck', sql`cardinality(${t.candidateVersionIds}) >= 1`),
    check(
      'experiments_baseline_not_candidate_ck',
      sql`not (${t.baselineVersionId} = any(${t.candidateVersionIds}))`,
    ),
    check('experiments_hermes_revision_ck', sql`${t.hermesRevision} ~ '^[0-9a-f]{40}$'`),
  ],
);

/**
 * One cell of the run matrix: a task under a configuration version, for one
 * repetition. `status` is the run's lifecycle and the only status the UI and
 * the statistics read.
 */
export const runs = pgTable(
  'runs',
  {
    id: id(),
    experimentId: text('experiment_id')
      .notNull()
      .references(() => experiments.id),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id),
    configurationVersionId: text('configuration_version_id')
      .notNull()
      .references(() => configurationVersions.id),
    /** 1-based. */
    repetition: integer('repetition').notNull(),
    status: text('status').$type<RunStatus>().notNull().default('queued'),
    /** Attempts created so far; the next execute-run job carries attempt_count + 1. */
    attemptCount: integer('attempt_count').notNull().default(0),
    /** The latest attempt; the foreign key also checks it belongs to this run. */
    currentAttemptId: text('current_attempt_id'),
    /** Set by Cancel while the run is running; the worker polls it and kills Hermes. */
    cancelRequestedAt: tstz('cancel_requested_at'),
    createdAt: createdAt(),
    /** Set when the run reaches scored, execution_error or cancelled. */
    finishedAt: tstz('finished_at'),
  },
  (t) => [
    uniqueIndex('runs_matrix_uq').on(
      t.experimentId,
      t.taskId,
      t.configurationVersionId,
      t.repetition,
    ),
    foreignKey({
      name: 'runs_current_attempt_fk',
      columns: [t.currentAttemptId, t.id],
      foreignColumns: [attempts.id, attempts.runId],
    }),
    index('runs_experiment_status_idx').on(t.experimentId, t.status),
    index('runs_configuration_version_idx').on(t.configurationVersionId),
    check('runs_status_ck', oneOf(t.status, RUN_STATUSES)),
    check('runs_repetition_ck', sql`${t.repetition} >= 1`),
    check(
      'runs_attempt_count_ck',
      sql`${t.attemptCount} between 0 and ${sql.raw(String(MAX_ATTEMPTS_PER_RUN))}`,
    ),
    check(
      'runs_attempt_pointer_ck',
      sql`(${t.attemptCount} = 0) = (${t.currentAttemptId} is null)`,
    ),
    check(
      'runs_attempt_present_ck',
      sql`${t.status} in ('queued', 'cancelled') or ${t.currentAttemptId} is not null`,
    ),
    check(
      'runs_finished_ck',
      sql`(${t.status} in ('scored', 'execution_error', 'cancelled')) = (${t.finishedAt} is not null)`,
    ),
  ],
);

/**
 * One launch of Hermes for a run: how it was launched, what it returned and
 * how it ended. Immutable once `finished_at` is set (enforced by a trigger).
 * The event stream and collected files hang off the attempt.
 */
export const attempts = pgTable(
  'attempts',
  {
    id: id(),
    // Annotated: runs and attempts reference each other, which TypeScript cannot infer.
    runId: text('run_id')
      .notNull()
      .references((): AnyPgColumn => runs.id),
    /** 1-based, equal to the execute-run job's `attempt`. */
    number: integer('number').notNull(),
    trigger: text('trigger').$type<AttemptTrigger>().notNull(),
    status: text('status').$type<AttemptStatus>().notNull(),
    workerId: text('worker_id')
      .notNull()
      .references(() => workers.id),
    startedAt: tstz('started_at').notNull().defaultNow(),
    finishedAt: tstz('finished_at'),
    exitCode: integer('exit_code'),
    errorCategory: text('error_category').$type<ExecutionErrorCategory>(),
    errorMessage: storableText('error_message'),
    /** Text of Hermes's `result` event: the agent's final answer. */
    finalText: storableText('final_text'),
    sessionId: text('session_id'),
    /** From the `result` event; null when Hermes never sent one. */
    tokens: jsonValue<Tokens>('tokens'),
    durationMs: integer('duration_ms'),
    /** From tokens and the experiment's frozen price table; null when unpriced. */
    costUsd: numeric('cost_usd', { precision: 12, scale: 6, mode: 'number' }),
    /** Trial directory relative to DATA_DIR. stderr.log lives inside it. */
    trialPath: text('trial_path').notNull(),
    /** Written before Hermes is spawned; null only while the trial is being built. */
    launchRecord: jsonValue<LaunchRecord>('launch_record'),
    /** Last 40 lines of stderr, secrets redacted. */
    stderrTail: storableText('stderr_tail'),
    /** How many secret values were replaced in events, final text and stderr. */
    redactions: integer('redactions').notNull().default(0),
    /**
     * Ownership. Every write the worker makes to a running attempt is fenced on
     * this token (WHERE lease_token = $token AND lease_revoked_at IS NULL), so a
     * worker that lost the attempt can no longer change it.
     */
    leaseToken: uuid('lease_token').notNull().defaultRandom(),
    /** Renewed every 10 s by the owning worker; an expired lease is revoked by recovery. */
    leaseExpiresAt: tstz('lease_expires_at')
      .notNull()
      .default(sql`now() + interval '60 seconds'`),
    /** Set once by recovery. A revoked attempt can only be ended, never executed. */
    leaseRevokedAt: tstz('lease_revoked_at'),
    /** The isolated environment running the attempt (its container), written once. */
    sandboxId: text('sandbox_id'),
    /** The host or daemon that can confirm the sandbox stopped before a replacement starts. */
    sandboxHostId: text('sandbox_host_id'),
  },
  (t) => [
    unique('attempts_run_number_uq').on(t.runId, t.number),
    // Target of the evaluations foreign key, which checks attempt and run agree.
    unique('attempts_id_run_uq').on(t.id, t.runId),
    // A run has at most one attempt executing at a time.
    index('attempts_lease_expiry_idx')
      .on(t.leaseExpiresAt)
      .where(sql`status = 'running'`),
    uniqueIndex('attempts_one_running_uq')
      .on(t.runId)
      .where(sql`status = 'running'`),
    uniqueIndex('attempts_trial_path_uq').on(t.trialPath),
    index('attempts_running_worker_idx')
      .on(t.workerId)
      .where(sql`status = 'running'`),
    check('attempts_status_ck', oneOf(t.status, ATTEMPT_STATUSES)),
    check('attempts_trigger_ck', oneOf(t.trigger, ATTEMPT_TRIGGERS)),
    check('attempts_error_category_ck', nullOrOneOf(t.errorCategory, EXECUTION_ERROR_CATEGORIES)),
    check(
      'attempts_number_ck',
      sql`${t.number} between 1 and ${sql.raw(String(MAX_ATTEMPTS_PER_RUN))}`,
    ),
    check('attempts_initial_ck', sql`(${t.number} = 1) = (${t.trigger} = 'initial')`),
    check('attempts_finished_ck', sql`(${t.status} = 'running') = (${t.finishedAt} is null)`),
    check(
      'attempts_error_category_status_ck',
      sql`(${t.status} = 'execution_error') = (${t.errorCategory} is not null)`,
    ),
    check(
      'attempts_executed_text_ck',
      sql`${t.status} <> 'executed' or ${t.finalText} is not null`,
    ),
    check('attempts_duration_ck', sql`${t.durationMs} is null or ${t.durationMs} >= 0`),
    check(
      'attempts_cost_ck',
      sql`${t.costUsd} is null or (${t.costUsd} >= 0 and ${t.costUsd} <> 'NaN'::numeric)`,
    ),
    check('attempts_redactions_ck', sql`${t.redactions} >= 0`),
    check(
      'attempts_revoked_not_executed_ck',
      sql`${t.leaseRevokedAt} is null or ${t.status} <> 'executed'`,
    ),
    check('attempts_trial_path_ck', isRelativePath(t.trialPath)),
  ],
);
