/**
 * The System page and the app shell's live pill (UI_FLOWS 4 and 5): which
 * workers are present, whether isolation is proven, and how far the running
 * experiments are. Everything is read from Postgres, which the workers
 * heartbeat into (worker/presence); the API never talks to a worker.
 */
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import {
  SandboxStatusSchema,
  SystemSummarySchema,
  WORKER_TIMEOUT_MS,
  WorkerSchema,
  type RunningSummary,
  type SandboxStatus,
  type SystemSummary,
  type Worker,
} from '@hermes-evals/shared';
import { DB } from '../database/db.provider.js';
import { experiments, runs, workers } from '../database/schema/index.js';
import { WorkerSandboxSchema } from '../database/schema/worker-sandbox.js';
import type { AppDb } from '../database/types.js';
import { findLiveWorker } from '../queue/live-worker.js';
import { sandboxView, workerView, type WorkerViewRow } from './views.js';

/**
 * How long a worker that died without stopping stays listed (as offline).
 * Every restart inserts a new row, so a gracefully stopped worker leaves the
 * list at once (its successor replaces it), while one that crashed stays
 * visible for a while: its attempts are being recovered as `worker_lost`.
 */
export const LOST_WORKER_LISTED_MS = 60 * 60_000;

/** Most rows the workers list returns. */
const WORKER_LIST_LIMIT = 20;

/** `now() - ms` on the database clock, which the heartbeat writes with. */
const ago = (ms: number) => sql`now() - (${ms})::float8 * interval '1 millisecond'`;

@Injectable()
export class SystemService {
  constructor(@Inject(DB) private readonly db: AppDb) {}

  /** GET /system/summary */
  async summary(): Promise<SystemSummary> {
    const [running, workerViews, queuedRuns] = await Promise.all([
      this.running(),
      this.workers(),
      this.queuedRuns(),
    ]);
    return SystemSummarySchema.parse({ running, workers: workerViews, queuedRuns });
  }

  /**
   * GET /system/workers: every worker that has not stopped and was heard from
   * in the last LOST_WORKER_LISTED_MS, newest start first. When there is none,
   * the most recently heard-from worker, offline, so the page can say when a
   * worker was last seen.
   */
  async workers(): Promise<Worker[]> {
    const columns = {
      id: workers.id,
      lastHeartbeatAt: workers.lastHeartbeatAt,
      concurrency: workers.concurrency,
      slots: workers.slots,
      inFlight: workers.inFlight,
      sandbox: workers.sandbox,
      online: sql<boolean>`(${workers.stoppedAt} is null and ${workers.lastHeartbeatAt} >= ${ago(WORKER_TIMEOUT_MS)})`,
    };
    let rows: WorkerViewRow[] = await this.db
      .select(columns)
      .from(workers)
      .where(
        and(isNull(workers.stoppedAt), gte(workers.lastHeartbeatAt, ago(LOST_WORKER_LISTED_MS))),
      )
      .orderBy(desc(workers.startedAt), desc(workers.id))
      .limit(WORKER_LIST_LIMIT);
    if (rows.length === 0) {
      rows = await this.db
        .select(columns)
        .from(workers)
        .orderBy(desc(workers.lastHeartbeatAt), desc(workers.id))
        .limit(1);
    }
    return WorkerSchema.array().parse(rows.map(workerView));
  }

  /**
   * GET /system/sandbox: the isolation self-test of the newest live worker.
   * 404 when no worker is live or it has not reported one; an offline
   * worker's report proves nothing about the machine now.
   */
  async sandbox(): Promise<SandboxStatus> {
    const worker = await findLiveWorker(this.db);
    if (!worker) {
      throw new NotFoundException({
        statusCode: 404,
        message:
          'No worker is connected, so no isolation self-test has been reported. Start one with: docker compose up -d worker',
      });
    }
    if (!worker.sandbox) {
      throw new NotFoundException({
        statusCode: 404,
        message: 'The connected worker has not reported an isolation self-test yet.',
      });
    }
    const report = WorkerSandboxSchema.safeParse(worker.sandbox);
    if (!report.success) {
      throw new InternalServerErrorException({
        statusCode: 500,
        message: "The connected worker's isolation report could not be read.",
      });
    }
    return SandboxStatusSchema.parse(sandboxView(worker.hermesVersion, report.data));
  }

  /** Running experiments with their scored and total run counts, oldest first. */
  private async running(): Promise<RunningSummary> {
    const rows = await this.db
      .select({
        id: experiments.id,
        name: experiments.name,
        scored: sql<number>`(count(${runs.id}) filter (where ${runs.status} = 'scored'))::int`,
        total: sql<number>`count(${runs.id})::int`,
      })
      .from(experiments)
      .leftJoin(runs, eq(runs.experimentId, experiments.id))
      .where(eq(experiments.status, 'running'))
      .groupBy(experiments.id)
      .orderBy(asc(experiments.createdAt), asc(experiments.id));
    return {
      count: rows.length,
      scored: rows.reduce((sum, row) => sum + row.scored, 0),
      total: rows.reduce((sum, row) => sum + row.total, 0),
      experiments: rows,
    };
  }

  /** Queued runs of running experiments: what waits for a worker. A paused experiment's do not. */
  private async queuedRuns(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(runs)
      .innerJoin(experiments, eq(experiments.id, runs.experimentId))
      .where(and(eq(runs.status, 'queued'), eq(experiments.status, 'running')));
    return row?.count ?? 0;
  }
}
