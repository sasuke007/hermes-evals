/**
 * Status vocabularies. The strings are the exact values stored in the database
 * and shown in the UI; the UI never uses synonyms for them. The database
 * enforces each list with a CHECK constraint generated from these arrays, so a
 * value added here needs a new migration (`pnpm db:generate`).
 */

/** Lifecycle of one cell of the run matrix (task x configuration version x repetition). */
export const RUN_STATUSES = [
  'queued',
  'running',
  'executed',
  'scoring',
  'scored',
  'execution_error',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Outcome of one launch of Hermes for a run. A subset of the run statuses. */
export const ATTEMPT_STATUSES = [
  'running',
  'executed',
  'execution_error',
  'cancelled',
] as const satisfies readonly RunStatus[];
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

/** What created an attempt. Attempt 1 is always `initial`. */
export const ATTEMPT_TRIGGERS = [
  'initial',
  'auto_retry',
  'user_retry',
  'recovery',
  'retry_failed',
] as const;
export type AttemptTrigger = (typeof ATTEMPT_TRIGGERS)[number];

/**
 * Why an attempt ended in `execution_error`. A cancelled attempt has status
 * `cancelled` and no category. `worker_lost` is set by recovery when the worker
 * running the attempt stopped heartbeating; `limit` when the model gateway's
 * per-attempt token cap (MODEL_TOKEN_CAP_PER_ATTEMPT) stopped the run, which
 * is never retried automatically since the same task would reach the cap
 * again; `other` is the catch-all.
 */
export const EXECUTION_ERROR_CATEGORIES = [
  'provider',
  'timeout',
  'setup',
  'worker_lost',
  'limit',
  'other',
] as const;
export type ExecutionErrorCategory = (typeof EXECUTION_ERROR_CATEGORIES)[number];

/** Result of one scorer key on one run. Only `passed` counts as a pass. */
export const SCORE_STATUSES = ['passed', 'failed', 'error', 'ungradable'] as const;
export type ScoreStatus = (typeof SCORE_STATUSES)[number];

/** One grading pass over an attempt. Re-scoring creates a new evaluation. */
export const EVALUATION_STATUSES = ['queued', 'running', 'completed', 'failed'] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

export const EVALUATION_CAUSES = ['initial', 'rescore'] as const;
export type EvaluationCause = (typeof EVALUATION_CAUSES)[number];

/** There is no draft status: an experiment exists only once launched. */
export const EXPERIMENT_STATUSES = ['running', 'paused', 'completed', 'failed'] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/**
 * Why an experiment is paused. `user`: Pause was clicked. `spend_ceiling`: the
 * spend guard found priced spend at or above the ceiling before a claim.
 * `provider_disconnected`: the provider guard found a configuration's provider
 * not ready before a claim (plan 7.3, UI_FLOWS 19 #5); no attempt was spent,
 * and Resume needs the provider ready again.
 */
export const PAUSE_REASONS = ['user', 'spend_ceiling', 'provider_disconnected'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const VERDICTS = ['better', 'worse', 'inconclusive'] as const;
export type Verdict = (typeof VERDICTS)[number];

/**
 * Why a verdict was (re)computed and appended to the experiment's history:
 * `initial` the first completion, `retry` a completion after Retry failed
 * runs or a user retry reopened it, `rescore` a re-score that moved the
 * results of a completed experiment.
 */
export const VERDICT_CAUSES = ['initial', 'retry', 'rescore'] as const;
export type VerdictCause = (typeof VERDICT_CAUSES)[number];

/**
 * Why the statistics, and so the verdict, are not computable (plan 10.2's
 * gate: every selected task needs at least 2 counted runs per
 * configuration). `single_repetition`: the experiment runs each task once.
 * `nothing_scored`: no run of the two configurations counts yet.
 * `not_enough_runs`: some task has fewer than 2 counted runs on one side.
 */
export const NOT_COMPUTABLE_REASONS = [
  'single_repetition',
  'not_enough_runs',
  'nothing_scored',
] as const;
export type NotComputableReason = (typeof NOT_COMPUTABLE_REASONS)[number];
