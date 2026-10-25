/**
 * The reads behind GET /experiments/:id/events. The stream's poller asks for
 * a cheap version every second and for the full state only when it moved.
 *
 * The version is the experiment row's results_revision with its status,
 * pause reason and failure. The 0001 triggers bump results_revision whenever
 * a run changes status and whenever a score set is published or superseded,
 * which covers every field the stream sends: attempt counts change with a
 * status (queued → running), an attempt's cost is written with the status
 * change that ends it, and a primary score with its publish. Runs have no
 * updated-at column, so the poller diffs a snapshot of the runs instead
 * (experiment-diff.ts); one indexed row read per second while idle.
 */
import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
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
import { DB } from '../../database/db.provider.js';
import { experiments } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
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

/** The live state of one experiment row, read with the view queries. */
export async function readLiveState(
  db: AppDb,
  e: ExperimentRow,
  configs: readonly ConfigFacts[],
): Promise<LiveState> {
  const failed = e.status === 'failed' && e.failure !== null;
  const versionIds = configs.map((c) => c.ref.versionId);
  const [runs, arms, errorRuns, mcpServers] = await Promise.all([
    runFactsOf(db, e.id),
    armMoneyOf(db, [e.id]).then((m) => m.get(e.id) ?? []),
    failed ? errorRunsOf(db, [e.id]) : Promise.resolve([]),
    failed ? mcpServersOf(db, versionIds) : Promise.resolve([]),
  ]);
  const counts = countRuns(runs);
  const names = new Map(configs.map((c) => [c.ref.versionId, c.ref.name]));
  const live = new Map<string, LiveRun>(
    runs.map((run) => [
      run.id,
      {
        id: run.id,
        status: run.status,
        attempt: run.attemptCount,
        primaryScore: run.primary,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        feed: feedEntryOf(run, names.get(run.configurationVersionId) ?? ''),
      },
    ]),
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

  constructor(@Inject(DB) private readonly db: AppDb) {}

  async version(experimentId: string): Promise<string | null> {
    const [row] = await this.db
      .select({
        revision: experiments.resultsRevision,
        status: experiments.status,
        pauseReason: experiments.pauseReason,
        failure: experiments.failure,
      })
      .from(experiments)
      .where(eq(experiments.id, experimentId));
    if (!row) return null;
    return JSON.stringify([row.revision, row.status, row.pauseReason, row.failure]);
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
    return readLiveState(this.db, e, configs);
  }

  forget(experimentId: string): void {
    this.configs.delete(experimentId);
  }
}
