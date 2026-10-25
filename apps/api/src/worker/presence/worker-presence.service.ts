/**
 * Worker presence (decision D5, plan 5.3 "Presence", UI_FLOWS 5.1). Each
 * worker process start inserts its own `workers` row once the isolation
 * self-test has run: concurrency, its trial slot count, the Hermes version
 * and revision, the toolsets the trial image offers, the names (never
 * values) of the variables in its own and in egress's environment, egress's
 * development host forward (host_proxy, UI_FLOWS 19 #7) and the self-test
 * report. It then heartbeats the row every 10 s, refreshing the name lists
 * and the host forward, and sets `stopped_at` on a graceful shutdown.
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
import type { WorkerHostProxy } from '../../database/schema/worker-host-proxy.js';
import type { WorkerSandbox } from '../../database/schema/worker-sandbox.js';
import type { AppDb } from '../../database/types.js';
import type { EgressHealth } from '../../sandbox/egress-client.js';
import { SandboxService } from '../../sandbox/sandbox.service.js';
import { listToolsets } from '../../sandbox/toolsets.js';
import { presentEnvNames, workerSandboxReport } from './presence-report.js';
import { inspectTrialImage } from './trial-image.js';

/** How often the row's heartbeat is renewed. */
export const HEARTBEAT_INTERVAL_MS = 10_000;

/** Facts read once at start; the heartbeat refreshes only the name lists and the host forward. */
interface StartFacts {
  toolsets: string[];
  sandbox: WorkerSandbox | null;
  /** False when the trial image's revision label names another Hermes than this build. */
  imageMatchesBuild: boolean;
}

/** The check presence adds to the self-test report when the trial image is another revision. */
export const IMAGE_REVISION_CHECK =
  'trial image runs the Hermes revision this worker was built for';

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
  /** The names egress last reported, kept through a beat that could not reach it. */
  private lastEgressNames: string[] | null = null;

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
   * Whether this worker's trial image runs the Hermes revision it was built
   * for (HERMES_REVISION), as far as start() could tell: the image's
   * org.hermes-evals.hermes-revision label, when it has one. A worker whose
   * image says otherwise reports its sandbox `failed` and must not execute:
   * the revision a run records has to be the one that ran.
   */
  get imageMatchesBuild(): boolean {
    return this.facts?.imageMatchesBuild ?? true;
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
        const [names, hostProxy] = await Promise.all([this.names(), this.hostProxy()]);
        if (this.workerId) await this.renew(this.workerId, names, hostProxy);
        else await this.insert(names, hostProxy);
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

  private async insert(
    names: { env: string[]; egress: string[] },
    hostProxy: WorkerHostProxy | null,
  ): Promise<void> {
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
        hostProxy,
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

  private async renew(
    id: string,
    names: { env: string[]; egress: string[] },
    hostProxy: WorkerHostProxy | null,
  ): Promise<void> {
    const renewed = await this.db
      .update(workers)
      .set({
        lastHeartbeatAt: sql`now()`,
        envNames: names.env,
        egressEnvNames: names.egress,
        hostProxy,
      })
      .where(and(eq(workers.id, id), isNull(workers.stoppedAt)))
      .returning({ id: workers.id });
    if (renewed.length === 0) this.logger.warn({ workerId: id }, 'worker row is gone or stopped');
  }

  /**
   * The names in this process's environment and in egress's. A beat that
   * cannot reach egress (a 3 s timeout while egress is busy or restarting)
   * keeps the names egress last reported: writing none would read as "the
   * key is missing" to the API's provider checks for ten seconds. Before
   * egress ever answered there are none to keep. The worker's own provider
   * guard asks egress live and does not read this row.
   */
  private async names(): Promise<{ env: string[]; egress: string[] }> {
    let egress: string[];
    try {
      egress = await this.sandbox.egress.envNames();
      this.lastEgressNames = egress;
      if (this.egressReachable === false) this.logger.info('egress env names readable again');
      this.egressReachable = true;
    } catch (err) {
      egress = this.lastEgressNames ?? [];
      if (this.egressReachable !== false) {
        this.logger.warn(
          { err },
          'cannot read egress env names; keeping the last ones until it answers',
        );
      }
      this.egressReachable = false;
    }
    return { env: presentEnvNames(process.env), egress };
  }

  /**
   * Egress's development host forward (NOUS_HOST_PROXY) and whether its
   * target answered, as GET /providers reads it to report Nous as `host` or
   * `host_unreachable`. Null when egress has no forward, and when egress
   * cannot be reached: then the API sees no host mode, and Nous readiness
   * falls back to the nous-login volume, which cannot serve runs through an
   * egress that is down either.
   */
  private async hostProxy(): Promise<WorkerHostProxy | null> {
    let report: EgressHealth | null = null;
    try {
      report = await this.sandbox.egress.healthReport();
    } catch {
      // healthReport answers null rather than throwing; this keeps anything
      // else from ever holding up registration or the heartbeat.
    }
    if (!report?.hostProxy) return null;
    return {
      target: report.hostProxy.target,
      reachable: report.hostProxy.reachable,
      checked_at: report.hostProxy.checkedAt,
    };
  }

  /** Toolsets from the trial image and the self-test report; each falls back on its own. */
  private async readStartFacts(): Promise<StartFacts> {
    const checkedAt = new Date();
    const { state, checks: selfTestChecks } = this.sandbox.status();
    // Both need docker-guard, which an unavailable sandbox does not have.
    const guardReachable = state === 'isolated' || state === 'failed';
    let toolsets: string[] = [];
    let image: { id: string; revision: string | null } | null = null;
    let checks = selfTestChecks;
    let imageMatchesBuild = true;
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
          this.logger.error(
            { image: this.sandbox.image, label: image.revision, expected: HERMES_REVISION },
            'trial image carries a different Hermes revision than this build; execution disabled',
          );
          imageMatchesBuild = false;
          checks = [
            ...selfTestChecks,
            {
              name: IMAGE_REVISION_CHECK,
              ok: false,
              detail: `the image's label says ${image.revision.slice(0, 7)}, this worker was built for ${HERMES_REVISION.slice(0, 7)}; rebuild them together`,
            },
          ];
        }
      } catch (err) {
        this.logger.warn({ err }, 'could not inspect the trial image; reporting no digest');
      }
    }
    return {
      toolsets,
      imageMatchesBuild,
      sandbox: workerSandboxReport({
        // A sandbox that proved isolation still cannot run trials of another revision.
        state: imageMatchesBuild ? state : 'failed',
        checks,
        checkedAt,
        image: this.sandbox.image,
        imageDigest: image?.id,
        revision: image?.revision ?? HERMES_REVISION,
      }),
    };
  }
}
