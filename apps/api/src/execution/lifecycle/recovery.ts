/**
 * Recovery (plan 8.6): what keeps runs moving when a worker, a job or a
 * container is lost. Every worker runs a pass at boot and every
 * RECOVERY_INTERVAL_MS, one pass at a time across workers (recovery-lock.ts):
 *
 * 1. Revoke the leases of running attempts whose lease expired, whose worker
 *    stopped or went silent, or that ran past their deadline plus 120 s.
 * 2. For each revoked attempt on THIS Docker daemon, stop and remove every
 *    container of its run and list again until none is left (clearRun). An
 *    attempt on another daemon stays revoked until a worker there confirms
 *    it: a missing heartbeat never proves a trial stopped.
 * 3. Finalise each confirmed attempt (finalise-lost.ts): worker_lost or
 *    cancelled, requeued while it has attempts left, then reconcile. Before
 *    that it is removed from this worker's egress, so its token dies; its
 *    home is deleted after, as a normal finish deletes it (recovery-disk.ts).
 * 4. Sweep trial containers on this daemon whose attempt is no longer
 *    running or was revoked, and those of no attempt (probes, MCP tests)
 *    whose deadline label has passed. A container whose attempt is running
 *    under a lease nobody revoked is its owner's to stop: the label alone
 *    never removes it (step 1 revokes a lease that ran too long).
 * 5. Re-send execute-run for every queued run of a running experiment, and
 *    evaluate-run for every queued evaluation or one whose claim expired.
 *    The exclusive keys make both no-ops where the job still exists. The
 *    trigger is the one the run recorded when it was queued (next_trigger).
 * 6. Delete trial directories of attempts finished more than
 *    TRIAL_RETENTION_DAYS ago (at most every 10 minutes), each on its own.
 *
 * Then, as the safety net plan 7.4 asks for, reconcile every running or
 * paused experiment that has nothing left in flight.
 *
 * Each step is guarded on its own: an engine that cannot be reached skips
 * steps 2 and 4 and nothing else. Every step is also safe to repeat, since
 * it is guarded in the rows it changes, so the lock saves work rather than
 * carrying correctness.
 */
import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { attempts, evaluations, experiments, runs } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { evaluateRunKey } from '../../evaluation/job.js';
import { queuedRunTrigger } from '../../experiments/commands/jobs.js';
import { reconcileExperiment } from '../../experiments/reconcile.js';
import {
  EXECUTE_RUN_EXPIRE_SECONDS,
  executeRunKey,
  MAX_RUN_BUDGET_SECONDS,
  QUEUES,
  type EvaluateRunJob,
  type ExecuteRunJob,
} from '../../queue/queues.js';
import type { EgressClient } from '../../sandbox/egress-client.js';
import type { EngineClient } from '../../sandbox/engine-client.js';
import { clearRun } from '../../sandbox/trial-runner.js';
import { finaliseLostAttempt, type FinalisedAttempt } from './finalise-lost.js';
import { rowsOf } from './fence.js';
import { deleteLostHome, removeExpiredTrialDirs } from './recovery-disk.js';
import type { RecoveryLock } from './recovery-lock.js';
import type { LifecycleLogger, LifecycleQueue, LifecycleSettings } from './types.js';

/**
 * Seconds after start, beyond the run budget, before an attempt counts as
 * past its deadline: the budget's grace and stop timeout, trial build and
 * artifact collection (what EXECUTE_RUN_EXPIRE_SECONDS allows beyond the
 * longest budget), plus the 120 s plan 8.6 adds.
 */
export const DEADLINE_ALLOWANCE_S = EXECUTE_RUN_EXPIRE_SECONDS - MAX_RUN_BUDGET_SECONDS + 120;

/** A worker whose heartbeat is this old has lost its attempts (schema/workers.ts). */
export const SILENT_WORKER_S = 120;

export { RETENTION_INTERVAL_MS } from './recovery-disk.js';

/** Rows per statement when a step works through a long list. */
const CHUNK = 500;

export interface RecoveryDeps {
  db: AppDb;
  queue: LifecycleQueue;
  /** This worker's guard-backed engine; null when it has none (sandbox unavailable). */
  engine: EngineClient | null;
  /** This worker's Docker daemon id; null when it is not known. Steps 2 and 4 need both. */
  hostId: string | null;
  trialsDir: string;
  lock: RecoveryLock;
  settings: Pick<LifecycleSettings, 'trialRetentionDays'>;
  logger: LifecycleLogger;
  /** Called for each attempt revoked on this daemon before its containers are stopped (LeaseKeeper.revoked). */
  onRevoked?: (attemptId: string) => void;
  /**
   * This worker's egress (SandboxService.egress). A lost attempt's runner never
   * removed it, so once its container is confirmed gone recovery does: the
   * token dies now rather than at its expiry, and egress forgets it.
   */
  egress?: Pick<EgressClient, 'remove'> | null;
  /** How long clearRun may take per run. */
  clearTimeoutMs?: number;
  /** When retention last ran here; recovery updates it. */
  retention?: { lastRunAt: number };
  now?: () => number;
  /** Deletes one attempt's trial directory in retention; removeTrialDirs unless a test supplies one. */
  removeTrialDir?: (trialsDir: string, attemptId: string) => Promise<void>;
}

export interface RecoveryReport {
  /** Attempts whose lease this pass revoked. */
  revoked: string[];
  finalised: FinalisedAttempt[];
  /** Revoked attempts on this daemon whose containers could not be confirmed gone. */
  unconfirmed: string[];
  /** Containers removed by the sweep. */
  swept: number;
  /** Jobs created by step 5; zero when every job was still there. */
  resentRuns: number;
  resentEvaluations: number;
  /** Experiments the safety net completed. */
  completed: string[];
  /** Trial directories deleted by retention. */
  removedTrialDirs: number;
}

/** One recovery pass, or null when another worker's pass holds the lock. */
export async function recoveryPass(deps: RecoveryDeps): Promise<RecoveryReport | null> {
  const locked = await deps.lock.tryRun(() => runPass(deps));
  return locked.ran ? locked.value : null;
}

async function runPass(deps: RecoveryDeps): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    revoked: [],
    finalised: [],
    unconfirmed: [],
    swept: 0,
    resentRuns: 0,
    resentEvaluations: 0,
    completed: [],
    removedTrialDirs: 0,
  };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      deps.logger.warn(
        { step: name, err: (err as Error).message },
        'recovery step failed; retrying on the next pass',
      );
    }
  };
  await step('revoke', async () => {
    report.revoked = await revokeLeases(deps.db);
  });
  await step('confirm and finalise', () => confirmAndFinalise(deps, report));
  await step('sweep', async () => {
    report.swept = await sweepContainers(deps);
  });
  await step('resend runs', async () => {
    report.resentRuns = await resendQueuedRuns(deps);
  });
  await step('resend evaluations', async () => {
    report.resentEvaluations = await resendEvaluations(deps);
  });
  await step('reconcile', async () => {
    report.completed = await reconcileDrained(deps.db);
  });
  await step('retention', async () => {
    report.removedTrialDirs = await removeExpiredTrialDirs(deps);
  });
  if (
    report.revoked.length +
      report.finalised.length +
      report.unconfirmed.length +
      report.swept +
      report.resentRuns +
      report.resentEvaluations +
      report.completed.length +
      report.removedTrialDirs >
    0
  ) {
    deps.logger.info(
      {
        revoked: report.revoked.length,
        finalised: report.finalised.length,
        unconfirmed: report.unconfirmed.length,
        swept: report.swept,
        resentRuns: report.resentRuns,
        resentEvaluations: report.resentEvaluations,
        completed: report.completed.length,
        removedTrialDirs: report.removedTrialDirs,
      },
      'recovery pass',
    );
  }
  return report;
}

/**
 * Step 1, in one statement. SKIP LOCKED leaves alone an attempt whose
 * finish or renewal holds its row: that worker is alive, and the next pass
 * sees the result. Revoking touches only lease_revoked_at, which
 * attempts_guard allows on a running attempt.
 */
export async function revokeLeases(db: AppDb): Promise<string[]> {
  const result = await db.execute(sql`update attempts set lease_revoked_at = now()
    where id in (
      select a.id from attempts a
        join workers w on w.id = a.worker_id
        join runs r on r.id = a.run_id
        join experiments e on e.id = r.experiment_id
        join configuration_versions cv on cv.id = r.configuration_version_id
       where a.status = 'running' and a.lease_revoked_at is null
         and (a.lease_expires_at < now()
              or w.stopped_at is not null
              or w.last_heartbeat_at < now() - make_interval(secs => ${SILENT_WORKER_S})
              or a.started_at + make_interval(secs => coalesce(e.time_budget_override_s,
                   cv.time_budget_s) + ${DEADLINE_ALLOWANCE_S}) < now())
       order by a.id
       for update of a skip locked)
    returning id`);
  return rowsOf<{ id: string }>(result).map((row) => row.id);
}

/** Steps 2 and 3: every revoked running attempt this daemon can vouch for. */
async function confirmAndFinalise(deps: RecoveryDeps, report: RecoveryReport): Promise<void> {
  const mine =
    deps.hostId === null
      ? isNull(attempts.sandboxHostId)
      : or(eq(attempts.sandboxHostId, deps.hostId), isNull(attempts.sandboxHostId));
  const revoked = await deps.db
    .select({ id: attempts.id, runId: attempts.runId, sandboxHostId: attempts.sandboxHostId })
    .from(attempts)
    .where(and(eq(attempts.status, 'running'), isNotNull(attempts.leaseRevokedAt), mine))
    .orderBy(attempts.id);
  for (const attempt of revoked) {
    // No daemon was ever recorded, so no container of it can exist.
    if (attempt.sandboxHostId !== null) {
      deps.onRevoked?.(attempt.id);
      if (!deps.engine) {
        report.unconfirmed.push(attempt.id);
        continue;
      }
      try {
        await clearRun(deps.engine, attempt.runId, deps.clearTimeoutMs);
      } catch (err) {
        report.unconfirmed.push(attempt.id);
        deps.logger.warn(
          { attemptId: attempt.id, err: (err as Error).message },
          'could not confirm the trial container is gone',
        );
        continue;
      }
    }
    await removeLostRegistration(deps, attempt.id);
    try {
      const finalised = await finaliseLostAttempt(deps.db, attempt.id, deps.queue);
      // Its containers are confirmed gone (or none ever existed): nothing changes under rm.
      await deleteLostHome(deps.trialsDir, attempt.id, deps.logger);
      if (finalised) {
        report.finalised.push(finalised);
        deps.logger.warn(
          {
            attemptId: finalised.attemptId,
            runId: finalised.runId,
            attemptStatus: finalised.attemptStatus,
            runStatus: finalised.runStatus,
            requeuedAttempt: finalised.requeuedAttempt,
          },
          'recovered a lost attempt',
        );
      }
    } catch (err) {
      deps.logger.warn(
        { attemptId: attempt.id, err: (err as Error).message },
        'could not finalise a lost attempt',
      );
    }
  }
}

/** Removes a lost attempt from egress; a failure only leaves it to expire there. Never throws. */
async function removeLostRegistration(deps: RecoveryDeps, attemptId: string): Promise<void> {
  if (!deps.egress) return;
  try {
    await deps.egress.remove(attemptId);
  } catch (err) {
    deps.logger.warn(
      { attemptId, err: (err as Error).message },
      'could not remove a lost attempt from egress; its registration expires on its own',
    );
  }
}

/**
 * Step 4. A container whose attempt finished or was revoked goes. One of no
 * attempt row (probes, MCP tests) goes once its deadline label has passed.
 * One whose attempt is running under a lease nobody revoked stays, whatever
 * its label says: its owner is stopping it, maybe in the stop grace right
 * now, and removing it under the owner would turn a timeout into an engine
 * failure. Its lease is revoked (step 1) if it runs on too long.
 */
async function sweepContainers(deps: RecoveryDeps): Promise<number> {
  if (!deps.engine || deps.hostId === null) return 0;
  const engine = deps.engine;
  const containers = await engine.list(['hermes-evals.role=trial']);
  if (containers.length === 0) return 0;
  const attemptIds = [
    ...new Set(
      containers
        .map((c) => c.Labels['hermes-evals.attempt'])
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const rowsById = new Map<string, { status: string; revoked: boolean }>();
  for (let i = 0; i < attemptIds.length; i += CHUNK) {
    const rows = await deps.db
      .select({ id: attempts.id, status: attempts.status, revokedAt: attempts.leaseRevokedAt })
      .from(attempts)
      .where(inArray(attempts.id, attemptIds.slice(i, i + CHUNK)));
    for (const row of rows) {
      rowsById.set(row.id, { status: row.status, revoked: row.revokedAt !== null });
    }
  }
  const nowS = (deps.now ?? Date.now)() / 1000;
  let swept = 0;
  for (const container of containers) {
    const attemptId = container.Labels['hermes-evals.attempt'];
    const row = attemptId === undefined ? undefined : rowsById.get(attemptId);
    const deadline = Number(container.Labels['hermes-evals.deadline']);
    const finished = row !== undefined && (row.status !== 'running' || row.revoked);
    const owned = row !== undefined && row.status === 'running' && !row.revoked;
    const overdue = !owned && Number.isFinite(deadline) && deadline > 0 && deadline < nowS;
    if (!finished && !overdue) continue;
    await engine.kill(container.Id);
    await engine.remove(container.Id);
    swept += 1;
    deps.logger.warn(
      { containerId: container.Id, attemptId, finished, overdue },
      'removed a stray trial container',
    );
  }
  return swept;
}

/** Step 5a: a job for every queued run of a running experiment. */
async function resendQueuedRuns(deps: RecoveryDeps): Promise<number> {
  const rows = await deps.db
    .select({
      runId: runs.id,
      attemptCount: runs.attemptCount,
      nextTrigger: runs.nextTrigger,
      lastNumber: attempts.number,
      lastCategory: attempts.errorCategory,
    })
    .from(runs)
    .innerJoin(experiments, eq(experiments.id, runs.experimentId))
    .leftJoin(attempts, eq(attempts.id, runs.currentAttemptId))
    .where(
      and(
        eq(runs.status, 'queued'),
        eq(experiments.status, 'running'),
        isNull(experiments.cancelledAt),
      ),
    )
    .orderBy(runs.id);
  const jobs = rows.map((row) => {
    const data: ExecuteRunJob = {
      runId: row.runId,
      attempt: row.attemptCount + 1,
      // Rows queued before migration 0005 have no recorded trigger; guess from the last attempt.
      trigger:
        row.nextTrigger ??
        queuedRunTrigger(
          row.lastNumber === null
            ? null
            : { number: row.lastNumber, errorCategory: row.lastCategory },
        ),
    };
    return { data, singletonKey: executeRunKey(data.runId, data.attempt) };
  });
  return sendChunked(deps, QUEUES.executeRun, jobs);
}

/** Step 5b: a job for every queued evaluation and every one whose claim expired. */
async function resendEvaluations(deps: RecoveryDeps): Promise<number> {
  const rows = await deps.db
    .select({ id: evaluations.id })
    .from(evaluations)
    .where(
      or(
        eq(evaluations.status, 'queued'),
        and(eq(evaluations.status, 'running'), lt(evaluations.claimExpiresAt, sql`now()`)),
      ),
    )
    .orderBy(evaluations.id);
  const jobs = rows.map((row) => {
    const data: EvaluateRunJob = { evaluationId: row.id };
    return { data, singletonKey: evaluateRunKey(row.id) };
  });
  return sendChunked(deps, QUEUES.evaluateRun, jobs);
}

async function sendChunked(
  deps: RecoveryDeps,
  queue: typeof QUEUES.executeRun | typeof QUEUES.evaluateRun,
  jobs: ReadonlyArray<{ data: object; singletonKey: string }>,
): Promise<number> {
  let created = 0;
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const chunk = jobs.slice(i, i + CHUNK);
    created += await deps.db.transaction((tx) => deps.queue.sendMany(tx, queue, chunk));
  }
  return created;
}

/** The safety net: reconcile every running or paused experiment with nothing in flight. */
async function reconcileDrained(db: AppDb): Promise<string[]> {
  const drained = await db.execute(sql`select e.id from experiments e
    where e.status in ('running', 'paused')
      and not exists (select 1 from runs r where r.experiment_id = e.id
                        and r.status in ('queued', 'running', 'executed', 'scoring'))
      and not exists (select 1 from evaluations v join runs r on r.id = v.run_id
                       where r.experiment_id = e.id and v.status in ('queued', 'running'))
    order by e.id`);
  const completed: string[] = [];
  for (const { id } of rowsOf<{ id: string }>(drained)) {
    if ((await db.transaction((tx) => reconcileExperiment(tx, id))) === 'completed')
      completed.push(id);
  }
  return completed;
}
