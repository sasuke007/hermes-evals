/**
 * The run actions of the inspector and the Runs tab's bulk bar (plan 7.3,
 * UI_FLOWS 15, 17 and 18): Retry, Cancel and bulk Retry execution. Re-score
 * is in rescore.service.ts.
 *
 * Each action is one transaction that locks the experiment row first, then
 * the runs (command-support.ts), so it is serialised with the experiment
 * controls and with the worker finishing the same runs. Retry's checks run
 * before the transaction, as for Resume: a connected worker must run the
 * Hermes revision the experiment froze (else every job would only be put
 * back, claim.ts), and the run's provider must be ready.
 *
 * A retry queues an execution_error run for its next attempt, at most
 * MAX_ATTEMPTS_PER_RUN in all, and sends `runId:(attempt_count + 1)` with
 * trigger user_retry. A completed experiment goes back to running. A
 * cancelled one cannot be reopened: its workers start nothing more, so the
 * run would wait for ever. A failed one reopens through Retry failed runs,
 * which also clears the breaker.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { BulkRunActionResult, Provider, RunActionResult } from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import {
  configurationVersions,
  experiments,
  MAX_ATTEMPTS_PER_RUN,
  runs,
} from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import { QueueService } from '../../queue/queue.service.js';
import {
  bossOf,
  conflict,
  lockExperiment,
  notFound,
  type ExperimentRow,
} from '../../experiments/commands/command-support.js';
import { cancelExecuteRuns, sendExecuteRuns } from '../../experiments/commands/jobs.js';
import { frozenRevisionRefusal, liveWorkers } from '../../experiments/commands/live-workers.js';
import { PROVIDER_NAMES, ProviderGate } from '../../experiments/commands/provider-gate.js';
import { reconcileExperiment } from '../../experiments/reconcile.js';

type RunRow = typeof runs.$inferSelect;

/** A bulk refusal when the queue cannot take jobs (the web's wording). */
export const BULK_QUEUE_UNAVAILABLE = 'execute-run job could not be enqueued: queue unavailable';

/** The run moved between the unlocked checks and the lock; a second try checks it again. */
export const RUN_CHANGED_MEANWHILE = 'the run changed while this was being checked; try again';

/** Why a run cannot be retried now, or null when it can. */
export function retryRefusal(
  experiment: Pick<ExperimentRow, 'status' | 'cancelledAt'>,
  run: Pick<RunRow, 'status' | 'attemptCount'>,
): string | null {
  if (experiment.cancelledAt !== null) return 'the experiment was cancelled';
  if (experiment.status === 'failed') {
    return 'the experiment failed; use Retry failed runs to reopen it';
  }
  if (run.status !== 'execution_error') return `run is ${run.status}, not execution_error`;
  if (run.attemptCount >= MAX_ATTEMPTS_PER_RUN) {
    return `run already has ${MAX_ATTEMPTS_PER_RUN} attempts`;
  }
  return null;
}

/** "Retry needs Nous Portal: Nous Portal is not connected". */
const providerRefusal = (provider: Provider, reason: string): string =>
  `Retry needs ${PROVIDER_NAMES[provider]}: ${reason}`;

@Injectable()
export class RunCommandsService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    private readonly queue: QueueService,
    private readonly gate: ProviderGate,
  ) {}

  /**
   * POST /runs/:id/retry. 409 with the reason when the run cannot be
   * retried, when no connected worker runs the experiment's frozen Hermes
   * revision, or when its provider is not ready. Those two checks run only
   * for a run that reads execution_error before the lock; one that became
   * retryable after that read is answered "try again", never let through
   * unchecked.
   */
  async retry(runId: string): Promise<RunActionResult> {
    const [target] = await this.withProviders([runId]);
    if (!target) throw notFound(`run ${runId}`);
    const checked = target.status === 'execution_error';
    if (checked) {
      const revision = frozenRevisionRefusal(await liveWorkers(this.db), target.hermesRevision);
      if (revision) throw conflict(revision);
      const [block] = await this.gate.blocked([target.provider]);
      if (block) throw conflict(providerRefusal(block.provider, block.reason));
    }
    const boss = bossOf(this.queue);
    return this.db.transaction(async (tx) => {
      const experiment = await lockExperiment(tx, target.experimentId);
      const [run] = await lockRuns(tx, target.experimentId, [runId]);
      if (!run) throw notFound(`run ${runId}`);
      const refusal = retryRefusal(experiment, run);
      if (refusal) throw conflict(refusal);
      if (!checked) throw conflict(RUN_CHANGED_MEANWHILE);
      await requeue(boss, tx, experiment, [run]);
      return { runId, status: 'queued', attempt: run.attemptCount + 1 };
    });
  }

  /**
   * POST /experiments/:id/runs/retry: every run that can be retried is, and
   * the others are listed with their reason. The answer is 200 either way.
   * With no connected worker on the experiment's frozen Hermes revision,
   * every retryable run is refused with that reason.
   */
  async retryMany(experimentId: string, runIds: readonly string[]): Promise<BulkRunActionResult> {
    const [exists] = await this.db
      .select({ id: experiments.id, hermesRevision: experiments.hermesRevision })
      .from(experiments)
      .where(eq(experiments.id, experimentId));
    if (!exists) throw notFound(`experiment ${experimentId}`);
    const revision = frozenRevisionRefusal(await liveWorkers(this.db), exists.hermesRevision);
    const targets = new Map(
      (await this.withProviders(runIds))
        .filter((t) => t.experimentId === experimentId)
        .map((t) => [t.id, t]),
    );
    const blocks = new Map(
      (
        await this.gate.blocked(
          [...targets.values()]
            .filter((t) => t.status === 'execution_error')
            .map((t) => t.provider),
        )
      ).map((b) => [b.provider, b.reason]),
    );
    let boss: PgBoss;
    try {
      boss = bossOf(this.queue);
    } catch {
      return {
        action: 'retry',
        enqueued: [],
        refused: runIds.map((runId) => ({ runId, reason: BULK_QUEUE_UNAVAILABLE })),
      };
    }
    return this.db.transaction(async (tx) => {
      const experiment = await lockExperiment(tx, experimentId);
      const locked = new Map((await lockRuns(tx, experimentId, runIds)).map((r) => [r.id, r]));
      const accepted: RunRow[] = [];
      const refused: BulkRunActionResult['refused'] = [];
      for (const runId of runIds) {
        const run = locked.get(runId);
        const target = targets.get(runId);
        const blocked = target ? blocks.get(target.provider) : undefined;
        const reason = !run
          ? 'run not found in this experiment'
          : (retryRefusal(experiment, run) ??
            revision ??
            (blocked !== undefined && target ? providerRefusal(target.provider, blocked) : null));
        if (reason !== null) refused.push({ runId, reason });
        else accepted.push(run!);
      }
      await requeue(boss, tx, experiment, accepted);
      return { action: 'retry', enqueued: accepted.map((r) => r.id), refused };
    });
  }

  /**
   * POST /runs/:id/cancel. A queued run is cancelled and its job removed; a
   * running run gets cancel_requested_at, and the worker that owns it stops
   * its container and ends the attempt as cancelled. The answer carries the
   * run's status now: `running` until that worker has stopped it.
   */
  async cancel(runId: string): Promise<RunActionResult> {
    const [found] = await this.db
      .select({ experimentId: runs.experimentId })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!found) throw notFound(`run ${runId}`);
    const boss = bossOf(this.queue);
    return this.db.transaction(async (tx) => {
      await lockExperiment(tx, found.experimentId);
      const [run] = await lockRuns(tx, found.experimentId, [runId]);
      if (!run) throw notFound(`run ${runId}`);
      if (run.status === 'cancelled') return { runId, status: run.status, attempt: null };
      if (run.status === 'queued') {
        await tx
          .update(runs)
          .set({ status: 'cancelled', finishedAt: sql`now()` })
          .where(eq(runs.id, runId));
        await cancelExecuteRuns(boss, tx, [runId]);
        // This may have been the experiment's last unsettled run.
        await reconcileExperiment(tx, found.experimentId);
        return { runId, status: 'cancelled', attempt: null };
      }
      if (run.status === 'running') {
        if (run.cancelRequestedAt === null) {
          await tx
            .update(runs)
            .set({ cancelRequestedAt: sql`now()` })
            .where(eq(runs.id, runId));
        }
        return { runId, status: 'running', attempt: null };
      }
      throw conflict(`run is ${run.status}; only a queued or running run can be cancelled`);
    });
  }

  /**
   * The runs that exist among `ids`, with their experiment and its frozen
   * Hermes revision, their status and their configuration's provider.
   */
  private withProviders(ids: readonly string[]) {
    if (ids.length === 0) return Promise.resolve([]);
    return this.db
      .select({
        id: runs.id,
        experimentId: runs.experimentId,
        hermesRevision: experiments.hermesRevision,
        status: runs.status,
        provider: configurationVersions.provider,
      })
      .from(runs)
      .innerJoin(experiments, eq(experiments.id, runs.experimentId))
      .innerJoin(configurationVersions, eq(configurationVersions.id, runs.configurationVersionId))
      .where(inArray(runs.id, [...ids]));
  }
}

/** Locks the experiment's runs among `ids`, in id order; call after lockExperiment. */
export function lockRuns(
  tx: AppTx,
  experimentId: string,
  ids: readonly string[],
): Promise<RunRow[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return tx
    .select()
    .from(runs)
    .where(and(eq(runs.experimentId, experimentId), inArray(runs.id, [...ids])))
    .orderBy(asc(runs.id))
    .for('no key update');
}

/**
 * Queues execution_error runs for their next attempt and sends their jobs;
 * a completed experiment goes back to running so reconcile completes it
 * again once they settle.
 */
async function requeue(
  boss: PgBoss,
  tx: AppTx,
  experiment: ExperimentRow,
  accepted: readonly RunRow[],
): Promise<void> {
  if (accepted.length === 0) return;
  if (experiment.status === 'completed') {
    await tx
      .update(experiments)
      .set({ status: 'running', finishedAt: null })
      .where(eq(experiments.id, experiment.id));
  }
  await tx
    .update(runs)
    .set({ status: 'queued', finishedAt: null, nextTrigger: 'user_retry' })
    .where(
      inArray(
        runs.id,
        accepted.map((r) => r.id),
      ),
    );
  await sendExecuteRuns(
    boss,
    tx,
    accepted.map((r) => ({ runId: r.id, attempt: r.attemptCount + 1, trigger: 'user_retry' })),
  );
}
