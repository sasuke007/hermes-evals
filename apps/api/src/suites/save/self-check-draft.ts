/**
 * The self-check of one draft task, in the worker (plan 4.6): file checks
 * and verifier scripts read files or run user code, so they never run in
 * the API. The job writes the task from its draft texts and blobs into a
 * scratch folder (materialise.ts), analyses it with the loader's own task
 * analysis and runs the loader's own task self-check on it, verifiers in
 * their containers (R7), so a draft is judged exactly as a reload would
 * judge the same files. The job returns the result with the content hash it
 * ran on, and the API records it on the draft task, checking the task's
 * readiness again (DraftTasksService.recordSelfCheck); the editor marks it
 * out of date after an edit.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { SelfCheckSchema } from '@hermes-evals/shared';
import {
  suiteDraftFiles,
  suiteDraftTasks,
  type DraftSelfCheckRecord,
} from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { VerifierUnavailable } from '../../scoring/verifier-runner.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { draftTaskFolderOf, writeDraftTaskFolder } from '../drafts/materialise.js';
import { analyseTaskDir } from '../loader/read-suite.js';
import { selfCheckTask } from '../loader/task-self-check.js';

/** The job's output, which the API records and turns into the self-check view, 404 or 503. */
export const SelfCheckDraftOutputSchema = z.discriminatedUnion('kind', [
  /** `ran_at` is null when load problems left nothing to run. */
  z.object({
    kind: z.literal('checked'),
    record: SelfCheckSchema.extend({ content_hash: z.string() }),
  }),
  z.object({ kind: z.literal('gone') }),
  z.object({ kind: z.literal('unavailable'), message: z.string() }),
]);
export type SelfCheckDraftOutput = z.infer<typeof SelfCheckDraftOutputSchema>;

export interface SelfCheckDraftDeps {
  db: AppDb;
  blobs: BlobStore;
  now?: () => Date;
}

export async function selfCheckDraftTask(
  job: { draftTaskId: string },
  deps: SelfCheckDraftDeps,
): Promise<SelfCheckDraftOutput> {
  const [task] = await deps.db
    .select()
    .from(suiteDraftTasks)
    .where(eq(suiteDraftTasks.id, job.draftTaskId));
  if (!task) return { kind: 'gone' };
  const files = await deps.db
    .select()
    .from(suiteDraftFiles)
    .where(eq(suiteDraftFiles.draftTaskId, task.id));

  const scratch = await deps.blobs.scratchDir('draft-check');
  try {
    await writeDraftTaskFolder(draftTaskFolderOf(task, files), `${scratch.path}/${task.key}`, {
      blobs: deps.blobs,
    });
    const analysed = await analyseTaskDir(scratch.path, task.key);
    const selfCheck = await selfCheckTask(analysed, {
      scratch: (prefix) => deps.blobs.scratchDir(prefix),
      ...(deps.now ? { now: deps.now } : {}),
    });
    const record: DraftSelfCheckRecord = { ...selfCheck, content_hash: analysed.contentHash };
    return { kind: 'checked', record };
  } catch (err) {
    if (err instanceof VerifierUnavailable) return { kind: 'unavailable', message: err.message };
    throw err;
  } finally {
    await scratch.dispose().catch(() => {});
  }
}
