/**
 * Shared types of the attempt lifecycle (plan 7.3, 7.4, 8.1, 8.4, 8.6): the
 * settings it runs with, the narrow queue and logger seams it writes
 * through, and the attempt a claim hands to the rest of the pipeline.
 */
import type { AttemptTrigger, Provider } from '@hermes-evals/shared';
import type { AppTx } from '../../database/types.js';
import type { ExecuteRunJob, QueueName } from '../../queue/queues.js';

/** Tunables, from the environment in production and shortened in tests. */
export interface LifecycleSettings {
  /** WORKER_CONCURRENCY: execute-run jobs this worker handles at once. */
  concurrency: number;
  /** LEASE_SECONDS: lifetime of a lease; renewed every heartbeat. */
  leaseSeconds: number;
  /** MAX_CONSECUTIVE_EXECUTION_ERRORS: the circuit breaker's threshold. */
  maxConsecutiveExecutionErrors: number;
  /** RECOVERY_INTERVAL_MS: time between recovery passes. */
  recoveryIntervalMs: number;
  /** TRIAL_RETENTION_DAYS: how long a finished attempt's trial directory is kept. */
  trialRetentionDays: number;
  /** Lease renewal period (plan 8.1: 10 s). */
  heartbeatIntervalMs: number;
  /** How often one query looks for cancel requests on this worker's attempts (1 to 2 s). */
  cancelPollIntervalMs: number;
  /** Admission deferral window: the job comes back after a random delay in [min, max] seconds. */
  admissionDelayS: { min: number; max: number };
  /** Delay before the automatic retry of a provider or timeout error (plan 8.4: 30 s). */
  autoRetryDelayS: number;
  /** pg-boss polling interval for execute-run, in seconds (at least 0.5). */
  pollingIntervalSeconds: number;
  /**
   * Waits before the finish transaction is tried again after an error that
   * is not a lost lease (a dropped connection, say); the last one repeats.
   * The outcome lives only in memory, so it is worth trying while the lease
   * can still be renewed.
   */
  finishRetryDelaysMs: readonly number[];
  /**
   * How long those tries go on, from the first finish. Unset: the lease's
   * lifetime less one heartbeat (execute-run.ts finishRetryWindowMs).
   */
  finishRetryWindowMs?: number;
  /** How long stop() waits for running attempts to hand back after it aborts them. */
  stopTimeoutMs: number;
}

export const DEFAULT_LIFECYCLE_SETTINGS: LifecycleSettings = {
  concurrency: 3,
  leaseSeconds: 60,
  maxConsecutiveExecutionErrors: 14,
  recoveryIntervalMs: 15_000,
  trialRetentionDays: 7,
  heartbeatIntervalMs: 10_000,
  cancelPollIntervalMs: 1_500,
  admissionDelayS: { min: 5, max: 15 },
  autoRetryDelayS: 30,
  pollingIntervalSeconds: 2,
  finishRetryDelaysMs: [1_000, 2_000, 4_000, 8_000],
  stopTimeoutMs: 60_000,
};

/** The logger calls the lifecycle makes; PinoLogger satisfies it. Objects carry ids and names, never values. */
export interface LifecycleLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * The job operations the lifecycle performs inside its own transactions, so
 * a job commits or rolls back with the rows that need it (plan 7.1). The
 * production implementation is pg-boss through fromDrizzle (queue.ts); the
 * PGlite tests, which have no pg-boss schema, record the calls instead.
 */
export interface LifecycleQueue {
  /**
   * Completes the active job and sends a delayed copy under the same key,
   * in `tx` (deferJob). Throws if another live job holds the key.
   */
  defer(
    tx: AppTx,
    job: { id: string; data: ExecuteRunJob },
    options: { singletonKey: string; startAfterSeconds: number },
  ): Promise<void>;
  /**
   * Sends a job in `tx`. Resolves the job id, or null when a live job
   * already holds the singleton key (exclusive policy): that job does the work.
   */
  send(
    tx: AppTx,
    queue: QueueName,
    data: object,
    options: { singletonKey: string; startAfterSeconds?: number },
  ): Promise<string | null>;
  /**
   * Sends many jobs in `tx` in one statement; a key that already has a live
   * job is skipped. Resolves how many were created.
   */
  sendMany(
    tx: AppTx,
    queue: QueueName,
    jobs: ReadonlyArray<{ data: object; singletonKey: string }>,
  ): Promise<number>;
}

/** The attempt a claim inserted, with what the rest of the pipeline needs to address it. */
export interface ClaimedAttempt {
  attemptId: string;
  /** attempts.lease_token: every later write is fenced on it. */
  leaseToken: string;
  attemptNumber: number;
  trigger: AttemptTrigger;
  runId: string;
  experimentId: string;
  taskId: string;
  configurationVersionId: string;
  provider: Provider;
  model: string;
  /** The workers row that owns the attempt. */
  workerId: string;
}

/**
 * The abort reason the lifecycle's cancel watcher passes when Cancel set
 * runs.cancel_requested_at on a running attempt. The runner treats an abort
 * whose reason is neither LeaseLostError nor WorkerShutdownError as a cancel:
 * it stops the container and returns status `cancelled`.
 */
export class CancelRequestedError extends Error {
  override readonly name = 'CancelRequestedError';
  readonly reason = 'cancel' as const;

  constructor(readonly attemptId: string) {
    super(`cancel was requested for the run of attempt ${attemptId}`);
  }
}
