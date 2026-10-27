/**
 * GET /experiments/new-options: everything New experiment needs before the
 * user types anything (UI_FLOWS 11.1). Each suite directory at its current
 * version with every task (invalid ones with their reason, so the form can
 * disable them), each configuration at its latest version with the hash the
 * launch sends back, its per-run estimate on each suite and the MCP
 * variables it needs that are not set (Phase 6 S7: the form shows them and
 * disables Launch, as launch would answer 409), the concurrency the proven
 * workers allow, and the price table.
 *
 * Also what the mock-judge warning needs (Phase 8 G2): each task's
 * `hasLlmJudge`, each configuration's `mockModel` and the platform judge, so
 * the form computes the shared mockJudgeWarning as the user chooses, with
 * the values the launch uses for its own warning.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isMockModelRoute,
  type NewExperimentConfigOption,
  type NewExperimentOptions,
  type NewExperimentSuiteOption,
  type PriceTable,
} from '@hermes-evals/shared';
import type { Env } from '../../config/env.js';
import { buildVersions, loadLatestPairs } from '../../configurations/views.js';
import { DB } from '../../database/db.provider.js';
import type { AppDb } from '../../database/types.js';
import { hasLlmJudge, judgeViewFrom } from '../../providers/judge-view.js';
import { MAX_RUN_BUDGET_SECONDS } from '../../queue/queues.js';
import { unsetMcpVariablesByVersion } from '../../resources/secrets/unset-variables.js';
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
    private readonly config: ConfigService<Env, true>,
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
    const unset = await unsetMcpVariablesByVersion(
      this.db,
      versions.map(({ row }) => row.id),
    );

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
          hasLlmJudge: hasLlmJudge(t.verification),
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
      mockModel: isMockModelRoute(row),
      memoryEnabled: view.memoryEnabled,
      skills: view.skills.map((s) => `${s.name}@${s.version}`),
      skillLoading: view.skillLoading,
      mcpServers: view.mcpServers.map((m) => `${m.name} (${m.transport})`),
      missingSecrets: unset.get(row.id) ?? [],
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
      judge: judgeViewFrom(this.config),
    };
  }
}
