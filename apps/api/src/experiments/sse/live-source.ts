/**
 * The reads behind GET /experiments/:id/events. The stream's poller asks for
 * a cheap version every second and for the full state only when it moved.
 *
 * The version is the experiment row's results_revision with its status,
 * pause reason, failure, verdict revision and verdict history length, and
 * how many evaluations its runs have and how many of them are queued or
 * running. The 0001 triggers bump results_revision whenever a run changes
 * status and whenever a score set is published or superseded, which covers
 * most fields the stream sends: attempt counts change with a status
 * (queued → running), an attempt's cost is written with the status change
 * that ends it, and a primary score and its generation with their publish.
 * A re-score queued or dead-lettered moves no revision, so the evaluation
 * counts carry `rescorePending`; an appended verdict entry moves the
 * history length. Runs have no updated-at column, so the poller diffs a
 * snapshot of the runs instead (experiment-diff.ts); one row read and one
 * pass over the experiment's evaluations per second while idle.
 *
 * The state is read in one REPEATABLE READ READ ONLY transaction, so a run's
 * primary score and the generation it is labelled with come from the same
 * snapshot even while a re-score publishes.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { ComparisonService } from '../comparison/comparison.service.js';
import { READ_ONLY_SNAPSHOT } from '../comparison/results.js';
import type { VerdictFigures } from '../comparison/verdicts.js';
import type { ConfigFacts } from '../views/facts.js';
import { failureView } from '../views/failure.js';
import { spendView } from '../views/money.js';
import { doneRuns } from '../views/numbers.js';
import { countRuns, feedEntryOf } from '../views/progress.js';
import {
  armMoneyOf,
  errorRunsOf,
  experimentById,
  mcpServersOf,
  runFactsOf,
  versionFactsOf,
  type ExperimentRow,
} from '../views/queries.js';
import { experimentConfigs } from '../views/snapshot.js';
import { listVerdicts, needsFigures, verdictUpdatedAt } from '../views/verdicts.js';
import { DB } from '../../database/db.provider.js';
import { experiments } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import {
  NO_EVALUATION,
  rescorePending,
  runEvaluationView,
} from '../../runs/views/evaluation-view.js';
import { evaluationStatesOfExperiment } from '../../runs/views/run-views.queries.js';
import type { LiveRun, LiveState } from './experiment-diff.js';

/** What the stream's poller reads. A test can provide its own. */
export interface LiveSource {
  /** A string that changes whenever the stream has something to send; null for an unknown experiment. */
  version(experimentId: string): Promise<string | null>;
  /** The experiment as the stream compares it. Throws for an unknown experiment. */
  state(experimentId: string): Promise<LiveState>;
  /** Called when nobody watches the experiment any more: drop what was cached for it. */
  forget?(experimentId: string): void;
}

/** Injection token of the LiveSource the experiment events hub polls. */
export const LIVE_SOURCE = Symbol('LIVE_SOURCE');

/**
 * The live state of one experiment row, read with the view queries. Pass
 * the current verdict figures for a completed experiment whose history
 * lacks a candidate (views/verdicts.ts needsFigures); otherwise null.
 */
export async function readLiveState(
  db: AppDb,
  e: ExperimentRow,
  configs: readonly ConfigFacts[],
  figures: VerdictFigures | null = null,
): Promise<LiveState> {
  const failed = e.status === 'failed' && e.failure !== null;
  const versionIds = configs.map((c) => c.ref.versionId);
  // One statement after another: `db` is the snapshot's transaction, whose
  // one connection runs them in turn anyway (pg 9 refuses overlapping queries).
  const runs = await runFactsOf(db, e.id);
  const arms = (await armMoneyOf(db, [e.id])).get(e.id) ?? [];
  const errorRuns = failed ? await errorRunsOf(db, [e.id]) : [];
  const mcpServers = failed ? await mcpServersOf(db, versionIds) : [];
  const evaluationStates = await evaluationStatesOfExperiment(db, e.id);
  const counts = countRuns(runs);
  const names = new Map(configs.map((c) => [c.ref.versionId, c.ref.name]));
  const live = new Map<string, LiveRun>(
    runs.map((run) => {
      const states = evaluationStates.get(run.id);
      const evaluation = states ? runEvaluationView(states) : NO_EVALUATION;
      return [
        run.id,
        {
          id: run.id,
          status: run.status,
          attempt: run.attemptCount,
          primaryScore: run.primary,
          finishedAt: run.finishedAt?.toISOString() ?? null,
          generation: evaluation.generation,
          rescorePending: rescorePending(evaluation),
          feed: feedEntryOf(run, names.get(run.configurationVersionId) ?? ''),
        },
      ];
    }),
  );
  return {
    status: e.status,
    pauseReason: e.pauseReason,
    failure: failed && e.failure ? failureView(e.failure, errorRuns, mcpServers) : null,
    counts,
    doneRuns: doneRuns(e.status, counts),
    spend: spendView({
      status: e.status,
      ceilingUsd: e.spendCeilingUsd,
      priceTable: e.priceTable,
      estimate: e.estimate,
      models: new Map(configs.map((c) => [c.ref.versionId, c.ref.model])),
      arms,
      runs,
    }),
    verdicts: listVerdicts({
      status: e.status,
      verdictHistory: e.verdictHistory,
      configs,
      figures,
    }),
    verdictUpdatedAt: verdictUpdatedAt(e.verdictHistory),
    runs: live,
  };
}

@Injectable()
export class DbLiveSource implements LiveSource {
  /**
   * Configuration versions are frozen at launch, so each watched
   * experiment's are read once (a rename shows on the next subscription).
   */
  private readonly configs = new Map<string, ConfigFacts[]>();
  /** Verdict figures for the legacy case of readLiveState; shared with the comparison when loaded. */
  private readonly comparisons: ComparisonService;

  constructor(
    @Inject(DB) private readonly db: AppDb,
    @Optional() @Inject(ComparisonService) comparisons?: ComparisonService,
  ) {
    this.comparisons = comparisons ?? new ComparisonService(db);
  }

  async version(experimentId: string): Promise<string | null> {
    const [row] = await this.db
      .select({
        revision: experiments.resultsRevision,
        status: experiments.status,
        pauseReason: experiments.pauseReason,
        failure: experiments.failure,
        verdictRevision: experiments.verdictRevision,
        verdicts: sql<number>`jsonb_array_length(${experiments.verdictHistory})`.mapWith(Number),
        // One pass over the experiment's evaluations: how many, and how many queued or
        // running. Drizzle leaves a one-table select's columns unqualified, so it names its own.
        evaluations: sql<string>`(select count(*) || '/' || count(*) filter (where v.status in ('queued', 'running'))
          from evaluations v join runs r on r.id = v.run_id
          where r.experiment_id = experiments.id)`,
      })
      .from(experiments)
      .where(eq(experiments.id, experimentId));
    if (!row) return null;
    return JSON.stringify([
      row.revision,
      row.status,
      row.pauseReason,
      row.failure,
      row.verdictRevision,
      row.verdicts,
      row.evaluations,
    ]);
  }

  async state(experimentId: string): Promise<LiveState> {
    const e = await experimentById(this.db, experimentId);
    if (!e) throw new Error(`experiment ${experimentId} does not exist`);
    let configs = this.configs.get(e.id);
    if (!configs) {
      const ids = [e.baselineVersionId, ...e.candidateVersionIds];
      configs = experimentConfigs(e, await versionFactsOf(this.db, ids));
      this.configs.set(e.id, configs);
    }
    const known = configs;
    // In their own snapshot, before this one: PGlite runs one transaction at a time.
    const figures = needsFigures(e) ? await this.comparisons.verdictFigures(e.id) : null;
    return this.db.transaction(async (tx) => {
      // Re-read the row in the snapshot, so the runs and the row agree.
      const row = (await experimentById(tx, experimentId)) ?? e;
      return readLiveState(tx, row, known, needsFigures(row) ? figures : null);
    }, READ_ONLY_SNAPSHOT);
  }

  forget(experimentId: string): void {
    this.configs.delete(experimentId);
  }
}
