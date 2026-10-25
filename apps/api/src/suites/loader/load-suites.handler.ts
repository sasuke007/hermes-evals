/**
 * The load-suites job (decision D1): POST /suites/reload sends it and waits
 * for its output, the SuiteReloadResult. One job at a time per worker, and
 * the loader runs one load at a time per process, so a job waits for the
 * start-up pass. Across workers, each directory is read and recorded under
 * its advisory lock (suite-loader.ts), so the later load always reads the
 * later files.
 *
 * pg-boss fails the job at LOAD_SUITES_EXPIRE_SECONDS, so the job is bounded
 * by what its self-checks declare (Phase 3 question 14): one directory is
 * refused above MAX_LOAD_SELF_CHECK_SECONDS by the loader itself, and a
 * reload of every directory shares that same budget across them.
 */
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import type { SuiteReloadResult } from '@hermes-evals/shared';
import { MAX_LOAD_SELF_CHECK_SECONDS, QUEUES, type LoadSuitesJob } from '../../queue/queues.js';
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
  return job.path === null
    ? loader.loadAll({ selfCheckBudgetS: MAX_LOAD_SELF_CHECK_SECONDS })
    : loader.loadOne(job.path);
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
