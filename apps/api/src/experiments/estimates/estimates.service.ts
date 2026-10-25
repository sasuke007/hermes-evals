/**
 * GET /experiments/estimate and the per-run estimates New experiment and
 * launch reuse (plan 7.2). The maths is in ./per-run-estimate.ts; this
 * service loads what it needs: the suite directory, the configuration
 * versions, their history there and the current price table.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type {
  EstimateQuery,
  ExperimentEstimateView,
  PerRunEstimate,
  PriceTable,
} from '@hermes-evals/shared';
import type { Env } from '../../config/env.js';
import { loadVersionPairs } from '../../configurations/views.js';
import { DB } from '../../database/db.provider.js';
import { suites } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { effectiveBudgetS } from '../../execution/budget.js';
import { loadPriceTable } from '../../execution/pricing.js';
import { notFound } from '../commands/command-support.js';
import { attemptHistory, historyKey } from './estimate-history.js';
import { experimentEstimate, perRunEstimate, type MatrixShape } from './per-run-estimate.js';

/** What an estimate needs of a configuration version. */
export interface EstimatedVersion {
  versionId: string;
  /** The configuration's name, for the per-configuration rows. */
  name: string;
  configHash: string;
  model: string;
  timeBudgetS: number;
}

/** What an estimate needs of a suite version: the directory its history is matched on. */
export interface EstimatedSuite {
  suiteId: string;
  sourcePath: string;
}

@Injectable()
export class EstimatesService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    private readonly config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EstimatesService.name);
  }

  /**
   * The price table estimates use: PRICES_FILE as it is now. A file that
   * cannot be used prices nothing here, so estimates show "—", and is
   * logged; launch refuses it instead (LaunchService), since it would freeze.
   */
  async currentPrices(): Promise<PriceTable> {
    const path = this.config.get('PRICES_FILE', { infer: true });
    try {
      return await loadPriceTable(path);
    } catch (err) {
      this.logger.warn({ err, path }, 'price table unusable; estimates are unpriced');
      return { sha256: '0'.repeat(64), loaded_at: new Date().toISOString(), models: {} };
    }
  }

  /**
   * Per-run estimates of every version on every suite, in one history query:
   * versionId → suiteId → estimate.
   */
  async perRun(
    suiteList: readonly EstimatedSuite[],
    versions: readonly EstimatedVersion[],
    prices: PriceTable,
  ): Promise<Map<string, Map<string, PerRunEstimate>>> {
    const history = await attemptHistory(
      this.db,
      [...new Set(suiteList.map((s) => s.sourcePath))],
      [...new Set(versions.map((v) => v.configHash))],
    );
    return new Map(
      versions.map((v) => [
        v.versionId,
        new Map(
          suiteList.map((s) => [
            s.suiteId,
            perRunEstimate(
              {
                model: v.model,
                timeBudgetS: v.timeBudgetS,
                history: history.get(historyKey(s.sourcePath, v.configHash)) ?? null,
              },
              prices,
            ),
          ]),
        ),
      ]),
    );
  }

  /** The summary panel's figures for one suite and the chosen versions, in their order. */
  async forMatrix(
    suite: EstimatedSuite,
    versions: readonly EstimatedVersion[],
    shape: MatrixShape,
    prices: PriceTable,
  ): Promise<ExperimentEstimateView> {
    const perRun = await this.perRun([suite], versions, prices);
    return experimentEstimate(
      shape,
      versions.map((v) => ({
        versionId: v.versionId,
        name: v.name,
        estimate: perRun.get(v.versionId)!.get(suite.suiteId)!,
      })),
    );
  }

  /** GET /experiments/estimate. 404 for a suite or configuration version that does not exist. */
  async estimate(query: EstimateQuery): Promise<ExperimentEstimateView> {
    const [suite] = await this.db
      .select({ suiteId: suites.id, sourcePath: suites.sourcePath })
      .from(suites)
      .where(eq(suites.id, query.suiteId));
    if (!suite) throw notFound(`suite version ${query.suiteId}`);
    const pairs = new Map(
      (await loadVersionPairs(this.db, query.versionIds)).map((p) => [p.row.id, p]),
    );
    const versions = query.versionIds.map((id): EstimatedVersion => {
      const pair = pairs.get(id);
      if (!pair) throw notFound(`configuration version ${id}`);
      return {
        versionId: id,
        name: pair.configuration.name,
        configHash: pair.row.configHash,
        model: pair.row.model,
        // The form's override replaces the budget, as the launch and the runs do.
        timeBudgetS: effectiveBudgetS(pair.row.timeBudgetS, query.budgetS ?? null),
      };
    });
    return this.forMatrix(suite, versions, query, await this.currentPrices());
  }
}
