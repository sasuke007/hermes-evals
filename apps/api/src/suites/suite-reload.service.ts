/**
 * POST /suites/reload and GET /suites/reload/progress. Suites load in the
 * worker (load-suites jobs), which runs verifier self-checks, user code,
 * outside the API. The API sends the jobs, waits for their output, and
 * returns the per-directory SuiteReloadResult.
 *
 * One directory is one job. A Reload all is one job per directory (Phase 4
 * question 9), so each has the whole self-check budget a job has: a scan
 * job first marks the vanished directories missing and lists the others,
 * then each directory gets its own job, and the progress endpoint shows
 * where each stands (queued, loading, done, failed) while the request
 * waits. A Reload all that outlasts SUITE_RELOAD_TIMEOUT_S answers 504 and
 * goes on; the progress shows it to the end. A second Reload all while one
 * runs joins it.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { PgBoss } from 'pg-boss';
import {
  DIRECTORY_KEY_PATTERN,
  SuiteReloadResultSchema,
  type SuiteReloadProgress,
  type SuiteReloadRequest,
  type SuiteReloadResult,
} from '@hermes-evals/shared';
import type { Env } from '../config/env.js';
import { DB } from '../database/db.provider.js';
import type { AppDb } from '../database/types.js';
import { findLiveWorker } from '../queue/live-worker.js';
import { QueueService } from '../queue/queue.service.js';
import {
  LOAD_SUITES_EXPIRE_SECONDS,
  QUEUES,
  loadSuitesKey,
  type LoadSuitesJob,
} from '../queue/queues.js';
import { JobWaitTimeout, sendAndWait, type JobOutcome } from '../queue/send-and-wait.js';
import { badRequest, gatewayTimeout, serverError, unavailable } from './http-errors.js';
import { failureMessage, ReloadAll } from './reload-all.js';
import { SUITES_DISPLAY_ROOT } from './views/format.js';

export const NO_WORKER_MESSAGE =
  'No worker is connected. Suites load in the worker; start it and try again.';

/**
 * The directory a reload request names, relative to SUITES_DIR: accepts the
 * path as the list shows it (`./suites/invoices-v1`) or the bare directory
 * name. Null when the request names none. Throws 400 for anything that is
 * not one directory name; the loader matches the name against what is on disk.
 */
export function reloadDirectory(request: SuiteReloadRequest): string | null {
  if (request.path === undefined) return null;
  let path = request.path.trim().replace(/\/+$/, '');
  for (const prefix of [`${SUITES_DISPLAY_ROOT}/`, 'suites/']) {
    if (path.startsWith(prefix)) {
      path = path.slice(prefix.length);
      break;
    }
  }
  if (!DIRECTORY_KEY_PATTERN.test(path)) {
    throw badRequest(
      `path must name one suite directory, such as ${SUITES_DISPLAY_ROOT}/invoices-v1; got ${JSON.stringify(request.path)}`,
    );
  }
  return path;
}

const timeoutMessage = (timeoutS: number): string =>
  `The reload did not finish within ${timeoutS} s. Suites may still be loading in the ` +
  'worker: refresh the list in a moment, or reload again.';

@Injectable()
export class SuiteReloadService {
  private readonly all: ReloadAll;

  constructor(
    @Inject(DB) private readonly db: AppDb,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SuiteReloadService.name);
    this.all = new ReloadAll({
      db,
      boss: () => this.boss(),
      logger: this.logger,
      jobTimeoutMs: LOAD_SUITES_EXPIRE_SECONDS * 1000,
    });
  }

  async reload(request: SuiteReloadRequest): Promise<SuiteReloadResult> {
    const path = reloadDirectory(request);
    // Without a worker the job would sit in the queue until the timeout.
    if (!(await findLiveWorker(this.db))) throw unavailable(NO_WORKER_MESSAGE);
    const timeoutS = this.config.get('SUITE_RELOAD_TIMEOUT_S', { infer: true });
    if (path === null) return this.reloadAll(timeoutS);
    return this.entries(await this.wait({ path }, timeoutS));
  }

  /** GET /suites/reload/progress: the last Reload all, per directory. */
  progress(): SuiteReloadProgress {
    return this.all.progress();
  }

  private async reloadAll(timeoutS: number): Promise<SuiteReloadResult> {
    // Joins the Reload all already running; its jobs go on whatever this request does.
    const running = this.all.run();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutS * 1000);
    });
    try {
      const result = await Promise.race([running, late]);
      if (result === 'timeout') throw gatewayTimeout(timeoutMessage(timeoutS));
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One directory's job output as the result, or the error the request answers with. */
  private entries(outcome: JobOutcome): SuiteReloadResult {
    if (outcome.state === 'completed') {
      const parsed = SuiteReloadResultSchema.safeParse(outcome.output);
      if (parsed.success) return parsed.data;
      this.logger.error(
        { jobId: outcome.jobId, issues: parsed.error.issues.slice(0, 10) },
        'load-suites output does not match SuiteReloadResult',
      );
      throw serverError(
        'The worker finished the reload but its result has an unexpected shape; see the API log.',
      );
    }
    if (outcome.state === 'cancelled')
      throw serverError('The suite reload was cancelled before it finished.');
    const message = failureMessage(outcome.output);
    this.logger.warn({ jobId: outcome.jobId, message }, 'load-suites job failed');
    throw serverError(`Suite reload failed in the worker: ${message}`);
  }

  /**
   * Sends the job and waits for it to settle. A live job for the same
   * directory is joined only while it is still queued: one already running
   * may have read the files before the user's edit, so it is waited out and
   * a new pass sent.
   */
  private async wait(job: LoadSuitesJob, timeoutS: number): Promise<JobOutcome> {
    try {
      return await sendAndWait(this.boss(), QUEUES.loadSuites, job, {
        singletonKey: loadSuitesKey(job),
        timeoutMs: timeoutS * 1000,
        joinActive: false,
      });
    } catch (err) {
      if (!(err instanceof JobWaitTimeout)) throw err;
      throw gatewayTimeout(timeoutMessage(timeoutS));
    }
  }

  private boss(): PgBoss {
    try {
      return this.queue.instance;
    } catch {
      throw unavailable(
        'The job queue is not available. Check that the database is reachable, then try again.',
      );
    }
  }
}
