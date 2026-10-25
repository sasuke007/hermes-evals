/**
 * Starting and stopping the execution lifecycle in a worker: the execute-run
 * handler, the lease keeper's heartbeat and cancel watcher, and the recovery
 * loop. WorkerService calls startExecutionLifecycle once presence has its
 * workers row, and stop() on shutdown before presence marks the row stopped.
 *
 * Start order: the lease keeper, then one recovery pass (so what an earlier
 * process of this worker left on the slots is stopped and finalised before
 * new trials start), then the handler, then the recovery timer.
 *
 * Stop order: no new jobs are taken, every running attempt is aborted with
 * WorkerShutdownError (its runner stops the container and hands back), the
 * handlers are waited for up to stopTimeoutMs, then the loops stop. The
 * attempts handed back stay `running`; once presence marks the worker
 * stopped, recovery ends them as worker_lost and requeues their runs.
 *
 * A worker without proven isolation passes runner null: it consumes no
 * execute-run job, but still runs recovery, which is mostly database work.
 */
import type { PgBoss } from 'pg-boss';
import type { Provider } from '@hermes-evals/shared';
import type { Env } from '../../config/env.js';
import type { AppDb } from '../../database/types.js';
import type { ProviderReadiness } from '../../providers/readiness.js';
import { QUEUES } from '../../queue/queues.js';
import type { EgressClient } from '../../sandbox/egress-client.js';
import type { EngineClient } from '../../sandbox/engine-client.js';
import type { AttemptRunner } from '../contracts.js';
import { SlotPool } from '../slots.js';
import { handleExecuteRunJob, type ExecuteRunResult } from './execute-run.js';
import { LeaseKeeper } from './leases.js';
import { pgBossLifecycleQueue } from './queue.js';
import { recoveryPass, type RecoveryReport } from './recovery.js';
import type { RecoveryLock } from './recovery-lock.js';
import {
  DEFAULT_LIFECYCLE_SETTINGS,
  type LifecycleLogger,
  type LifecycleQueue,
  type LifecycleSettings,
} from './types.js';

export interface ExecutionLifecycleDeps {
  boss: PgBoss;
  db: AppDb;
  /** TrialAttemptRunner; null on a worker that must not execute (isolation not proven). */
  runner: AttemptRunner | null;
  /** SandboxService.engine; null when docker-guard cannot be reached. */
  engine: EngineClient | null;
  /** SandboxService.egress: recovery removes the attempts it finalises as lost from it. */
  egress?: Pick<EgressClient, 'remove'> | null;
  /** The provider guard (providers/readiness.ts providerReadiness, bound to its deps). */
  readiness: (provider: Provider) => Promise<ProviderReadiness>;
  /** WorkerPresenceService.id after start(). */
  workerId: string;
  /** engine.info().ID; null when it could not be read. */
  hostId: string | null;
  /** The Hermes revision this worker's trial image runs (HERMES_REVISION, which presence checked the image against). */
  hermesRevision: string;
  /** TRIALS_DIR. */
  trialsDir: string;
  /** TRIAL_SLOTS, split (SandboxService.slots). */
  trialSlots: readonly string[];
  /** poolRecoveryLock(the node-postgres pool) in production. */
  recoveryLock: RecoveryLock;
  logger: LifecycleLogger;
  settings?: Partial<LifecycleSettings>;
  /** Defaults to pg-boss through fromDrizzle. */
  queue?: LifecycleQueue;
}

export interface ExecutionLifecycle {
  /** The execute-run handler's pg-boss worker id, or null when execution is off. */
  readonly workId: string | null;
  readonly leases: LeaseKeeper;
  /** Null when execution is off. */
  readonly slots: SlotPool | null;
  /** One recovery pass now, as the timer runs it; null when another pass holds the lock. */
  recoverNow(): Promise<RecoveryReport | null>;
  /** Stops taking jobs, hands back running attempts, waits for them, stops the loops. Idempotent. */
  stop(): Promise<void>;
}

/** The lifecycle settings the environment controls; the rest keep their defaults. */
export function lifecycleSettingsFromEnv(
  env: Pick<
    Env,
    | 'WORKER_CONCURRENCY'
    | 'LEASE_SECONDS'
    | 'MAX_CONSECUTIVE_EXECUTION_ERRORS'
    | 'RECOVERY_INTERVAL_MS'
    | 'TRIAL_RETENTION_DAYS'
  >,
): Partial<LifecycleSettings> {
  return {
    concurrency: env.WORKER_CONCURRENCY,
    leaseSeconds: env.LEASE_SECONDS,
    maxConsecutiveExecutionErrors: env.MAX_CONSECUTIVE_EXECUTION_ERRORS,
    recoveryIntervalMs: env.RECOVERY_INTERVAL_MS,
    trialRetentionDays: env.TRIAL_RETENTION_DAYS,
  };
}

export async function startExecutionLifecycle(
  deps: ExecutionLifecycleDeps,
): Promise<ExecutionLifecycle> {
  const settings: LifecycleSettings = { ...DEFAULT_LIFECYCLE_SETTINGS, ...deps.settings };
  const queue = deps.queue ?? pgBossLifecycleQueue(deps.boss);
  const { db, logger } = deps;
  const executes = deps.runner !== null && deps.engine !== null && deps.hostId !== null;
  if (executes && settings.concurrency > deps.trialSlots.length) {
    // Each trial needs a slot to itself; jobs beyond the slots would only be deferred.
    logger.warn(
      { concurrency: settings.concurrency, slots: deps.trialSlots.length },
      'WORKER_CONCURRENCY is above the number of TRIAL_SLOTS; the extra jobs wait for a slot',
    );
  }

  const leases = new LeaseKeeper(db, deps.workerId, settings, logger);
  leases.start();

  const retention = { lastRunAt: 0 };
  let recovering: Promise<RecoveryReport | null> | null = null;
  const recoverNow = (): Promise<RecoveryReport | null> => {
    if (recovering) return recovering;
    const pass = recoveryPass({
      db,
      queue,
      engine: deps.engine,
      egress: deps.egress ?? null,
      hostId: deps.hostId,
      trialsDir: deps.trialsDir,
      lock: deps.recoveryLock,
      settings,
      logger,
      onRevoked: (attemptId) => {
        if (leases.revoked(attemptId))
          logger.warn({ attemptId }, 'recovery revoked a lease this worker held');
      },
      retention,
    })
      .catch((err: unknown) => {
        logger.warn(
          { err: (err as Error).message },
          'recovery pass failed; retrying on the next one',
        );
        return null;
      })
      .finally(() => {
        if (recovering === pass) recovering = null;
      });
    recovering = pass;
    return pass;
  };
  await recoverNow();

  let stopping = false;
  const inFlight = new Set<Promise<ExecuteRunResult>>();
  let slots: SlotPool | null = null;
  let workId: string | null = null;
  if (executes) {
    const pool = new SlotPool(deps.trialSlots, deps.engine!);
    slots = pool;
    const options = {
      batchSize: 1,
      localConcurrency: settings.concurrency,
      pollingIntervalSeconds: settings.pollingIntervalSeconds,
    } as const;
    workId = await deps.boss.work<unknown, ExecuteRunResult | null, typeof options>(
      QUEUES.executeRun,
      options,
      async ([job]) => {
        if (!job) return null;
        const handled = handleExecuteRunJob(job, {
          db,
          queue,
          runner: deps.runner!,
          slots: pool,
          leases,
          readiness: deps.readiness,
          workerId: deps.workerId,
          hostId: deps.hostId!,
          hermesRevision: deps.hermesRevision,
          trialsDir: deps.trialsDir,
          settings,
          logger,
          stopping: () => stopping,
        });
        inFlight.add(handled);
        try {
          return await handled;
        } finally {
          inFlight.delete(handled);
        }
      },
    );
  } else {
    logger.warn(
      { runner: deps.runner !== null, engine: deps.engine !== null, hostId: deps.hostId },
      'execution is off on this worker; recovery only',
    );
  }

  const timer = setInterval(() => void recoverNow(), settings.recoveryIntervalMs);
  timer.unref();

  let stopped: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      stopping = true;
      clearInterval(timer);
      // Stop fetching first, so nothing new is claimed while attempts hand back.
      const offWork = workId
        ? deps.boss.offWork(QUEUES.executeRun, { id: workId, wait: true })
        : Promise.resolve();
      leases.shutdown();
      let waited: NodeJS.Timeout | undefined;
      const outcome = await Promise.race([
        Promise.allSettled([offWork, ...inFlight]).then(() => 'drained' as const),
        new Promise<'timeout'>((resolve) => {
          waited = setTimeout(() => resolve('timeout'), settings.stopTimeoutMs);
        }),
      ]);
      clearTimeout(waited);
      if (outcome === 'timeout') {
        logger.warn({ running: inFlight.size }, 'stopped waiting for attempts to hand back');
      }
      await leases.stop();
      await recovering;
    })();
    return stopped;
  };

  return {
    workId,
    leases,
    slots,
    recoverNow,
    stop,
  };
}
