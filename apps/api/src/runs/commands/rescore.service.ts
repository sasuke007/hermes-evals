/**
 * Re-score (plan 9.4, 3.3, UI_FLOWS 13, 17 and 18): grade a scored run's
 * stored evidence again, never running Hermes. POST /runs/:id/rescore and
 * the bulk POST /experiments/:id/runs/rescore.
 *
 * - Only a `scored` run can be re-scored. It stays `scored`, and its
 *   current result stays current until the new generation publishes; a
 *   re-score whose job dies on every try is marked failed and changes
 *   nothing the run shows (evaluation/dead-letter.ts).
 * - One transaction inserts the evaluation with the next generation and
 *   sends its evaluate-run job (evaluation/job.ts queueEvaluation, cause
 *   `rescore`), so neither exists without the other.
 * - At most one evaluation per run is queued or running
 *   (evaluations_in_flight_uq): a request while one is pending answers that
 *   one with `joinedPending`, so double clicks collapse into one.
 * - What it grades with: the experiment's frozen task row (its stored
 *   verification list) and the scorers as they are in code now, whose
 *   versions each score row records.
 * - The judge (Phase 3 decision S3): a task with llm_judge keys needs a
 *   judge model for each (Phase 3 question 2) and the judge's provider
 *   ready (judge-needs.ts, providers/readiness.ts), as Launch does, or the
 *   answer is 409 with why and, for a missing model, how to set one. The
 *   provider is checked before the transaction, which holds no row lock
 *   across nous-login's answer.
 *
 * Lock order (plan 3.3): the experiment row, then the runs, then their
 * evaluations. Two concurrent requests for one run therefore queue on the
 * experiment row, and the second sees the first's evaluation.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, inArray } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type {
  BulkRescoreResult,
  PendingEvaluationView,
  Provider,
  RescoreRunResult,
} from '@hermes-evals/shared';
import type { Env } from '../../config/env.js';
import { DB } from '../../database/db.provider.js';
import { evaluations, experiments, runs, tasks } from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import { queueEvaluation } from '../../evaluation/job.js';
import {
  bossOf,
  conflict,
  lockExperiment,
  notFound,
} from '../../experiments/commands/command-support.js';
import { PROVIDER_NAMES, ProviderGate } from '../../experiments/commands/provider-gate.js';
import { QueueService } from '../../queue/queue.service.js';
import {
  judgeNeedsOf,
  judgeSettingsFrom,
  noJudgeModelRefusal,
  unjudgedKeys,
  type JudgeNeeds,
} from '../judge-needs.js';
import { pendingEvaluationView } from '../views/evaluation-view.js';
import { lockRuns } from './run-commands.service.js';

type RunRow = typeof runs.$inferSelect;

/** A bulk refusal when the queue cannot take jobs (the web's wording). */
export const BULK_RESCORE_QUEUE_UNAVAILABLE =
  'evaluate-run job could not be enqueued: queue unavailable';

/** Why a run cannot be re-scored because of its status, or null when it can. */
export function rescoreRefusal(run: Pick<RunRow, 'status' | 'currentAttemptId'>): string | null {
  if (run.status !== 'scored') return `run is ${run.status}, not scored`;
  // A scored run always points at its executed attempt; the database checks the rest.
  if (run.currentAttemptId === null) return 'run has no attempt to grade';
  return null;
}

/** "Re-score needs Nous Portal for the method judge: Nous Portal is not connected." */
export const judgeRefusal = (provider: Provider, keys: readonly string[], reason: string): string =>
  `Re-score needs ${PROVIDER_NAMES[provider]} for the ${keys.join(' and ')} judge: ${reason}`;

export { noJudgeModelRefusal };

/** A run as read before the transaction: where it is and what its judge needs. */
interface RescoreTarget {
  id: string;
  experimentId: string;
  judge: JudgeNeeds;
}

/** What one accepted run answers. */
interface Accepted {
  runId: string;
  evaluation: PendingEvaluationView & { cause: 'rescore' };
  joinedPending: boolean;
}

/** The run's queued or running evaluation, as Re-score answers it; null for a first evaluation. */
function asRescore(view: PendingEvaluationView | null): Accepted['evaluation'] | null {
  return view?.cause === 'rescore' ? { ...view, cause: 'rescore' } : null;
}

@Injectable()
export class RescoreService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    private readonly queue: QueueService,
    private readonly gate: ProviderGate,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * POST /runs/:id/rescore. 404 for an unknown run; 409 with the reason for
   * a run that is not scored, or whose judge's provider is not ready; 503
   * when the queue is down. A re-score already pending is answered as is.
   */
  async rescore(runId: string): Promise<RescoreRunResult> {
    const [target] = await this.targets([runId]);
    if (!target) throw notFound(`run ${runId}`);
    const blocks = await this.judgeBlocks([target]);
    const boss = bossOf(this.queue);
    return this.db.transaction(async (tx) => {
      await lockExperiment(tx, target.experimentId);
      const [run] = await lockRuns(tx, target.experimentId, [runId]);
      if (!run) throw notFound(`run ${runId}`);
      const outcome = await decide(tx, boss, run, target, blocks);
      if (typeof outcome === 'string') throw conflict(outcome);
      return { runId, status: 'scored', attempt: null, ...outcome.answer };
    });
  }

  /**
   * POST /experiments/:id/runs/rescore: every listed run that can be
   * re-scored is (or joins its pending re-score), and the others are listed
   * with their reason. 200 either way; 404 for an unknown experiment.
   */
  async rescoreMany(experimentId: string, runIds: readonly string[]): Promise<BulkRescoreResult> {
    const [exists] = await this.db
      .select({ id: experiments.id })
      .from(experiments)
      .where(eq(experiments.id, experimentId));
    if (!exists) throw notFound(`experiment ${experimentId}`);
    const targets = new Map(
      (await this.targets(runIds))
        .filter((t) => t.experimentId === experimentId)
        .map((t) => [t.id, t]),
    );
    const blocks = await this.judgeBlocks([...targets.values()]);
    let boss: PgBoss;
    try {
      boss = bossOf(this.queue);
    } catch {
      return {
        action: 'rescore',
        enqueued: [],
        refused: runIds.map((runId) => ({ runId, reason: BULK_RESCORE_QUEUE_UNAVAILABLE })),
        evaluations: [],
      };
    }
    return this.db.transaction(async (tx) => {
      await lockExperiment(tx, experimentId);
      const locked = new Map((await lockRuns(tx, experimentId, runIds)).map((r) => [r.id, r]));
      const accepted: Accepted[] = [];
      const refused: BulkRescoreResult['refused'] = [];
      for (const runId of runIds) {
        const run = locked.get(runId);
        const target = targets.get(runId);
        const outcome =
          run && target
            ? await decide(tx, boss, run, target, blocks)
            : 'run not found in this experiment';
        if (typeof outcome === 'string') refused.push({ runId, reason: outcome });
        else accepted.push({ runId, ...outcome.answer });
      }
      return {
        action: 'rescore',
        enqueued: accepted.map((a) => a.runId),
        refused,
        evaluations: accepted.map((a) => ({
          runId: a.runId,
          evaluationId: a.evaluation.evaluationId,
          generation: a.evaluation.generation,
          status: a.evaluation.status,
          joinedPending: a.joinedPending,
        })),
      };
    });
  }

  /** The runs that exist among `ids`, with what their task's judge needs. */
  private async targets(ids: readonly string[]): Promise<RescoreTarget[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({
        id: runs.id,
        experimentId: runs.experimentId,
        verification: tasks.verification,
      })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(inArray(runs.id, [...ids]));
    const settings = judgeSettingsFrom(this.config);
    return rows.map((r) => ({
      id: r.id,
      experimentId: r.experimentId,
      judge: judgeNeedsOf(r.verification, settings),
    }));
  }

  /**
   * The judge providers among `targets` that are not ready, each asked once,
   * with the reason. Asked whatever the runs' status, so a run that becomes
   * scored between this read and the lock is never let through unchecked.
   */
  private async judgeBlocks(targets: readonly RescoreTarget[]): Promise<Map<Provider, string>> {
    const providers = targets.flatMap((t) => (t.judge.provider ? [t.judge.provider] : []));
    if (providers.length === 0) return new Map();
    return new Map((await this.gate.blocked(providers)).map((b) => [b.provider, b.reason]));
  }
}

/**
 * What one locked run gets, in the order a refusal is chosen: not scored;
 * a pending re-score, joined; an llm_judge key with no judge model; its
 * judge's provider not ready; else a new evaluation queued. A string is the
 * refusal.
 */
async function decide(
  tx: AppTx,
  boss: PgBoss,
  run: RunRow,
  target: RescoreTarget,
  blocks: ReadonlyMap<Provider, string>,
): Promise<string | { answer: Omit<Accepted, 'runId'> }> {
  const refusal = rescoreRefusal(run);
  if (refusal) return refusal;
  const pending = await pendingOf(tx, run.id);
  if (pending) {
    const joined = asRescore(pending);
    // A scored run's first evaluation has published, so anything pending is a re-score.
    if (!joined) return `run ${run.id} is still being scored for the first time`;
    return { answer: { evaluation: joined, joinedPending: true } };
  }
  const { provider, judged } = target.judge;
  const unjudged = unjudgedKeys(target.judge);
  if (unjudged.length > 0) return noJudgeModelRefusal(unjudged);
  const blocked = provider ? blocks.get(provider) : undefined;
  if (provider && blocked !== undefined) return judgeRefusal(provider, judged, blocked);
  const { evaluationId } = await queueEvaluation(boss, tx, {
    runId: run.id,
    attemptId: run.currentAttemptId!,
    cause: 'rescore',
  });
  const created = asRescore(await pendingOf(tx, run.id, evaluationId));
  if (!created) throw new Error(`re-score evaluation ${evaluationId} was not queued`);
  return { answer: { evaluation: created, joinedPending: false } };
}

/**
 * The run's queued or running evaluation (at most one), locked FOR UPDATE:
 * the last lock of the order, after the experiment and the run.
 */
async function pendingOf(
  tx: AppTx,
  runId: string,
  evaluationId?: string,
): Promise<PendingEvaluationView | null> {
  const [row] = await tx
    .select({
      id: evaluations.id,
      generation: evaluations.generation,
      status: evaluations.status,
      cause: evaluations.cause,
      requestedAt: evaluations.requestedAt,
    })
    .from(evaluations)
    .where(
      and(
        eq(evaluations.runId, runId),
        inArray(evaluations.status, ['queued', 'running']),
        evaluationId === undefined ? undefined : eq(evaluations.id, evaluationId),
      ),
    )
    .for('update');
  return row ? pendingEvaluationView(row) : null;
}
