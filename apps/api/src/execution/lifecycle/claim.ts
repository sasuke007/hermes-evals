/**
 * The claim transaction (plan 8.1, UI_FLOWS 12.1). An execute-run job is a
 * wake-up token for one attempt of one run; the rows decide what it does.
 * In this order, under the documented lock order (experiment, then run):
 *
 * 1. Lock the experiment. Paused, failed, completed or cancelled: the job is
 *    stale, complete it (resume and retry-failed re-send).
 * 2. Lock the run. Unless it is queued with attempt_count = attempt - 1, the
 *    job is stale or a duplicate: complete it.
 * 3. Hermes revision: a worker whose trial image is not the revision the
 *    experiment froze (plan invariant 4) defers the job like admission and
 *    spends nothing, so a worker on that revision takes the run. Resume and
 *    Retry refuse while no connected worker runs it (controls).
 * 4. Admission: at or above the experiment's concurrency in running runs,
 *    defer the job 5 to 15 s (jittered) and stop. This count under the
 *    experiment lock is what makes the limit hold across workers.
 * 5. Spend guard: attempt costs at or above the ceiling pause the experiment
 *    (spend_ceiling). An attempt of a priced model whose trial ran but whose
 *    cost is unknown (its worker or egress lost the usage) counts at the
 *    mean cost of the experiment's priced attempts, never as zero. Attempts
 *    of an unpriced model add nothing here; they are counted and shown
 *    elsewhere.
 * 6. Provider guard: a provider that is not ready pauses the experiment
 *    (provider_disconnected) and spends no attempt. Readiness is asked for
 *    before this transaction (it may call nous-login), so no network call
 *    happens under the experiment lock.
 * 7. Insert attempt n with a fresh lease, move the run to running with the
 *    pointer (its next_trigger is used up), and count the trial in
 *    workers.in_flight.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ExecuteRunJob } from '../../queue/queues.js';
import { executeRunKey } from '../../queue/queues.js';
import type { PauseReason, Provider } from '@hermes-evals/shared';
import {
  attempts,
  configurationVersions,
  experiments,
  runs,
  workers,
} from '../../database/schema/index.js';
import { newId } from '../../database/ids.js';
import type { AppDb, AppTx } from '../../database/types.js';
import type { ProviderReadiness } from '../../providers/readiness.js';
import { rowsOf } from './fence.js';
import type { ClaimedAttempt, LifecycleQueue, LifecycleSettings } from './types.js';

/** What a job's run looks like before any lock: enough to skip stale jobs early and ask for readiness. */
export interface ClaimTarget {
  experimentId: string;
  experimentStatus: string;
  cancelled: boolean;
  runStatus: string;
  attemptCount: number;
  provider: Provider;
  model: string;
  /** The Hermes revision the experiment froze; only a worker running it may claim. */
  hermesRevision: string;
}

/** Why a claim put its job back for later. */
export type ClaimDeferReason = 'admission' | 'hermes_revision';

export type ClaimOutcome =
  /** Nothing to do: the job completes. */
  | { kind: 'stale'; reason: string }
  /** The job was completed and a delayed copy sent. */
  | { kind: 'deferred'; reason: ClaimDeferReason; startAfterSeconds: number }
  /** The experiment was paused by a guard; the job completes and resume re-sends it. */
  | { kind: 'paused'; reason: PauseReason; message: string }
  | { kind: 'claimed'; attempt: ClaimedAttempt };

export interface ClaimInput {
  job: { id: string; data: ExecuteRunJob };
  workerId: string;
  /** This worker's Docker daemon id, written as sandbox_host_id so recovery knows who can confirm the trial stopped. */
  hostId: string;
  /** The Hermes revision this worker's trials run (its build's, which its trial image matches). */
  hermesRevision: string;
  readiness: ProviderReadiness;
  queue: LifecycleQueue;
  settings: Pick<LifecycleSettings, 'leaseSeconds' | 'admissionDelayS'>;
  /** Source of the admission jitter; Math.random by default. */
  random?: () => number;
}

/** The attempt's directory in the trials volume, as attempts.trial_path stores it. */
export const trialPathOf = (attemptId: string): string => `trials/${attemptId}`;

/** Reads the job's run without locks. Null when the run does not exist. */
export async function readClaimTarget(db: AppDb, runId: string): Promise<ClaimTarget | null> {
  const [row] = await db
    .select({
      experimentId: runs.experimentId,
      experimentStatus: experiments.status,
      cancelledAt: experiments.cancelledAt,
      runStatus: runs.status,
      attemptCount: runs.attemptCount,
      provider: configurationVersions.provider,
      model: configurationVersions.model,
      hermesRevision: experiments.hermesRevision,
    })
    .from(runs)
    .innerJoin(experiments, eq(experiments.id, runs.experimentId))
    .innerJoin(configurationVersions, eq(configurationVersions.id, runs.configurationVersionId))
    .where(eq(runs.id, runId));
  if (!row) return null;
  const { cancelledAt, ...rest } = row;
  return { ...rest, cancelled: cancelledAt !== null };
}

/** Why a job for `target` has nothing to do, or null when it may claim. Checked again under locks. */
export function staleReason(
  target: Pick<ClaimTarget, 'experimentStatus' | 'cancelled' | 'runStatus' | 'attemptCount'>,
  attempt: number,
): string | null {
  if (target.cancelled) return 'the experiment was cancelled';
  if (target.experimentStatus !== 'running') return `the experiment is ${target.experimentStatus}`;
  if (target.runStatus !== 'queued') return `the run is ${target.runStatus}`;
  if (target.attemptCount !== attempt - 1) {
    return `the run has ${target.attemptCount} attempts, so this job for attempt ${attempt} is stale`;
  }
  return null;
}

/** A whole number of seconds in [min, max]. */
export function admissionDelay(range: { min: number; max: number }, random: () => number): number {
  return Math.round(range.min + random() * (range.max - range.min));
}

export async function claimRun(tx: AppTx, input: ClaimInput): Promise<ClaimOutcome> {
  const { runId, attempt, trigger } = input.job.data;
  // experiment_id never changes (runs_guard), so reading it unlocked is safe.
  const [located] = await tx
    .select({ experimentId: runs.experimentId })
    .from(runs)
    .where(eq(runs.id, runId));
  if (!located) return { kind: 'stale', reason: 'the run does not exist' };
  const experimentId = located.experimentId;

  // 1. The experiment row first.
  const [experiment] = await tx
    .select({
      status: experiments.status,
      cancelledAt: experiments.cancelledAt,
      concurrency: experiments.concurrency,
      spendCeilingUsd: experiments.spendCeilingUsd,
      hermesRevision: experiments.hermesRevision,
    })
    .from(experiments)
    .where(eq(experiments.id, experimentId))
    .for('no key update');
  // 2. Then the run.
  const [run] = await tx
    .select({
      status: runs.status,
      attemptCount: runs.attemptCount,
      taskId: runs.taskId,
      configurationVersionId: runs.configurationVersionId,
      provider: configurationVersions.provider,
      model: configurationVersions.model,
    })
    .from(runs)
    .innerJoin(configurationVersions, eq(configurationVersions.id, runs.configurationVersionId))
    .where(eq(runs.id, runId))
    .for('update', { of: runs });
  const stale = staleReason(
    {
      experimentStatus: experiment!.status,
      cancelled: experiment!.cancelledAt !== null,
      runStatus: run!.status,
      attemptCount: run!.attemptCount,
    },
    attempt,
  );
  if (stale) return { kind: 'stale', reason: stale };
  const defer = async (reason: ClaimDeferReason): Promise<ClaimOutcome> => {
    const startAfterSeconds = admissionDelay(
      input.settings.admissionDelayS,
      input.random ?? Math.random,
    );
    await input.queue.defer(tx, input.job, {
      singletonKey: executeRunKey(runId, attempt),
      startAfterSeconds,
    });
    return { kind: 'deferred', reason, startAfterSeconds };
  };

  // 3. The frozen Hermes revision.
  if (experiment!.hermesRevision !== input.hermesRevision) return defer('hermes_revision');

  // 4. Admission.
  const [{ running } = { running: 0 }] = await tx
    .select({ running: sql<number>`count(*)::int` })
    .from(runs)
    .where(and(eq(runs.experimentId, experimentId), eq(runs.status, 'running')));
  if (running >= experiment!.concurrency) return defer('admission');

  // 5. Spend guard.
  const ceiling = experiment!.spendCeilingUsd;
  if (ceiling !== null) {
    const spend = await spendSoFar(tx, experimentId);
    if (spend.counted >= ceiling) {
      await pauseExperiment(tx, experimentId, 'spend_ceiling');
      const unknown =
        spend.unknown > 0
          ? ` (with ${spend.unknown} attempt${spend.unknown === 1 ? '' : 's'} of unknown cost counted at $${(spend.mean ?? 0).toFixed(2)} each)`
          : '';
      return {
        kind: 'paused',
        reason: 'spend_ceiling',
        message: `spend $${spend.counted.toFixed(2)}${unknown} reached the $${ceiling.toFixed(2)} ceiling`,
      };
    }
  }

  // 6. Provider guard.
  if (!input.readiness.ready) {
    await pauseExperiment(tx, experimentId, 'provider_disconnected');
    return {
      kind: 'paused',
      reason: 'provider_disconnected',
      message: input.readiness.reason ?? `provider ${run!.provider} is not ready`,
    };
  }

  // 7. The attempt, the run pointer and the worker's in-flight count.
  const attemptId = newId();
  const [inserted] = await tx
    .insert(attempts)
    .values({
      id: attemptId,
      runId,
      number: attempt,
      trigger,
      status: 'running',
      workerId: input.workerId,
      trialPath: trialPathOf(attemptId),
      leaseExpiresAt: sql`now() + make_interval(secs => ${input.settings.leaseSeconds})`,
      sandboxHostId: input.hostId,
    })
    .returning({ leaseToken: attempts.leaseToken });
  await tx
    .update(runs)
    .set({
      status: 'running',
      attemptCount: attempt,
      currentAttemptId: attemptId,
      finishedAt: null,
      nextTrigger: null,
    })
    .where(eq(runs.id, runId));
  await tx
    .update(workers)
    .set({ inFlight: sql`${workers.inFlight} + 1` })
    .where(eq(workers.id, input.workerId));

  return {
    kind: 'claimed',
    attempt: {
      attemptId,
      leaseToken: inserted!.leaseToken,
      attemptNumber: attempt,
      trigger,
      runId,
      experimentId,
      taskId: run!.taskId,
      configurationVersionId: run!.configurationVersionId,
      provider: run!.provider,
      model: run!.model,
      workerId: input.workerId,
    },
  };
}

/**
 * The spend the guard compares with the ceiling: every recorded cost, plus
 * the attempts of a priced model whose trial ran (a container was recorded)
 * and finished without a cost, each counted at the mean of the priced
 * attempts that cost something. Read under the experiment lock.
 */
export async function spendSoFar(
  tx: AppTx,
  experimentId: string,
): Promise<{ counted: number; spent: number; unknown: number; mean: number | null }> {
  const [row] = rowsOf<{ spent: number; unknown: number; mean: number | null }>(
    await tx.execute(sql`select coalesce(sum(a.cost_usd), 0)::float8 as spent,
        (count(*) filter (where a.cost_usd is null and a.finished_at is not null
           and a.sandbox_id is not null
           and (e.price_table -> 'models' -> cv.model) is not null))::int as unknown,
        (avg(a.cost_usd) filter (where a.cost_usd > 0))::float8 as mean
      from attempts a
      join runs r on r.id = a.run_id
      join experiments e on e.id = r.experiment_id
      join configuration_versions cv on cv.id = r.configuration_version_id
     where r.experiment_id = ${experimentId}`),
  );
  const spent = Number(row?.spent ?? 0);
  const unknown = Number(row?.unknown ?? 0);
  const mean = row?.mean === null || row?.mean === undefined ? null : Number(row.mean);
  return { counted: spent + unknown * (mean ?? 0), spent, unknown, mean };
}

/** Pauses a running experiment with a guard's reason. */
async function pauseExperiment(tx: AppTx, experimentId: string, reason: PauseReason) {
  await tx
    .update(experiments)
    .set({ status: 'paused', pauseReason: reason, pausedAt: sql`now()` })
    .where(and(eq(experiments.id, experimentId), eq(experiments.status, 'running')));
}
