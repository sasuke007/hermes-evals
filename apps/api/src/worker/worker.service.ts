import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { SuiteReloadResult } from '@hermes-evals/shared';
import type { Env } from '../config/env.js';
import { DB } from '../database/db.provider.js';
import type { AppDb } from '../database/types.js';
import { QueueService } from '../queue/queue.service.js';
import { QUEUES, type EvaluateRunJob, type ExecuteRunJob } from '../queue/queues.js';
import { SandboxService } from '../sandbox/sandbox.service.js';
import { registerSuiteLoadHandler } from '../suites/loader/load-suites.handler.js';
import { SuiteLoaderService } from '../suites/loader/suite-loader.service.js';
import { RECONCILE_INTERVAL_MS, reconcileStaleMcpTests } from './handlers/stale-mcp-tests.js';
import { mcpTestSandbox, registerMcpTestHandler } from './handlers/test-mcp-server.js';
import { WorkerPresenceService } from './presence/worker-presence.service.js';

/**
 * How long a shutdown waits for the start-up suite load. Each directory is
 * one transaction, so a load cut short loses nothing; the next start or
 * reload finishes it.
 */
export const STARTUP_LOAD_SHUTDOWN_WAIT_MS = 10_000;

/**
 * Starts the worker, in this order, once migrations have run (DatabaseModule
 * initialises first):
 *
 * 1. the isolation self-test;
 * 2. presence: the workers row the API looks for before it sends a job;
 * 3. the handlers. load-suites and test-mcp-server register whatever the
 *    self-test found: loading needs no sandbox, and an MCP test on a worker
 *    without proven isolation answers "failed" saying so. execute-run
 *    registers only with isolation proven: there is no unsandboxed fallback;
 * 4. the start-up suite load (plan 4.4), in the background, so a slow
 *    verifier does not hold up the handlers. The loader runs one load at a
 *    time in this process, so a reload job waits for it rather than reading
 *    alongside it;
 * 5. the stale MCP test reconciler, now and every minute: a test whose
 *    worker died shows `failed`, not `running` for good.
 *
 * Execution (spawn Hermes in an isolated home, stream events, collect
 * artifacts) and evaluation (run scorers over saved evidence) are separate
 * jobs so grading can be retried without re-running the agent.
 */
@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private startupLoad: Promise<SuiteReloadResult | null> = Promise.resolve(null);
  private reconcileTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly queue: QueueService,
    private readonly sandbox: SandboxService,
    private readonly presence: WorkerPresenceService,
    private readonly suiteLoader: SuiteLoaderService,
    @Inject(DB) private readonly db: AppDb,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WorkerService.name);
  }

  async onModuleInit(): Promise<void> {
    if ((await this.queue.ping()) !== 'ok') {
      this.logger.warn(
        'queue not available; worker is idle until DATABASE_URL points at a reachable Postgres',
      );
      return;
    }
    const concurrency = this.config.get('WORKER_CONCURRENCY', { infer: true });
    const boss = this.queue.instance;

    const isolated = await this.sandbox.verify();
    await this.presence.start();

    await registerSuiteLoadHandler(boss, this.suiteLoader, this.logger);
    await registerMcpTestHandler(
      boss,
      { db: this.db, sandbox: mcpTestSandbox(this.sandbox) },
      this.logger,
    );

    // One job per handler call and WORKER_CONCURRENCY independent pollers:
    // a slot refills as soon as its job settles, and a throw fails only that job.
    const options = { batchSize: 1, localConcurrency: concurrency };

    if (isolated) {
      await boss.work<ExecuteRunJob>(QUEUES.executeRun, options, async ([job]) => {
        if (!job) return;
        this.logger.info(
          { runId: job.data.runId, attempt: job.data.attempt, trigger: job.data.trigger },
          'execute-run received',
        );
        // Hermes adapter is wired here in the execution slice.
      });
    } else {
      this.logger.error('execution disabled: trial isolation could not be proven on this machine');
    }

    await boss.work<EvaluateRunJob>(QUEUES.evaluateRun, options, async ([job]) => {
      if (!job) return;
      this.logger.info({ evaluationId: job.data.evaluationId }, 'evaluate-run received');
      // Scorer registry is wired here in the scoring slice.
    });

    this.startupLoad = this.loadSuitesAtStart();
    void this.reconcileMcpTests();
    this.reconcileTimer = setInterval(() => void this.reconcileMcpTests(), RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();
    this.logger.info({ concurrency, isolated }, 'worker ready');
  }

  /** Marks failed the MCP tests a dead worker left `running`; never rejects. */
  private async reconcileMcpTests(): Promise<void> {
    try {
      const changed = await reconcileStaleMcpTests(this.db, this.queue.instance);
      if (changed > 0) this.logger.warn({ changed }, 'marked MCP tests of a stopped worker failed');
    } catch (err) {
      this.logger.warn({ err }, 'could not check for stale MCP tests');
    }
  }

  /** The start-up load's result once it settles: null when it failed or did not run. */
  startupLoadSettled(): Promise<SuiteReloadResult | null> {
    return this.startupLoad;
  }

  /** Lets a start-up load in progress finish its directory, for a bounded time. */
  async onModuleDestroy(): Promise<void> {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), STARTUP_LOAD_SHUTDOWN_WAIT_MS);
    });
    const outcome = await Promise.race([this.startupLoad, waited]);
    clearTimeout(timer);
    if (outcome === 'timeout') this.logger.warn('shutting down during the start-up suite load');
  }

  /** Loads every suite directory; never rejects (loadAtStartup logs a failure). */
  private async loadSuitesAtStart(): Promise<SuiteReloadResult | null> {
    const result = await this.suiteLoader.loadAtStartup();
    if (result) {
      const outcomes: Record<string, number> = {};
      for (const entry of result.suites)
        outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1;
      this.logger.info({ directories: result.suites.length, outcomes }, 'suites loaded at start');
    }
    return result;
  }
}
