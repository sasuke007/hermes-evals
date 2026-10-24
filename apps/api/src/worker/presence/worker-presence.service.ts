/**
 * Worker presence (decision D5, plan 5.3 "Presence", UI_FLOWS 5.1). Each
 * worker process start inserts its own `workers` row once the isolation
 * self-test has run: concurrency, its trial slot count, the Hermes version
 * and revision, the toolsets the trial image offers, the names (never
 * values) of the variables in its own and in egress's environment, and the
 * self-test report. It then
 * heartbeats the row every 10 s, refreshing both name lists, and sets
 * `stopped_at` on a graceful shutdown.
 *
 * The API reads these rows for the System page, the Secrets page and the
 * configuration form; a row whose heartbeat is older than WORKER_TIMEOUT_MS
 * counts as gone. Presence never throws into the worker: a database or
 * egress that is down is logged and retried on the next beat.
 */
import { hostname } from 'node:os';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { HERMES_REVISION, HERMES_VERSION } from '@hermes-evals/shared';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../../config/env.js';
import { DB } from '../../database/db.provider.js';
import { workers } from '../../database/schema/index.js';
import type { WorkerSandbox } from '../../database/schema/worker-sandbox.js';
import type { AppDb } from '../../database/types.js';
import { SandboxService } from '../../sandbox/sandbox.service.js';
import { listToolsets } from '../../sandbox/toolsets.js';
import { presentEnvNames, workerSandboxReport } from './presence-report.js';
import { inspectTrialImage } from './trial-image.js';

/** How often the row's heartbeat is renewed. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Facts read once at start; the heartbeat only refreshes the name lists. */
interface StartFacts {
  toolsets: string[];
  sandbox: WorkerSandbox | null;
}

@Injectable()
export class WorkerPresenceService implements OnModuleDestroy {
  private workerId: string | null = null;
  private facts: StartFacts | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The beat in flight, so beats never overlap and stop() can wait for it. */
  private beating: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  /** Whether the last beat reached egress; a change is logged once, not on every beat. */
  private egressReachable: boolean | null = null;

  constructor(
    @Inject(DB) private readonly db: AppDb,
    private readonly config: ConfigService<Env, true>,
    private readonly sandbox: SandboxService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WorkerPresenceService.name);
  }

  /** This process's `workers` row id, once it has been inserted. */
  get id(): string | null {
    return this.workerId;
  }

  /**
   * Call once, after SandboxService.verify(). Reads the toolsets and the
   * self-test report, inserts the row and starts the heartbeat. Does nothing
   * when DATABASE_URL is not set. If the insert fails, each beat retries it.
   */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    if (!this.config.get('DATABASE_URL', { infer: true })) {
      this.logger.warn('presence disabled: DATABASE_URL is not set');
      return;
    }
    this.facts = await this.readStartFacts();
    // A shutdown while the toolsets were being listed: register nothing.
    if (this.stopped) return;
    await this.beat();
    // A shutdown during the first beat has already marked the row stopped.
    if (this.stopped) return;
    this.timer = setInterval(() => void this.beat(), HEARTBEAT_INTERVAL_MS);
    // The heartbeat alone must not keep a worker that is shutting down alive.
    this.timer.unref();
  }

  /** Stops the heartbeat and marks the row stopped. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.beating;
    if (!this.workerId) return;
    try {
      await this.db
        .update(workers)
        .set({ stoppedAt: sql`now()`, lastHeartbeatAt: sql`now()` })
        .where(and(eq(workers.id, this.workerId), isNull(workers.stoppedAt)));
      this.logger.info({ workerId: this.workerId }, 'worker marked stopped');
    } catch (err) {
      this.logger.warn({ err, workerId: this.workerId }, 'could not mark the worker stopped');
    }
  }

  /** Nest calls this before DatabaseModule (global) closes the pool. */
  onModuleDestroy(): Promise<void> {
    return this.stop();
  }

  /** One beat: insert the row if it is not there yet, otherwise renew it. Never throws. */
  private beat(): Promise<void> {
    if (this.beating || this.stopped) return this.beating ?? Promise.resolve();
    const beating = (async () => {
      try {
        const names = await this.names();
        if (this.workerId) await this.renew(this.workerId, names);
        else await this.insert(names);
      } catch (err) {
        this.logger.warn(
          { err },
          this.workerId ? 'heartbeat failed' : 'worker registration failed',
        );
      }
    })().finally(() => {
      // Runs after the assignment below, however quickly the beat settles.
      if (this.beating === beating) this.beating = null;
    });
    this.beating = beating;
    return beating;
  }

  private async insert(names: { env: string[]; egress: string[] }): Promise<void> {
    const facts = this.facts!;
    const [row] = await this.db
      .insert(workers)
      .values({
        hostname: hostname(),
        concurrency: this.config.get('WORKER_CONCURRENCY', { infer: true }),
        // This worker's own TRIAL_SLOTS, so each worker reports its own total.
        slots: this.sandbox.slots.length,
        hermesVersion: HERMES_VERSION,
        hermesRevision: HERMES_REVISION,
        toolsets: facts.toolsets,
        envNames: names.env,
        egressEnvNames: names.egress,
        sandbox: facts.sandbox,
      })
      .returning({ id: workers.id });
    this.workerId = row!.id;
    this.logger.info(
      {
        workerId: this.workerId,
        sandbox: facts.sandbox?.state ?? 'not checked',
        toolsets: facts.toolsets.length,
        envNames: names.env.length,
        egressEnvNames: names.egress.length,
      },
      'worker registered',
    );
  }

  private async renew(id: string, names: { env: string[]; egress: string[] }): Promise<void> {
    const renewed = await this.db
      .update(workers)
      .set({ lastHeartbeatAt: sql`now()`, envNames: names.env, egressEnvNames: names.egress })
      .where(and(eq(workers.id, id), isNull(workers.stoppedAt)))
      .returning({ id: workers.id });
    if (renewed.length === 0) this.logger.warn({ workerId: id }, 'worker row is gone or stopped');
  }

  /**
   * The names in this process's environment and in egress's. Egress that
   * cannot be reached reports none: its secrets cannot reach a request then
   * either, and the Secrets page should say so.
   */
  private async names(): Promise<{ env: string[]; egress: string[] }> {
    let egress: string[] = [];
    try {
      egress = await this.sandbox.egress.envNames();
      if (this.egressReachable === false) this.logger.info('egress env names readable again');
      this.egressReachable = true;
    } catch (err) {
      if (this.egressReachable !== false) {
        this.logger.warn({ err }, 'cannot read egress env names; reporting none until it answers');
      }
      this.egressReachable = false;
    }
    return { env: presentEnvNames(process.env), egress };
  }

  /** Toolsets from the trial image and the self-test report; each falls back on its own. */
  private async readStartFacts(): Promise<StartFacts> {
    const checkedAt = new Date();
    const { state, checks } = this.sandbox.status();
    // Both need docker-guard, which an unavailable sandbox does not have.
    const guardReachable = state === 'isolated' || state === 'failed';
    let toolsets: string[] = [];
    let image: { id: string; revision: string | null } | null = null;
    if (guardReachable) {
      try {
        toolsets = await listToolsets(this.sandbox);
      } catch (err) {
        this.logger.warn({ err }, 'could not list the trial image toolsets; reporting none');
      }
      try {
        image = await inspectTrialImage(
          this.config.get('DOCKER_SOCKET', { infer: true }),
          this.sandbox.image,
        );
        if (image.revision && image.revision !== HERMES_REVISION) {
          this.logger.warn(
            { image: this.sandbox.image, label: image.revision, expected: HERMES_REVISION },
            'trial image carries a different Hermes revision than this build expects',
          );
        }
      } catch (err) {
        this.logger.warn({ err }, 'could not inspect the trial image; reporting no digest');
      }
    }
    return {
      toolsets,
      sandbox: workerSandboxReport({
        state,
        checks,
        checkedAt,
        image: this.sandbox.image,
        imageDigest: image?.id,
        revision: image?.revision ?? HERMES_REVISION,
      }),
    };
  }
}
