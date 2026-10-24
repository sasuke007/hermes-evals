/**
 * The load-suites job (decision D1): POST /suites/reload sends it and waits
 * for its output, the SuiteReloadResult. One job at a time per worker, and
 * the loader runs one load at a time per process, so a job waits for the
 * start-up pass. Across workers, each directory is read and recorded under
 * its advisory lock (suite-loader.ts), so the later load always reads the
 * later files.
 */
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { SuiteReloadResult } from '@hermes-evals/shared';
import { QUEUES, type LoadSuitesJob } from '../../queue/queues.js';
import type { LoaderLogger, SuiteLoader } from './suite-loader.js';

const LoadSuitesJobSchema = z.object({ path: z.string().min(1).nullable() });

/** Runs one job: every directory for `path: null`, else that one. Throws (failing the job) on bad data. */
export async function handleLoadSuitesJob(
  data: unknown,
  loader: Pick<SuiteLoader, 'loadAll' | 'loadOne'>,
  logger: LoaderLogger,
): Promise<SuiteReloadResult> {
  const job: LoadSuitesJob = LoadSuitesJobSchema.parse(data);
  logger.info({ path: job.path }, 'load-suites received');
  return job.path === null ? loader.loadAll() : loader.loadOne(job.path);
}

/** Starts consuming load-suites jobs; the handler's result is the job's output. Returns the pg-boss worker id. */
export function registerSuiteLoadHandler(
  boss: PgBoss,
  loader: Pick<SuiteLoader, 'loadAll' | 'loadOne'>,
  logger: LoaderLogger,
): Promise<string> {
  const options = { batchSize: 1, localConcurrency: 1 } as const;
  return boss.work<LoadSuitesJob, SuiteReloadResult | null, typeof options>(
    QUEUES.loadSuites,
    options,
    async ([job]) => (job ? handleLoadSuitesJob(job.data, loader, logger) : null),
  );
}
