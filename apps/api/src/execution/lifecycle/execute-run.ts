/**
 * The execute-run handler (plan 8.1 to 8.4): one job, at most one attempt.
 *
 * 1. A cheap unlocked read skips a job that is plainly stale (the claim
 *    checks again under locks), before anything is reserved for it, and
 *    puts back a job of an experiment frozen on another Hermes revision than
 *    this worker runs, before a slot or readiness is spent on it.
 * 2. The provider guard's readiness is asked for here, outside any lock: it
 *    may call nous-login. A trial slot is taken here too (slots.ts), so a
 *    worker with no free slot puts the job back without spending an attempt.
 * 3. The claim transaction (claim.ts): stale, deferred, paused, or attempt n.
 * 4. The plan from the rows (plan.ts), and the MCP refusal check. Either
 *    failing ends the attempt as execution_error `setup` with no container.
 * 5. The runner, writing through the fenced sink, its signal aborted by the
 *    lease keeper on a lost lease, a cancel, or shutdown.
 * 6. The finish transaction (finish.ts), retried after a transient error
 *    for as long as the lease can still be renewed (leaseSeconds minus one
 *    heartbeat): the outcome lives only in memory, and a database restart
 *    of a few seconds must not throw it away.
 *
 * When the lease is lost, the worker is stopping, or the outcome cannot be
 * recorded, the handler writes nothing more and lets the job complete:
 * recovery owns the attempt from then on (plan 8.6), and ends it as
 * `worker_lost` once its lease has expired and its container is confirmed gone.
 */
import { z } from 'zod';
import { ATTEMPT_TRIGGERS, type PauseReason, type Provider } from '@hermes-evals/shared';
import { pgError } from '../../common/pg-error.js';
import type { AppDb } from '../../database/types.js';
import type { ProviderReadiness } from '../../providers/readiness.js';
import { executeRunKey, type ExecuteRunJob } from '../../queue/queues.js';
import { newAttemptToken } from '../../sandbox/egress-client.js';
import {
  LeaseLostError,
  WorkerShutdownError,
  type AttemptOutcome,
  type AttemptRunner,
} from '../contracts.js';
import type { SlotPool } from '../slots.js';
import { admissionDelay, claimRun, readClaimTarget, staleReason } from './claim.js';
import { finishAttempt, type FinishResult } from './finish.js';
import type { LeaseKeeper } from './leases.js';
import { buildAttemptPlan, PlanError, refusalOf } from './plan.js';
import { FencedAttemptSink } from './sink.js';
import type {
  ClaimedAttempt,
  LifecycleLogger,
  LifecycleQueue,
  LifecycleSettings,
} from './types.js';

/** Jobs carry ids only; a job that does not parse is stale and completes. */
export const ExecuteRunJobSchema = z.object({
  runId: z.string().min(1),
  attempt: z.number().int().min(1).max(5),
  trigger: z.enum(ATTEMPT_TRIGGERS),
}) satisfies z.ZodType<ExecuteRunJob>;

export interface ExecuteRunDeps {
  db: AppDb;
  queue: LifecycleQueue;
  runner: AttemptRunner;
  slots: SlotPool;
  leases: LeaseKeeper;
  /** The provider guard's answer (providers/readiness.ts). */
  readiness: (provider: Provider) => Promise<ProviderReadiness>;
  /** This process's workers row. */
  workerId: string;
  /** This worker's Docker daemon id (engine.info().ID). */
  hostId: string;
  /** The Hermes revision this worker's trial image runs; it claims only experiments frozen on it. */
  hermesRevision: string;
  /** TRIALS_DIR as the worker mounts it. */
  trialsDir: string;
  settings: LifecycleSettings;
  logger: LifecycleLogger;
  /** True once the worker is stopping: a job that arrives then is put back without a claim. */
  stopping?: () => boolean;
  newToken?: () => string;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Why a job was put back for later without an attempt. */
export type DeferReason =
  'admission' | 'hermes_revision' | 'no_slot' | 'readiness_unknown' | 'stopping';

/** Why the handler stopped writing to its attempt; recovery ends it. */
export type HandBackReason = 'lease_lost' | 'shutdown' | 'unrecorded';

/** The job's output: what this delivery did. */
export type ExecuteRunResult =
  | { outcome: 'stale'; reason: string }
  | { outcome: 'deferred'; reason: DeferReason; startAfterSeconds: number }
  | { outcome: 'paused'; reason: PauseReason; message: string }
  | ({ outcome: 'finished'; attemptId: string } & FinishResult)
  | { outcome: 'handed_back'; attemptId: string; reason: HandBackReason };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function handleExecuteRunJob(
  job: { id: string; data: unknown },
  deps: ExecuteRunDeps,
): Promise<ExecuteRunResult> {
  const parsed = ExecuteRunJobSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.logger.warn({ jobId: job.id }, 'execute-run job does not parse; completing it');
    return { outcome: 'stale', reason: 'the job does not parse' };
  }
  const data = parsed.data;
  const typed = { id: job.id, data };
  const log = { jobId: job.id, runId: data.runId, attempt: data.attempt, trigger: data.trigger };

  const target = await readClaimTarget(deps.db, data.runId);
  if (!target) return { outcome: 'stale', reason: 'the run does not exist' };
  const early = staleReason(target, data.attempt);
  if (early) return { outcome: 'stale', reason: early };
  if (deps.stopping?.()) return deferJob(typed, 'stopping', deps);
  if (target.hermesRevision !== deps.hermesRevision) {
    deps.logger.info(
      { ...log, frozen: target.hermesRevision, worker: deps.hermesRevision },
      'experiment frozen on another Hermes revision; leaving the run to a worker on it',
    );
    return deferJob(typed, 'hermes_revision', deps);
  }

  let readiness: ProviderReadiness;
  try {
    readiness = await deps.readiness(target.provider);
  } catch (err) {
    deps.logger.warn(
      { ...log, err: messageOf(err) },
      'provider readiness could not be checked; deferring',
    );
    return deferJob(typed, 'readiness_unknown', deps);
  }

  let slot: string | null;
  try {
    slot = await deps.slots.acquire();
  } catch (err) {
    deps.logger.warn(
      { ...log, err: messageOf(err) },
      'trial slots could not be checked; deferring',
    );
    return deferJob(typed, 'no_slot', deps);
  }
  if (!slot) return deferJob(typed, 'no_slot', deps);

  try {
    const claim = await deps.db.transaction((tx) =>
      claimRun(tx, {
        job: typed,
        workerId: deps.workerId,
        hostId: deps.hostId,
        hermesRevision: deps.hermesRevision,
        readiness,
        queue: deps.queue,
        settings: deps.settings,
        random: deps.random,
      }),
    );
    switch (claim.kind) {
      case 'stale':
        return { outcome: 'stale', reason: claim.reason };
      case 'deferred':
        return {
          outcome: 'deferred',
          reason: claim.reason,
          startAfterSeconds: claim.startAfterSeconds,
        };
      case 'paused':
        deps.logger.warn(
          { ...log, reason: claim.reason, message: claim.message },
          'experiment paused by a guard',
        );
        return { outcome: 'paused', reason: claim.reason, message: claim.message };
      case 'claimed':
        deps.logger.info({ ...log, attemptId: claim.attempt.attemptId, slot }, 'attempt claimed');
        return await runAttempt(claim.attempt, slot, deps);
    }
  } finally {
    // The runner returns only once its container is removed.
    deps.slots.release(slot);
  }
}

/** Completes the job and sends a delayed copy, without a claim. */
async function deferJob(
  job: { id: string; data: ExecuteRunJob },
  reason: DeferReason,
  deps: ExecuteRunDeps,
): Promise<ExecuteRunResult> {
  const startAfterSeconds = admissionDelay(
    deps.settings.admissionDelayS,
    deps.random ?? Math.random,
  );
  await deps.db.transaction((tx) =>
    deps.queue.defer(tx, job, {
      singletonKey: executeRunKey(job.data.runId, job.data.attempt),
      startAfterSeconds,
    }),
  );
  return { outcome: 'deferred', reason, startAfterSeconds };
}

/** Plans, runs and finishes a claimed attempt. Holds its lease throughout. */
async function runAttempt(
  claimed: ClaimedAttempt,
  slot: string,
  deps: ExecuteRunDeps,
): Promise<ExecuteRunResult> {
  const { attemptId } = claimed;
  const handBack = (reason: HandBackReason): ExecuteRunResult => ({
    outcome: 'handed_back',
    attemptId,
    reason,
  });
  const signal = deps.leases.hold(attemptId, claimed.leaseToken);
  try {
    const sink = new FencedAttemptSink(deps.db, { attemptId, leaseToken: claimed.leaseToken });
    let outcome: AttemptOutcome;
    const prepared = await prepare(claimed, slot, deps);
    if (prepared.kind === 'unplanned') {
      deps.logger.error(
        { attemptId, err: prepared.error },
        'attempt could not be planned; recovery will end it',
      );
      return handBack('unrecorded');
    }
    if (prepared.kind === 'refused') {
      outcome = setupOutcome(prepared.message);
    } else {
      try {
        outcome = await deps.runner.run(prepared.plan, sink, signal);
      } catch (err) {
        if (err instanceof LeaseLostError) return handBack('lease_lost');
        if (err instanceof WorkerShutdownError) return handBack('shutdown');
        deps.logger.error(
          { attemptId, err: messageOf(err) },
          'the runner could not record the attempt; recovery will end it',
        );
        return handBack('unrecorded');
      }
    }
    return await finish(claimed, sink.nextSeq, outcome, deps, handBack);
  } finally {
    deps.leases.release(attemptId);
  }
}

type Prepared =
  | { kind: 'planned'; plan: Awaited<ReturnType<typeof buildAttemptPlan>> }
  | { kind: 'refused'; message: string }
  | { kind: 'unplanned'; error: string };

async function prepare(
  claimed: ClaimedAttempt,
  slot: string,
  deps: ExecuteRunDeps,
): Promise<Prepared> {
  try {
    const plan = await buildAttemptPlan(deps.db, claimed, {
      slot,
      trialsDir: deps.trialsDir,
      token: (deps.newToken ?? newAttemptToken)(),
      hermesRevision: deps.hermesRevision,
    });
    const refusal = await refusalOf(deps.db, plan);
    return refusal ? { kind: 'refused', message: refusal } : { kind: 'planned', plan };
  } catch (err) {
    if (err instanceof PlanError) return { kind: 'refused', message: err.message };
    return { kind: 'unplanned', error: messageOf(err) };
  }
}

/** The outcome of an attempt that never reached a container (plan 8.4: `setup`). */
export function setupOutcome(message: string): AttemptOutcome {
  return {
    status: 'execution_error',
    category: 'setup',
    errorMessage: message,
    exitCode: null,
    finalText: null,
    sessionId: null,
    tokens: null,
    durationMs: 0,
    stderrTail: null,
    redactions: 0,
    finalEvents: [],
    artifacts: [],
    egressUsage: null,
  };
}

/**
 * What is still recordable of an outcome the database refused (a data or
 * integrity error, which trying again would only repeat): the attempt ends
 * as execution_error `other` saying why, without its final events and
 * artifacts. Tokens and duration are kept, so its cost still counts.
 */
export function degradedOutcome(outcome: AttemptOutcome, reason: string): AttemptOutcome {
  if (outcome.status === 'cancelled') {
    return { ...outcome, finalEvents: [], artifacts: [] };
  }
  return {
    ...outcome,
    status: 'execution_error',
    category: 'other',
    errorMessage: `The attempt's outcome could not be stored (${reason}); its events and files after the run are missing.`,
    finalEvents: [],
    artifacts: [],
  };
}

/** A Postgres data (22) or integrity (23) error: the same write would fail again. */
const isDataError = (err: unknown): boolean => /^2[23]/.test(pgError(err)?.code ?? '');

/**
 * How long the finish keeps trying after a transient error: while the lease
 * can still be renewed, which a database that is back renews at the next
 * heartbeat. A retry after a commit whose reply was lost is safe: the fenced
 * lock finds the attempt finished and answers LeaseLostError.
 */
export const finishRetryWindowMs = (
  settings: Pick<LifecycleSettings, 'leaseSeconds' | 'heartbeatIntervalMs' | 'finishRetryWindowMs'>,
): number =>
  settings.finishRetryWindowMs ??
  Math.max(0, settings.leaseSeconds * 1000 - settings.heartbeatIntervalMs);

/**
 * The finish transaction, tried again after a transient error while the
 * lease can still be held (finishRetryWindowMs), with capped backoff, and
 * once in a reduced form when the database refuses the outcome itself.
 */
async function finish(
  claimed: ClaimedAttempt,
  nextSeq: number,
  outcome: AttemptOutcome,
  deps: ExecuteRunDeps,
  handBack: (reason: HandBackReason) => ExecuteRunResult,
): Promise<ExecuteRunResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const delays = deps.settings.finishRetryDelaysMs;
  const giveUpAt = now() + finishRetryWindowMs(deps.settings);
  let current = outcome;
  let degraded = false;
  for (let tries = 0; ; tries += 1) {
    try {
      const result = await finishAttempt(deps.db, {
        claimed,
        nextSeq,
        outcome: current,
        queue: deps.queue,
        settings: deps.settings,
      });
      deps.logger.info(
        {
          attemptId: claimed.attemptId,
          runId: claimed.runId,
          attemptStatus: result.attemptStatus,
          runStatus: result.runStatus,
          retryAttempt: result.retryAttempt,
          experimentFailed: result.experimentFailed,
          reconciled: result.reconciled,
        },
        'attempt finished',
      );
      return { outcome: 'finished', attemptId: claimed.attemptId, ...result };
    } catch (err) {
      if (err instanceof LeaseLostError) {
        deps.logger.warn(
          { attemptId: claimed.attemptId },
          'lease lost before the finish; recovery will end the attempt',
        );
        return handBack('lease_lost');
      }
      const reason = pgError(err)?.message ?? messageOf(err);
      if (isDataError(err) && !degraded) {
        deps.logger.error(
          { attemptId: claimed.attemptId, err: reason },
          'the outcome was refused; recording what it can',
        );
        current = degradedOutcome(outcome, reason);
        degraded = true;
        continue;
      }
      // The last delay repeats until the window closes.
      const delay = delays[Math.min(tries, delays.length - 1)] ?? 1_000;
      if (now() + delay > giveUpAt) {
        deps.logger.error(
          { attemptId: claimed.attemptId, err: reason },
          'the attempt could not be finished; recovery will end it',
        );
        return handBack('unrecorded');
      }
      deps.logger.warn(
        { attemptId: claimed.attemptId, err: reason, retryInMs: delay },
        'finish failed; trying again',
      );
      await sleep(delay);
    }
  }
}
