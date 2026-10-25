/**
 * POST /experiments (plan 7.1, UI_FLOWS 11.2, E7).
 *
 * Before the transaction, in this order: the body must name a suite version,
 * valid tasks of it and configuration versions that exist (400 with one
 * issue per problem); a connected worker must have proven isolation, and the
 * proven workers must run one Hermes revision; every configuration's provider
 * must be ready (409 with the reason the form shows, e.g. "Nous Portal is not
 * connected"). An estimate over the spend ceiling does not block: the spend
 * guard pauses at the ceiling (UI_FLOWS 19 #10).
 *
 * Then one transaction, rows and jobs together or nothing:
 * 1. Freeze the versions in their own statement. Its row locks order the
 *    launch against an in-place edit (PUT /configurations/:id locks the
 *    version FOR UPDATE): an edit in flight finishes first and the launch
 *    then sees its new hash, or the launch freezes first and the edit becomes
 *    the next version. No configurations row is locked after this, or the
 *    launch could deadlock with that edit.
 * 2. Re-read the hashes FOR SHARE and compare with expectedConfigHashes and
 *    the latest version of each configuration: 409 naming what changed.
 * 3. Insert the experiment with its frozen snapshot (Hermes build of the
 *    proven workers, price table, estimate) and the concurrency capped by
 *    their slots; the launch trigger re-checks frozen versions and valid tasks.
 * 4. Insert tasks × versions × repetitions queued runs.
 * 5. Send one execute-run job per run, key `runId:1`, trigger initial.
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  LaunchExperimentInput,
  LaunchExperimentResult,
  PriceTable,
} from '@hermes-evals/shared';
import type { Env } from '../../config/env.js';
import { loadVersionPairs, type VersionPair } from '../../configurations/views.js';
import { DB } from '../../database/db.provider.js';
import {
  configurations,
  configurationVersions,
  experiments,
  runs,
  suites,
  tasks,
} from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import { effectiveBudgetS } from '../../execution/budget.js';
import { loadPriceTable } from '../../execution/pricing.js';
import { QueueService } from '../../queue/queue.service.js';
import { serverError } from '../../suites/http-errors.js';
import { EstimatesService } from '../estimates/estimates.service.js';
import { estimateSnapshot } from '../estimates/per-run-estimate.js';
import { bossOf, conflict } from './command-support.js';
import { sendExecuteRuns } from './jobs.js';
import { launchHermes, liveWorkers } from './live-workers.js';
import { blockedMessage, ProviderGate } from './provider-gate.js';

type SuiteRow = typeof suites.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

/** Runs inserted per statement, well under Postgres's 65,535 parameters. */
const RUN_INSERT_CHUNK = 1000;

/** What the body names, resolved against the database. */
interface ResolvedLaunch {
  suite: SuiteRow;
  /** The selected tasks, in the suite's display order. */
  tasks: TaskRow[];
  /** Baseline first, then the candidates in the order given. */
  versions: VersionPair[];
}

interface Issue {
  path: string;
  message: string;
}

const invalidBody = (issues: Issue[]): BadRequestException =>
  new BadRequestException({ statusCode: 400, message: 'Validation failed', issues });

@Injectable()
export class LaunchService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    private readonly queue: QueueService,
    private readonly gate: ProviderGate,
    private readonly estimates: EstimatesService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async launch(input: LaunchExperimentInput): Promise<LaunchExperimentResult> {
    const resolved = await this.resolve(input);
    const workersNow = await liveWorkers(this.db);
    const hermes = launchHermes(workersNow);
    if (!hermes.ok) throw conflict(hermes.reason);
    const blocks = await this.gate.blocked(resolved.versions.map((v) => v.row.provider));
    if (blocks.length > 0) throw conflict(blockedMessage(blocks));
    const prices = await this.priceSnapshot();
    const concurrency = Math.min(input.concurrency, workersNow.capacity);
    // The snapshot the experiment keeps: with an override every run gets that budget
    // (execution/budget.ts), so a configuration without history falls back to a quarter of it.
    const estimate = await this.estimates.forMatrix(
      { suiteId: resolved.suite.id, sourcePath: resolved.suite.sourcePath },
      resolved.versions.map(({ configuration, row }) => ({
        versionId: row.id,
        name: configuration.name,
        configHash: row.configHash,
        model: row.model,
        timeBudgetS: effectiveBudgetS(row.timeBudgetS, input.timeBudgetOverrideS),
      })),
      { taskCount: resolved.tasks.length, repetitions: input.repetitions, concurrency },
      prices,
    );
    const boss = bossOf(this.queue);

    return this.db.transaction(async (tx) => {
      const versionIds = resolved.versions.map((v) => v.row.id);
      await tx
        .update(configurationVersions)
        .set({ frozenAt: sql`now()` })
        .where(
          and(
            inArray(configurationVersions.id, versionIds),
            isNull(configurationVersions.frozenAt),
          ),
        );
      await this.assertUnchanged(tx, resolved.versions, input.expectedConfigHashes);

      const [experiment] = await tx
        .insert(experiments)
        .values({
          name: input.name,
          description: input.description.trim() === '' ? null : input.description,
          suiteId: resolved.suite.id,
          taskIds: resolved.tasks.map((t) => t.id),
          baselineVersionId: input.baselineVersionId,
          candidateVersionIds: input.candidateVersionIds,
          repetitions: input.repetitions,
          concurrency,
          spendCeilingUsd: input.spendCeilingUsd,
          timeBudgetOverrideS: input.timeBudgetOverrideS,
          hermesVersion: hermes.version,
          hermesRevision: hermes.revision,
          priceTable: prices,
          estimate: estimateSnapshot(estimate),
        })
        .returning({ id: experiments.id });
      const experimentId = experiment!.id;

      const matrix = resolved.tasks.flatMap((task) =>
        versionIds.flatMap((configurationVersionId) =>
          Array.from({ length: input.repetitions }, (_, i) => ({
            experimentId,
            taskId: task.id,
            configurationVersionId,
            repetition: i + 1,
            nextTrigger: 'initial' as const,
          })),
        ),
      );
      const runIds: string[] = [];
      for (let i = 0; i < matrix.length; i += RUN_INSERT_CHUNK) {
        const inserted = await tx
          .insert(runs)
          .values(matrix.slice(i, i + RUN_INSERT_CHUNK))
          .returning({ id: runs.id });
        runIds.push(...inserted.map((r) => r.id));
      }

      const sent = await sendExecuteRuns(
        boss,
        tx,
        runIds.map((runId) => ({ runId, attempt: 1, trigger: 'initial' as const })),
      );
      // Fresh run ids cannot collide with a live job; a shortfall means the queue refused.
      if (sent !== runIds.length) {
        throw new Error(`launch sent ${sent} of ${runIds.length} execute-run jobs`);
      }
      return { id: experimentId };
    });
  }

  /** The suite version, tasks and configuration versions the body names; 400 for any that do not resolve. */
  private async resolve(input: LaunchExperimentInput): Promise<ResolvedLaunch> {
    const issues: Issue[] = [];
    const [suite] = await this.db.select().from(suites).where(eq(suites.id, input.suiteId));
    let chosen: TaskRow[] = [];
    if (!suite) {
      issues.push({ path: 'suiteId', message: `suite version ${input.suiteId} does not exist` });
    } else {
      const all = await this.db
        .select()
        .from(tasks)
        .where(eq(tasks.suiteId, suite.id))
        .orderBy(asc(tasks.position));
      const byKey = new Map(all.map((t) => [t.key, t]));
      input.taskKeys.forEach((key, i) => {
        const task = byKey.get(key);
        if (!task) {
          issues.push({
            path: `taskKeys.${i}`,
            message: `${key} is not a task of ${suite.name} v${suite.versionNumber}`,
          });
        } else if (!task.valid) {
          issues.push({
            path: `taskKeys.${i}`,
            message: `${key} is invalid and cannot run: ${task.invalidReason ?? 'self-check failed'}`,
          });
        }
      });
      const keys = new Set(input.taskKeys);
      chosen = all.filter((t) => keys.has(t.key) && t.valid);
    }

    const ids = [input.baselineVersionId, ...input.candidateVersionIds];
    const pairs = new Map((await loadVersionPairs(this.db, ids)).map((p) => [p.row.id, p]));
    const versions: VersionPair[] = [];
    ids.forEach((id, i) => {
      const pair = pairs.get(id);
      if (pair) versions.push(pair);
      else {
        issues.push({
          path: i === 0 ? 'baselineVersionId' : `candidateVersionIds.${i - 1}`,
          message: `configuration version ${id} does not exist`,
        });
      }
    });

    if (issues.length > 0 || !suite) throw invalidBody(issues);
    return { suite, tasks: chosen, versions };
  }

  /**
   * 409 when a version's hash is not the one the form showed, or its
   * configuration has a newer version. Reads the hashes FOR SHARE after the
   * freeze, then the latest version numbers in a later statement, so an edit
   * that committed while this waited on a row lock is seen.
   */
  private async assertUnchanged(
    tx: AppTx,
    versions: readonly VersionPair[],
    expected: Readonly<Record<string, string>>,
  ): Promise<void> {
    const ids = versions.map((v) => v.row.id);
    const current = await tx
      .select({
        id: configurationVersions.id,
        configurationId: configurationVersions.configurationId,
        version: configurationVersions.version,
        configHash: configurationVersions.configHash,
      })
      .from(configurationVersions)
      .where(inArray(configurationVersions.id, ids))
      .orderBy(asc(configurationVersions.id))
      .for('share');
    const latest = new Map(
      (
        await tx
          .select({
            id: configurations.id,
            name: configurations.name,
            latestVersion: configurations.latestVersion,
          })
          .from(configurations)
          .where(inArray(configurations.id, [...new Set(current.map((c) => c.configurationId))]))
      ).map((c) => [c.id, c]),
    );
    const byId = new Map(current.map((c) => [c.id, c]));
    const changed: string[] = [];
    for (const { row } of versions) {
      const now = byId.get(row.id);
      const configuration = now ? latest.get(now.configurationId) : undefined;
      if (!now || !configuration) continue;
      const newer = configuration.latestVersion > now.version;
      if (now.configHash !== expected[row.id] || newer) {
        changed.push(
          `configuration ${configuration.name} changed since you opened this form` +
            (newer ? ` (now v${configuration.latestVersion})` : ''),
        );
      }
    }
    if (changed.length > 0) throw conflict(changed.join('; '));
  }

  /** The price table the experiment freezes. A file that exists but cannot be used is a 500. */
  private async priceSnapshot(): Promise<PriceTable> {
    const path = this.config.get('PRICES_FILE', { infer: true });
    try {
      return await loadPriceTable(path);
    } catch (err) {
      throw serverError(
        `the price table cannot be used, so nothing was launched: ${(err as Error).message}`,
      );
    }
  }
}
