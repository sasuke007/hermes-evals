/**
 * The Experiment list and the experiment detail page with its Overview
 * (GET /experiments, GET /experiments/:id; plan 7 and 11, UI_FLOWS 14).
 * Reads rows with queries.ts and hands them to the pure builders beside it;
 * every answer parses with its shared schema before it leaves.
 */
import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  ExperimentDetailSchema,
  ExperimentListRowSchema,
  type ExperimentDetail,
  type ExperimentListRow,
} from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import type { AppDb } from '../../database/types.js';
import { suiteRef } from '../../suites/views/suite-views.js';
import { ComparisonService } from '../comparison/comparison.service.js';
import type { VerdictFigures } from '../comparison/verdicts.js';
import type { ConfigFacts } from './facts.js';
import { failureView, statusReason } from './failure.js';
import { knownCost, spendView, type ModelsByVersion } from './money.js';
import { experimentNotFound } from './not-found.js';
import { doneRuns } from './numbers.js';
import { aggregateOf, countRuns, feedOf, progressOf } from './progress.js';
import {
  armMoneyOf,
  errorRunsOf,
  experimentById,
  experimentsNewestFirst,
  lastEventAtOf,
  mcpServersOf,
  runCountsOf,
  runFactsOf,
  suitesOf,
  versionFactsOf,
  workerFactsOf,
  type ErrorRunFacts,
  type ExperimentRow,
  type SuiteRow,
} from './queries.js';
import { configDifferences, experimentConfigs, hermesView, suiteSnapshot } from './snapshot.js';
import { elapsedSeconds, remainingSeconds } from './timing.js';
import { listVerdicts, needsFigures, verdictSummaries } from './verdicts.js';

/** The score key the Overview's verdicts are computed on: each task's primary key. */
const SCORE_KEY = 'primary';

export { experimentNotFound };

const modelsOf = (configs: readonly ConfigFacts[]): ModelsByVersion =>
  new Map(configs.map((c) => [c.ref.versionId, c.ref.model]));

const versionIdsOf = (e: ExperimentRow): string[] => [
  e.baselineVersionId,
  ...e.candidateVersionIds,
];

const sum = (counts: Record<string, number>): number =>
  Object.values(counts).reduce((a, b) => a + b, 0);

function suiteOf(suites: ReadonlyMap<string, SuiteRow>, e: ExperimentRow): SuiteRow {
  const suite = suites.get(e.suiteId);
  if (!suite) throw new Error(`suite version ${e.suiteId} of experiment ${e.id} does not exist`);
  return suite;
}

@Injectable()
export class ExperimentViewsService {
  /** Verdict figures, cached by results revision; shared with the comparison when ComparisonModule is loaded. */
  private readonly comparisons: ComparisonService;

  constructor(
    @Inject(DB) private readonly db: AppDb,
    @Optional() @Inject(ComparisonService) comparisons?: ComparisonService,
  ) {
    this.comparisons = comparisons ?? new ComparisonService(db);
  }

  /** The current figures of the experiments whose verdicts need them, by id. */
  private async figuresOf(
    rows: readonly ExperimentRow[],
  ): Promise<Map<string, VerdictFigures | null>> {
    const entries = await Promise.all(
      rows.map(async (e) => [e.id, await this.comparisons.verdictFigures(e.id)] as const),
    );
    return new Map(entries);
  }

  /** GET /experiments: every experiment, newest first, in a fixed number of queries. */
  async list(): Promise<ExperimentListRow[]> {
    const rows = await experimentsNewestFirst(this.db);
    const ids = rows.map((e) => e.id);
    const failedIds = rows.filter((e) => e.status === 'failed').map((e) => e.id);
    const [versions, suites, counts, money, errorRuns, figures] = await Promise.all([
      versionFactsOf(this.db, rows.flatMap(versionIdsOf)),
      suitesOf(
        this.db,
        rows.map((e) => e.suiteId),
      ),
      runCountsOf(this.db, ids),
      armMoneyOf(this.db, ids),
      errorRunsOf(this.db, failedIds),
      // Only a completed experiment's chips show, and its history has them
      // unless it completed before verdict entries were recorded.
      this.figuresOf(rows.filter(needsFigures)),
    ]);
    return rows.map((e) => {
      const configs = experimentConfigs(e, versions);
      const runCounts = counts.get(e.id)!;
      const totalRuns = sum(runCounts);
      const failure =
        e.status !== 'failed' || e.failure === null
          ? null
          : failureView(
              e.failure,
              errorRuns.filter((r) => r.experimentId === e.id),
              [],
            );
      return ExperimentListRowSchema.parse({
        id: e.id,
        name: e.name,
        status: e.status,
        pauseReason: e.pauseReason,
        statusReason: statusReason({
          status: e.status,
          pauseReason: e.pauseReason,
          cancelledAt: e.cancelledAt,
          ceilingUsd: e.spendCeilingUsd,
          counts: runCounts,
          totalRuns,
          providers: configs.map((c) => c.ref.provider),
          failure,
        }),
        suite: suiteRef(suiteOf(suites, e)),
        baseline: configs[0]!.ref,
        candidates: configs.slice(1).map((c) => c.ref),
        repetitions: e.repetitions,
        totalRuns,
        doneRuns: doneRuns(e.status, runCounts),
        counts: runCounts,
        verdicts: listVerdicts({
          status: e.status,
          verdictHistory: e.verdictHistory,
          configs,
          figures: figures.get(e.id) ?? null,
        }),
        createdAt: e.createdAt.toISOString(),
        costUsd: knownCost(e.priceTable, modelsOf(configs), versionIdsOf(e), money.get(e.id) ?? []),
      } satisfies ExperimentListRow);
    });
  }

  /** GET /experiments/:id: 404 for an unknown id. `now` is the clock the elapsed time runs to. */
  async detail(id: string, now: Date = new Date()): Promise<ExperimentDetail> {
    const e = await experimentById(this.db, id);
    if (!e) throw experimentNotFound(id);
    const [versions, suites] = await Promise.all([
      versionFactsOf(this.db, versionIdsOf(e)),
      suitesOf(this.db, [e.suiteId]),
    ]);
    const configs = experimentConfigs(e, versions);
    // The breaker's failure is shown while the experiment is failed; retry-failed resumes it.
    const failed = e.status === 'failed' && e.failure !== null;
    const [runs, money, suite, differences, lastEventAt, worker, errorRuns, mcpServers, figures] =
      await Promise.all([
        runFactsOf(this.db, e.id),
        armMoneyOf(this.db, [e.id]).then((m) => m.get(e.id) ?? []),
        suiteSnapshot(this.db, suiteOf(suites, e), e.taskIds),
        configDifferences(this.db, e.baselineVersionId, e.candidateVersionIds),
        lastEventAtOf(this.db, e.id),
        workerFactsOf(this.db, e.id),
        failed ? errorRunsOf(this.db, [e.id]) : Promise.resolve<ErrorRunFacts[]>([]),
        failed ? mcpServersOf(this.db, versionIdsOf(e)) : Promise.resolve([]),
        // Provisional figures until it completes; then the history, unless it lacks a candidate.
        e.status !== 'completed' || needsFigures(e)
          ? this.comparisons.verdictFigures(e.id)
          : Promise.resolve(null),
      ]);
    const counts = countRuns(runs);
    const models = modelsOf(configs);
    const names = new Map(configs.map((c) => [c.ref.versionId, c.ref.name]));
    return ExperimentDetailSchema.parse({
      id: e.id,
      name: e.name,
      description: e.description ?? '',
      status: e.status,
      pauseReason: e.pauseReason,
      pausedAt: e.pausedAt?.toISOString() ?? null,
      createdAt: e.createdAt.toISOString(),
      finishedAt: e.finishedAt?.toISOString() ?? null,
      cancelledAt: e.cancelledAt?.toISOString() ?? null,
      elapsedS: elapsedSeconds(e, now),
      remainingEstimateS: remainingSeconds({
        status: e.status,
        concurrency: e.concurrency,
        counts,
        estimate: e.estimate,
        runs,
        configs,
        timeBudgetOverrideS: e.timeBudgetOverrideS,
      }),
      lastEventAt: lastEventAt?.toISOString() ?? null,
      suite,
      baseline: configs[0]!.ref,
      candidates: configs.slice(1).map((c) => c.ref),
      differences,
      hermes: hermesView(e.hermesVersion, e.hermesRevision),
      scoreKey: SCORE_KEY,
      repetitions: e.repetitions,
      concurrency: e.concurrency,
      timeBudgetOverrideS: e.timeBudgetOverrideS,
      totalRuns: runs.length,
      counts,
      spend: spendView({
        status: e.status,
        ceilingUsd: e.spendCeilingUsd,
        priceTable: e.priceTable,
        estimate: e.estimate,
        models,
        arms: money,
        runs,
      }),
      perConfiguration: configs.map((c) => progressOf(c, runs)),
      feed: feedOf(runs, names),
      verdicts: verdictSummaries({
        status: e.status,
        verdictHistory: e.verdictHistory,
        configs,
        figures,
      }),
      aggregates: configs.map((c) =>
        aggregateOf(c, runs, { priceTable: e.priceTable, models, arms: money }),
      ),
      failure: failed && e.failure ? failureView(e.failure, errorRuns, mcpServers) : null,
      worker: {
        connected: worker.connected,
        lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString() ?? null,
        workerLostRuns: worker.workerLostRuns,
      },
    } satisfies ExperimentDetail);
  }
}
