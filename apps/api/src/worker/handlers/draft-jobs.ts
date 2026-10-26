/**
 * The two worker jobs of suite authoring (plan 4.6, Phase 5b):
 *
 * - `self-check-draft`: one draft task's self-check, on its files written
 *   to scratch, recorded on the draft task (suites/save/self-check-draft.ts);
 * - `save-suite-draft`: a draft saved as the folder's next version, the
 *   only job that writes SUITES_DIR (suites/save/save-draft.ts).
 *
 * The API sends each and waits for its output (sendAndWait), which says
 * what to answer: the result, a 409 conflict, a 422 the loader refused, or
 * 503 when a verifier could not be run. A job that throws fails, and the
 * API answers 500 with its message.
 */
import type { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { QUEUES, type SaveSuiteDraftJob, type SelfCheckDraftJob } from '../../queue/queues.js';
import type { BlobStore } from '../../storage/blob-store.js';
import type { AppDb } from '../../database/types.js';
import type { LoaderLogger } from '../../suites/loader/suite-loader.js';
import { saveSuiteDraft, type SaveDraftOutput } from '../../suites/save/save-draft.js';
import {
  selfCheckDraftTask,
  type SelfCheckDraftOutput,
} from '../../suites/save/self-check-draft.js';

export interface DraftJobDeps {
  db: AppDb;
  blobs: BlobStore;
  /** SUITES_DIR, mounted read-write in the worker for the save alone. */
  suitesDir: string;
  logger: LoaderLogger;
}

const SelfCheckDraftJobSchema = z.object({
  draftTaskId: z.string().min(1),
  contentHash: z.string(),
});
const SaveSuiteDraftJobSchema = z.object({
  draftId: z.string().min(1),
  claim: z.iso.datetime({ offset: true }),
});

export async function handleSelfCheckDraftJob(
  data: unknown,
  deps: DraftJobDeps,
): Promise<SelfCheckDraftOutput> {
  const job: SelfCheckDraftJob = SelfCheckDraftJobSchema.parse(data);
  deps.logger.info({ draftTaskId: job.draftTaskId }, 'self-check-draft received');
  return selfCheckDraftTask(job, deps);
}

export async function handleSaveSuiteDraftJob(
  data: unknown,
  deps: DraftJobDeps,
): Promise<SaveDraftOutput> {
  const job: SaveSuiteDraftJob = SaveSuiteDraftJobSchema.parse(data);
  deps.logger.info({ draftId: job.draftId }, 'save-suite-draft received');
  const output = await saveSuiteDraft(job, deps);
  deps.logger.info({ draftId: job.draftId, outcome: output.kind }, 'save-suite-draft finished');
  return output;
}

/**
 * Starts consuming both queues; each handler's result is its job's output.
 * Saves run one at a time per worker, so two never stage at once; across
 * workers each folder's advisory lock serialises them. Returns the pg-boss
 * worker ids.
 */
export async function registerDraftJobHandlers(
  boss: PgBoss,
  deps: DraftJobDeps,
): Promise<string[]> {
  const checks = { batchSize: 1, localConcurrency: 2 } as const;
  const saves = { batchSize: 1, localConcurrency: 1 } as const;
  return [
    await boss.work<SelfCheckDraftJob, SelfCheckDraftOutput | null, typeof checks>(
      QUEUES.selfCheckDraft,
      checks,
      async ([job]) => (job ? handleSelfCheckDraftJob(job.data, deps) : null),
    ),
    await boss.work<SaveSuiteDraftJob, SaveDraftOutput | null, typeof saves>(
      QUEUES.saveSuiteDraft,
      saves,
      async ([job]) => (job ? handleSaveSuiteDraftJob(job.data, deps) : null),
    ),
  ];
}
