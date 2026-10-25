/**
 * GET /experiments/new-options: everything New experiment needs before the
 * user types anything (UI_FLOWS 11.1). Each suite directory at its current
 * version with every task (invalid ones with their reason, so the form can
 * disable them), each configuration at its latest version with the hash the
 * launch sends back and its per-run estimate on each suite, the concurrency
 * the proven workers allow, and the price table.
 */
import { Inject, Injectable } from '@nestjs/common';
import type {
  NewExperimentConfigOption,
  NewExperimentOptions,
  NewExperimentSuiteOption,
  PriceTable,
} from '@hermes-evals/shared';
import { buildVersions, loadLatestPairs } from '../../configurations/views.js';
import { DB } from '../../database/db.provider.js';
import type { AppDb } from '../../database/types.js';
import { MAX_RUN_BUDGET_SECONDS } from '../../queue/queues.js';
import { currentSuites, tasksOf } from '../../suites/suites.queries.js';
import { suiteDisplayPath } from '../../suites/views/format.js';
import { limitsOf, type TaskRow } from '../../suites/views/rows.js';
import { suiteListRow, suiteRef } from '../../suites/views/suite-views.js';
import { EstimatesService } from '../estimates/estimates.service.js';
import { liveWorkers } from './live-workers.js';

/** The form's starting values (the design's: 5 repetitions, 3 at a time). */
export const NEW_EXPERIMENT_DEFAULTS = { repetitions: 5, concurrency: 3 } as const;

/**
 * The time budget a suite's tasks use, for the override field's help line:
 * the longest of its valid tasks (of any task when none is valid). Every
 * stored valid task has one; MAX_RUN_BUDGET_SECONDS only for a suite whose
 * tasks state none.
 */
export function suiteBudgetS(taskRows: readonly TaskRow[]): number {
  const valid = taskRows.filter((t) => t.valid);
  const budgets = (valid.length > 0 ? valid : taskRows).flatMap((t) => {
    const budget = limitsOf(t).budgetS;
    return budget === null ? [] : [budget];
  });
  return budgets.length > 0 ? Math.max(...budgets) : MAX_RUN_BUDGET_SECONDS;
}

/** The price table as the form's cost hints list it. */
export const priceEntries = (prices: PriceTable): NewExperimentOptions['priceTable'] =>
  Object.entries(prices.models).map(([model, price]) => ({
    model,
    inputPer1M: price.input_per_1m,
    outputPer1M: price.output_per_1m,
    checkedAt: price.checked_at,
  }));

@Injectable()
export class NewOptionsService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    private readonly estimates: EstimatesService,
  ) {}

  async options(): Promise<NewExperimentOptions> {
    // Sequential: one client per request, and each read is small.
    const current = await currentSuites(this.db);
    const taskRows = await tasksOf(
      this.db,
      current.map((c) => c.suite.id),
    );
    const versions = await buildVersions(this.db, await loadLatestPairs(this.db));
    const prices = await this.estimates.currentPrices();
    const perRun = await this.estimates.perRun(
      current.map(({ suite }) => ({ suiteId: suite.id, sourcePath: suite.sourcePath })),
      versions.map(({ configuration, row }) => ({
        versionId: row.id,
        name: configuration.name,
        configHash: row.configHash,
        model: row.model,
        timeBudgetS: row.timeBudgetS,
      })),
      prices,
    );
    const workersNow = await liveWorkers(this.db);

    const suiteOptions = current.map(({ source, suite }): NewExperimentSuiteOption => {
      const own = taskRows.filter((t) => t.suiteId === suite.id);
      return {
        ...suiteRef(suite),
        path: suiteDisplayPath(suite.sourcePath),
        selfCheckAt: suiteListRow(suite, source, own).loadedAt,
        taskCount: suite.taskCount,
        validCount: suite.validCount,
        budgetS: suiteBudgetS(own),
        tasks: own.map((t) => ({
          key: t.key,
          version: t.versionNumber,
          summary: t.summary ?? '',
          verificationCount: t.verification.length,
          valid: t.valid,
          invalidReason: t.valid ? null : (t.invalidReason ?? 'invalid'),
        })),
      };
    });

    const configurationOptions = versions.map(({ view, row }): NewExperimentConfigOption => ({
      configurationId: view.configurationId,
      versionId: view.versionId,
      name: view.name,
      version: view.version,
      configHash: view.configHash,
      model: view.model,
      provider: view.provider,
      memoryEnabled: view.memoryEnabled,
      skills: view.skills.map((s) => `${s.name}@${s.version}`),
      mcpServers: view.mcpServers.map((m) => `${m.name} (${m.transport})`),
      estimates: Object.fromEntries(perRun.get(row.id) ?? new Map()),
    }));

    return {
      suites: suiteOptions,
      configurations: configurationOptions,
      defaults: {
        repetitions: NEW_EXPERIMENT_DEFAULTS.repetitions,
        concurrency:
          workersNow.capacity > 0
            ? Math.min(NEW_EXPERIMENT_DEFAULTS.concurrency, workersNow.capacity)
            : NEW_EXPERIMENT_DEFAULTS.concurrency,
      },
      maxConcurrency: workersNow.capacity,
      workerCount: workersNow.live.length,
      priceTable: priceEntries(prices),
    };
  }
}
