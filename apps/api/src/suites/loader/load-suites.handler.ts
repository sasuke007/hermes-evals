/**
 * The load-suites job (decision D1). POST /suites/reload sends it and waits
 * for its output. One job at a time per worker, and the loader runs one load
 * at a time per process, so a job waits for the start-up pass. Across
 * workers, each directory is read and recorded under its advisory lock
 * (suite-loader.ts), so the later load always reads the later files.
 *
 * - `path: <directory>` loads that directory; the output is its
 *   SuiteReloadResult.
 * - `path: null` is the first step of a Reload all (Phase 4 question 9): it
 *   marks vanished directories missing and lists the ones on disk (SuiteScan);
 *   the API then sends one job per directory, so each has the whole
 *   self-check budget of a job and none is left out by the ones before it.
 *
 * pg-boss fails the job at LOAD_SUITES_EXPIRE_SECONDS, so a job is bounded by
 * what its self-checks declare (Phase 3 question 14): the loader refuses a
 * directory above MAX_LOAD_SELF_CHECK_SECONDS.
 */
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { SuiteReloadEntrySchema, type SuiteReloadResult } from '@hermes-evals/shared';
import { QUEUES, type LoadSuitesJob } from '../../queue/queues.js';
import type { LoaderLogger, SuiteLoader, SuiteScan } from './suite-loader.js';

const LoadSuitesJobSchema = z.object({ path: z.string().min(1).nullable() });

/** The output of a `path: null` job, as the API parses it. */
export const SuiteScanSchema = z.object({
  at: z.string(),
  missing: z.array(SuiteReloadEntrySchema),
  directories: z.array(z.string()),
});

/** Runs one job. Throws (failing the job) on bad data. */
export async function handleLoadSuitesJob(
  data: unknown,
  loader: Pick<SuiteLoader, 'scan' | 'loadOne'>,
  logger: LoaderLogger,
): Promise<SuiteReloadResult | SuiteScan> {
  const job: LoadSuitesJob = LoadSuitesJobSchema.parse(data);
  logger.info({ path: job.path }, 'load-suites received');
  return job.path === null ? loader.scan() : loader.loadOne(job.path);
}

/**
 * Starts consuming load-suites jobs; the handler's result is the job's output. Returns the pg-boss worker id.
 *
 * pg-boss waits its polling interval (2 s) after each job before it fetches
 * the next. A Reload all is a scan and then one job per directory, all sent
 * at once and taken one at a time, so five suites that load in a second took
 * 12 s. After each job the worker wakes itself and fetches again at once:
 * the jobs of a Reload all run back to back, and with none waiting it polls
 * as before. A reload sent just after another one still waits for the next
 * poll, which also gives a folder removed on a macOS host time to leave the
 * Docker VM's file-sharing cache (about a second).
 */
export async function registerSuiteLoadHandler(
  boss: PgBoss,
  loader: Pick<SuiteLoader, 'scan' | 'loadOne'>,
  logger: LoaderLogger,
): Promise<string> {
  const options = { batchSize: 1, localConcurrency: 1 } as const;
  let workerId: string | null = null;
  workerId = await boss.work<LoadSuitesJob, SuiteReloadResult | SuiteScan | null, typeof options>(
    QUEUES.loadSuites,
    options,
    async ([job]) => {
      if (!job) return null;
      try {
        return await handleLoadSuitesJob(job.data, loader, logger);
      } finally {
        if (workerId !== null) boss.notifyWorker(workerId);
      }
    },
  );
  return workerId;
}
