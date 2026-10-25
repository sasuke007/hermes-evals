/**
 * The experiment controls (plan 7.3, UI_FLOWS 15): Pause, Resume, Cancel and
 * Retry failed runs. Each is one transaction that locks the experiment row
 * first (command-support.ts), so a control, another control and a worker
 * finishing a run are serialised on that row and never interleave.
 *
 * The provider check of Resume and Retry failed runs runs before the
 * transaction: it may ask nous-login over the network, and no row lock is
 * held across that call. A guard that pauses the experiment in between is
 * caught by the status checks inside the transaction. Both also refuse while
 * no connected worker runs the Hermes revision the experiment froze, since
 * every job would only be put back.
 */
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { ExperimentActionResult, Provider, ResumeExperimentInput } from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import {
  attempts,
  configurationVersions,
  experiments,
  MAX_ATTEMPTS_PER_RUN,
  runs,
} from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import { QueueService } from '../../queue/queue.service.js';
import type { ExecuteRunJob } from '../../queue/queues.js';
import { reconcileExperiment } from '../reconcile.js';
import {
  bossOf,
  conflict,
  experimentStatus,
  lockExperiment,
  notFound,
  usd,
  type ExperimentRow,
} from './command-support.js';
import { cancelExecuteRuns, queuedRunJobs, sendExecuteRuns } from './jobs.js';
import { frozenRevisionRefusal, liveWorkers } from './live-workers.js';
import { blockedMessage, ProviderGate } from './provider-gate.js';

/** The status moved between the provider check and the lock; a retry checks again. */
const CHANGED_MEANWHILE = 'the experiment changed while this was being checked; try again';

/** Priced spend of an experiment so far: the sum of its attempts' costs. Unpriced ones add nothing. */
export async function spentUsd(db: AppDb, experimentId: string): Promise<number> {
  const [row] = await db
    .select({ spent: sql<number>`coalesce(sum(${attempts.costUsd}), 0)`.mapWith(Number) })
    .from(attempts)
    .innerJoin(runs, eq(runs.id, attempts.runId))
    .where(eq(runs.experimentId, experimentId));
  return row?.spent ?? 0;
}

/** The providers an experiment's configuration versions use. */
export async function experimentProviders(
  db: AppDb,
  experiment: Pick<ExperimentRow, 'baselineVersionId' | 'candidateVersionIds'>,
): Promise<Provider[]> {
  const rows = await db
    .select({ provider: configurationVersions.provider })
    .from(configurationVersions)
    .where(
      inArray(configurationVersions.id, [
        experiment.baselineVersionId,
        ...experiment.candidateVersionIds,
      ]),
    );
  return rows.map((r) => r.provider);
}

@Injectable()
export class ExperimentControlsService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    private readonly queue: QueueService,
    private readonly gate: ProviderGate,
  ) {}

  /**
   * POST /experiments/:id/pause: a user pause. Workers that claim its jobs
   * complete them without starting anything; in-flight trials finish. An
   * experiment already paused stays paused for its own reason.
   */
  async pause(id: string): Promise<ExperimentActionResult> {
    return this.db.transaction(async (tx) => {
      const e = await lockExperiment(tx, id);
      if (e.status === 'paused') return { id, status: e.status };
      if (e.status !== 'running') {
        throw conflict(`the experiment is ${e.status}; only a running experiment can be paused`);
      }
      if (e.cancelledAt !== null) {
        throw conflict('the experiment was cancelled and is finishing its in-flight runs');
      }
      await tx
        .update(experiments)
        .set({ status: 'paused', pauseReason: 'user', pausedAt: sql`now()` })
        .where(eq(experiments.id, id));
      return { id, status: 'paused' };
    });
  }

  /**
   * POST /experiments/:id/resume. Needs every provider ready, and after a
   * spend-ceiling pause a ceiling above both the old one and the spend so
   * far. Sets running, then sends execute-run for every queued run with key
   * `runId:(attempt_count + 1)`: a no-op for runs whose job still waits.
   * Resuming a running experiment changes nothing.
   */
  async resume(id: string, input: ResumeExperimentInput): Promise<ExperimentActionResult> {
    const checked = await this.assertProvidersReadyWhen(id, 'paused');
    const boss = bossOf(this.queue);
    return this.db.transaction(async (tx) => {
      const e = await lockExperiment(tx, id);
      if (e.status === 'running') return { id, status: e.status };
      if (e.status !== 'paused') {
        throw conflict(`the experiment is ${e.status}, not paused`);
      }
      if (!checked) throw conflict(CHANGED_MEANWHILE);
      const ceiling = input.spendCeilingUsd;
      const spent = await spentUsd(tx, id);
      if (e.pauseReason === 'spend_ceiling') {
        const floor = Math.max(e.spendCeilingUsd ?? 0, spent);
        if (ceiling === undefined || ceiling <= floor) {
          throw conflict(`raise the spend ceiling above ${usd(floor)} to resume`);
        }
      } else if (ceiling !== undefined && ceiling <= spent) {
        // The spend guard would pause it again before the next run.
        throw conflict(`raise the spend ceiling above ${usd(spent)} to resume`);
      }
      await tx
        .update(experiments)
        .set({
          status: 'running',
          pauseReason: null,
          pausedAt: null,
          ...(ceiling === undefined ? {} : { spendCeilingUsd: ceiling }),
        })
        .where(eq(experiments.id, id));
      await sendExecuteRuns(boss, tx, await queuedRunJobs(tx, id));
      // Nothing left to run (it was paused as its last run finished): complete it now.
      await reconcileExperiment(tx, id);
      return { id, status: await experimentStatus(tx, id) };
    });
  }

  /**
   * POST /experiments/:id/cancel. Sets cancelled_at, which stops workers
   * from starting anything more; queued runs are cancelled with their jobs,
   * running runs get cancel_requested_at and their worker stops the
   * container. Executed and scoring runs finish scoring. A paused or failed
   * experiment goes back to running while it drains (the experiments CHECK
   * allows cancelled_at only on running or completed), and reconcile
   * completes it as soon as nothing is in flight, possibly right here.
   */
  async cancel(id: string): Promise<ExperimentActionResult> {
    const boss = bossOf(this.queue);
    return this.db.transaction(async (tx) => {
      const e = await lockExperiment(tx, id);
      if (e.status === 'completed') {
        if (e.cancelledAt !== null) return { id, status: e.status };
        throw conflict('the experiment is already completed');
      }
      await tx
        .update(experiments)
        .set({
          status: 'running',
          cancelledAt: e.cancelledAt ?? sql`now()`,
          pauseReason: null,
          pausedAt: null,
          // A failed experiment's breaker record no longer describes it once cancelled.
          ...(e.status === 'failed' ? { failure: null, finishedAt: null } : {}),
        })
        .where(eq(experiments.id, id));
      await this.cancelRuns(boss, tx, id);
      await reconcileExperiment(tx, id);
      return { id, status: await experimentStatus(tx, id) };
    });
  }

  /**
   * POST /experiments/:id/retry-failed: reopens an experiment the circuit
   * breaker stopped. Clears the failure and the breaker's counter, queues
   * every execution_error run that has attempts left (trigger retry_failed),
   * and sends the queued runs like Resume. With nothing left to run,
   * reconcile completes it at once.
   */
  async retryFailed(id: string): Promise<ExperimentActionResult> {
    const checked = await this.assertProvidersReadyWhen(id, 'failed');
    const boss = bossOf(this.queue);
    return this.db.transaction(async (tx) => {
      const e = await lockExperiment(tx, id);
      if (e.status === 'running') return { id, status: e.status };
      if (e.status !== 'failed') {
        throw conflict(`the experiment is ${e.status}, not failed`);
      }
      if (!checked) throw conflict(CHANGED_MEANWHILE);
      await tx
        .update(experiments)
        .set({ status: 'running', failure: null, finishedAt: null, consecutiveExecutionErrors: 0 })
        .where(eq(experiments.id, id));
      const waiting = await queuedRunJobs(tx, id);
      const requeued = await tx
        .update(runs)
        .set({ status: 'queued', finishedAt: null, nextTrigger: 'retry_failed' })
        .where(
          and(
            eq(runs.experimentId, id),
            eq(runs.status, 'execution_error'),
            lt(runs.attemptCount, MAX_ATTEMPTS_PER_RUN),
          ),
        )
        .returning({ runId: runs.id, attemptCount: runs.attemptCount });
      const jobs: ExecuteRunJob[] = [
        ...waiting,
        ...requeued.map((r) => ({
          runId: r.runId,
          attempt: r.attemptCount + 1,
          trigger: 'retry_failed' as const,
        })),
      ];
      await sendExecuteRuns(boss, tx, jobs);
      await reconcileExperiment(tx, id);
      return { id, status: await experimentStatus(tx, id) };
    });
  }

  /** Queued runs to cancelled with their jobs; running runs get a cancel request. */
  private async cancelRuns(
    boss: ReturnType<typeof bossOf>,
    tx: AppTx,
    experimentId: string,
  ): Promise<void> {
    const cancelled = await tx
      .update(runs)
      .set({ status: 'cancelled', finishedAt: sql`now()` })
      .where(and(eq(runs.experimentId, experimentId), eq(runs.status, 'queued')))
      .returning({ id: runs.id });
    await tx
      .update(runs)
      .set({ cancelRequestedAt: sql`now()` })
      .where(
        and(
          eq(runs.experimentId, experimentId),
          eq(runs.status, 'running'),
          isNull(runs.cancelRequestedAt),
        ),
      );
    await cancelExecuteRuns(
      boss,
      tx,
      cancelled.map((r) => r.id),
    );
  }

  /**
   * When the experiment is in `status` (the one the control acts on), 409
   * with the reason if its runs cannot start now: a worker on its frozen
   * Hermes revision is missing, or one of its configurations' providers is
   * not ready. Resolves whether it checked: the transaction refuses to act
   * on a status that arrived after this unchecked read.
   */
  private async assertProvidersReadyWhen(
    id: string,
    status: ExperimentRow['status'],
  ): Promise<boolean> {
    const [e] = await this.db.select().from(experiments).where(eq(experiments.id, id));
    if (!e) throw notFound(`experiment ${id}`);
    if (e.status !== status) return false;
    const revision = frozenRevisionRefusal(await liveWorkers(this.db), e.hermesRevision);
    if (revision) throw conflict(revision);
    const blocks = await this.gate.blocked(await experimentProviders(this.db, e));
    if (blocks.length > 0) throw conflict(blockedMessage(blocks));
    return true;
  }
}
