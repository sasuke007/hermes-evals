import { join } from 'node:path';
import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { HERMES_REVISION, type Provider, type SuiteReloadResult } from '@hermes-evals/shared';
import type { Env } from '../config/env.js';
import { DB } from '../database/db.provider.js';
import type { AppDb } from '../database/types.js';
import { registerEvaluationHandlers } from '../evaluation/evaluate-run.handler.js';
import { TrialAttemptRunner } from '../execution/attempt/index.js';
import {
  drizzlePoolRecoveryLock,
  lifecycleSettingsFromEnv,
  startExecutionLifecycle,
  type ExecutionLifecycle,
} from '../execution/lifecycle/index.js';
import type { RecoveryReport } from '../execution/lifecycle/recovery.js';
import { slotLeaseSource } from '../execution/slots.js';
import { PROVIDER_READINESS_DEPS } from '../experiments/commands/provider-gate.js';
import {
  providerReadiness,
  type ProviderReadiness,
  type ProviderReadinessDeps,
} from '../providers/readiness.js';
import { QueueService } from '../queue/queue.service.js';
import { SandboxService } from '../sandbox/sandbox.service.js';
import { StorageService } from '../storage/storage.service.js';
import { registerSuiteLoadHandler } from '../suites/loader/load-suites.handler.js';
import { SuiteLoaderService } from '../suites/loader/suite-loader.service.js';
import { freeSlotSource, type SlotLease } from './handlers/mcp-test-container.js';
import { RECONCILE_INTERVAL_MS, reconcileStaleMcpTests } from './handlers/stale-mcp-tests.js';
import { mcpTestSandbox, registerMcpTestHandler } from './handlers/test-mcp-server.js';
import {
  HEARTBEAT_INTERVAL_MS,
  WorkerPresenceService,
} from './presence/worker-presence.service.js';

/**
 * How long a shutdown waits for the start-up suite load. Each directory is
 * one transaction, so a load cut short loses nothing; the next start or
 * reload finishes it.
 */
export const STARTUP_LOAD_SHUTDOWN_WAIT_MS = 10_000;

/**
 * How long a shutdown's last recovery pass may take. It confirms through the
 * engine that the attempts this worker handed back have no container left
 * before it ends them; past this, they are left to the next start.
 */
export const SHUTDOWN_RECOVERY_WAIT_MS = 20_000;

/**
 * Starts the worker, in this order, once migrations have run (DatabaseModule
 * initialises first):
 *
 * 1. the isolation self-test;
 * 2. presence: the workers row the API looks for before it sends a job;
 * 3. the handlers:
 *    - the execution lifecycle (lifecycle.ts): the lease keeper (10 s
 *      heartbeat renewal and the cancel watcher), one recovery pass, the
 *      execute-run handler and the recovery loop. execute-run is consumed
 *      only with isolation proven, the trial image on this build's Hermes
 *      revision, and the Docker daemon's id known: there is no unsandboxed
 *      fallback. Recovery runs whatever the sandbox state, because most of
 *      it is database work. The provider guard asks this worker's own
 *      egress, live, which keys it holds (readiness.ts);
 *    - evaluate-run and evaluate-run-dead, whatever the sandbox state:
 *      scoring reads stored evidence and runs verifier scripts in this
 *      process, outside any trial (plan 14);
 *    - load-suites and test-mcp-server, which register whatever the
 *      self-test found: loading needs no sandbox, and an MCP test on a
 *      worker without proven isolation answers "failed" saying so. An http
 *      test borrows its slot network from the lifecycle's pool, so tests
 *      and trials never share one (E9);
 * 4. the start-up suite load (plan 4.4), in the background, so a slow
 *    verifier does not hold up the handlers. The loader runs one load at a
 *    time in this process, so a reload job waits for it rather than reading
 *    alongside it;
 * 5. the stale MCP test reconciler, now and every minute: a test whose
 *    worker died shows `failed`, not `running` for good.
 *
 * Shutdown never leaves a trial container without an owner. The lifecycle
 * stops taking jobs and aborts every running attempt, whose runner stops and
 * removes its container and hands the attempt back. Presence then marks the
 * worker stopped, and one last recovery pass ends those attempts as
 * `execution_error · worker_lost` and requeues their runs under the recovery
 * rules (plan 8.6), but only once the engine confirms each run has no
 * container left. Whatever that pass cannot confirm in time stays revoked
 * and `running`, and the next recovery pass on this daemon (the next start
 * of this worker) finishes it.
 */
@Injectable()
export class WorkerService implements OnModuleInit, OnModuleDestroy {
  private startupLoad: Promise<SuiteReloadResult | null> = Promise.resolve(null);
  private reconcileTimer: NodeJS.Timeout | null = null;
  private lifecycleTimer: NodeJS.Timeout | null = null;
  private lifecycle: ExecutionLifecycle | null = null;
  private lifecycleStarting: Promise<void> | null = null;
  private isolated = false;
  private stopping = false;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly queue: QueueService,
    private readonly sandbox: SandboxService,
    private readonly presence: WorkerPresenceService,
    private readonly suiteLoader: SuiteLoaderService,
    private readonly storage: StorageService,
    @Inject(PROVIDER_READINESS_DEPS) private readonly readinessDeps: ProviderReadinessDeps,
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

    this.isolated = await this.sandbox.verify();
    await this.presence.start();
    if (!this.isolated) {
      this.logger.error('execution disabled: trial isolation could not be proven on this machine');
    }
    // Presence logged why (the image's revision label); its report says `failed`.
    if (!this.presence.imageMatchesBuild) this.isolated = false;

    await this.startLifecycleOnceRegistered();
    // Scoring needs no sandbox: it registers whatever the self-test found.
    await registerEvaluationHandlers(
      boss,
      { db: this.db, store: this.storage },
      this.logger,
      concurrency,
    );
    await registerSuiteLoadHandler(boss, this.suiteLoader, this.logger);
    await registerMcpTestHandler(
      boss,
      { db: this.db, sandbox: mcpTestSandbox(this.sandbox, () => this.acquireSlot()) },
      this.logger,
    );

    this.startupLoad = this.loadSuitesAtStart();
    void this.reconcileMcpTests();
    this.reconcileTimer = setInterval(() => void this.reconcileMcpTests(), RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();
    this.logger.info(
      { concurrency, isolated: this.isolated, executing: this.lifecycle?.workId != null },
      'worker ready',
    );
  }

  /** The execution lifecycle once started; null before, without a workers row, or after shutdown. */
  get execution(): ExecutionLifecycle | null {
    return this.lifecycle;
  }

  /** The start-up load's result once it settles: null when it failed or did not run. */
  startupLoadSettled(): Promise<SuiteReloadResult | null> {
    return this.startupLoad;
  }

  /**
   * Starts the lifecycle now if presence has its workers row, and otherwise
   * on the first heartbeat that inserts it: leases and recovery are keyed by
   * that row, and presence retries the insert on every beat.
   */
  private async startLifecycleOnceRegistered(): Promise<void> {
    if (this.presence.id) return this.startLifecycle(this.presence.id);
    this.logger.error('no workers row yet (presence registration failed); execution waits for it');
    this.lifecycleTimer = setInterval(() => {
      const workerId = this.presence.id;
      if (!workerId || this.lifecycleStarting || this.stopping) return;
      if (this.lifecycleTimer) clearInterval(this.lifecycleTimer);
      this.lifecycleTimer = null;
      this.lifecycleStarting = this.startLifecycle(workerId).catch((err: unknown) =>
        this.logger.error({ err }, 'could not start the execution lifecycle'),
      );
    }, HEARTBEAT_INTERVAL_MS);
    this.lifecycleTimer.unref();
  }

  private async startLifecycle(workerId: string): Promise<void> {
    let hostId: string | null = null;
    try {
      hostId = (await this.sandbox.engine.info()).ID;
    } catch (err) {
      this.logger.warn(
        { err },
        'cannot read the Docker daemon id; execution and container recovery are off',
      );
    }
    const setting = <K extends keyof Env>(key: K): Env[K] => this.config.get(key, { infer: true });
    const lifecycle = await startExecutionLifecycle({
      boss: this.queue.instance,
      db: this.db,
      runner:
        this.isolated && hostId
          ? new TrialAttemptRunner({
              engine: this.sandbox.engine,
              egress: this.sandbox.egress,
              blobs: this.storage,
              skillsDir: join(this.storage.dataDir, 'skills'),
              image: this.sandbox.image,
              volume: this.sandbox.volume,
              hostId,
              logger: this.logger,
            })
          : null,
      engine: hostId ? this.sandbox.engine : null,
      egress: this.sandbox.egress,
      // This worker's own egress decides key providers and host mode, asked live; an egress
      // that does not answer throws, and the job is deferred rather than the experiment paused.
      readiness: (provider: Provider): Promise<ProviderReadiness> =>
        providerReadiness(this.db, provider, {
          ...this.readinessDeps,
          egressEnvNames: () => this.sandbox.egress.envNames(),
          egressHealth: () => this.sandbox.egress.healthReport(),
        }),
      workerId,
      hostId,
      hermesRevision: HERMES_REVISION,
      trialsDir: this.sandbox.trialsDir,
      trialSlots: this.sandbox.slots,
      recoveryLock: drizzlePoolRecoveryLock(this.db),
      logger: this.logger,
      settings: lifecycleSettingsFromEnv({
        WORKER_CONCURRENCY: setting('WORKER_CONCURRENCY'),
        LEASE_SECONDS: setting('LEASE_SECONDS'),
        MAX_CONSECUTIVE_EXECUTION_ERRORS: setting('MAX_CONSECUTIVE_EXECUTION_ERRORS'),
        RECOVERY_INTERVAL_MS: setting('RECOVERY_INTERVAL_MS'),
        TRIAL_RETENTION_DAYS: setting('TRIAL_RETENTION_DAYS'),
      }),
    });
    // A shutdown that began while the lifecycle was starting stops it here.
    if (this.stopping) await lifecycle.stop();
    else this.lifecycle = lifecycle;
  }

  /**
   * A slot network for an http MCP test: from the lifecycle's pool while it
   * runs, so tests and trials never share one; otherwise any slot the
   * engine shows no live trial on (no trial can start then anyway).
   */
  private acquireSlot(): Promise<SlotLease> {
    const pool = this.lifecycle?.slots;
    if (pool) return slotLeaseSource(pool)();
    return freeSlotSource(this.sandbox.engine, this.sandbox.slots)();
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

  /**
   * Hands running attempts back and ends them (see the class comment), then
   * lets a start-up load in progress finish its directory, for a bounded
   * time. Runs before presence's own hook and before pg-boss and the pool
   * close: Nest destroys this module before the modules it imports.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.lifecycleTimer) clearInterval(this.lifecycleTimer);
    await this.lifecycleStarting;
    const lifecycle = this.lifecycle;
    if (lifecycle) {
      await lifecycle.stop();
      // Stopped first, so the last pass revokes this worker's leases at once.
      await this.presence.stop();
      await this.endHandedBackAttempts(lifecycle);
      this.lifecycle = null;
    }
    await this.presence.stop();

    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), STARTUP_LOAD_SHUTDOWN_WAIT_MS);
    });
    const outcome = await Promise.race([this.startupLoad, waited]);
    clearTimeout(timer);
    if (outcome === 'timeout') this.logger.warn('shutting down during the start-up suite load');
  }

  /** The shutdown's last recovery pass, bounded by SHUTDOWN_RECOVERY_WAIT_MS; never rejects. */
  private async endHandedBackAttempts(lifecycle: ExecutionLifecycle): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), SHUTDOWN_RECOVERY_WAIT_MS);
    });
    const pass: Promise<RecoveryReport | null | 'timeout'> = lifecycle.recoverNow();
    const report = await Promise.race([pass, waited]);
    clearTimeout(timer);
    if (report === 'timeout') {
      this.logger.warn('shutdown recovery pass still running; the next start finishes it');
    } else if (report === null) {
      this.logger.warn('another worker holds the recovery lock; it or the next start finishes');
    } else if (report.unconfirmed.length > 0) {
      this.logger.warn(
        { unconfirmed: report.unconfirmed },
        'trial containers not confirmed gone; the next start on this daemon finishes them',
      );
    }
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
