/**
 * The draft routes that need the worker (plan 4.6, 11), and the rebase:
 *
 * - POST …/tasks/:key/self-check sends `self-check-draft` and waits; the
 *   worker's result is recorded on the draft task, which is checked again,
 *   so the readiness rows show it.
 * - POST …/draft/save claims the draft (save_started_at; edits are refused
 *   while it is set), sends `save-suite-draft` and waits: 200 with the load
 *   result, 409 with the conflict, 422 with the loader's error, 503 without
 *   a worker or when a verifier cannot run. A save that fails or is
 *   cancelled releases the claim; one that times out keeps it, since the
 *   worker may still finish it.
 * - POST …/draft/rebase combines the draft onto the folder's current
 *   version, in the database (rebase.ts).
 *
 * Both waits use SUITE_RELOAD_TIMEOUT_S, as POST /suites/reload does.
 */
import {
  ConflictException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, ne } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { PgBoss } from 'pg-boss';
import type {
  DraftConflict,
  DraftConflictBody,
  DraftSaveFailureBody,
  DraftSaveResult,
  DraftSelfCheckView,
  RebaseSuiteDraftRequest,
  SaveSuiteDraftRequest,
  SuiteDraftView,
} from '@hermes-evals/shared';
import type { Env } from '../../config/env.js';
import { DB } from '../../database/db.provider.js';
import { suiteDrafts, suiteDraftTasks } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { findLiveWorker } from '../../queue/live-worker.js';
import { QueueService } from '../../queue/queue.service.js';
import {
  draftSelfCheckKey,
  QUEUES,
  type QueueName,
  type SelfCheckDraftJob,
} from '../../queue/queues.js';
import { JobWaitTimeout, sendAndWait, type JobOutcome } from '../../queue/send-and-wait.js';
import { StorageService } from '../../storage/storage.service.js';
import { draftViewOf, requireDraft } from '../drafts/draft-reads.js';
import { highestVersion, lockDraft } from '../drafts/draft-store.js';
import { conflict, DraftWriter, isSaving } from '../drafts/draft-writer.js';
import { selfCheckView } from '../drafts/readiness-self-check.js';
import { badRequest, gatewayTimeout, notFound, serverError, unavailable } from '../http-errors.js';
import { suiteDisplayPath } from '../views/format.js';
import { rebaseDraft } from './rebase.js';
import { SaveDraftOutputSchema } from './save-draft.js';
import { SelfCheckDraftOutputSchema } from './self-check-draft.js';

export const SAVE_NO_WORKER_MESSAGE =
  'No worker is running. Saving needs the worker. Your draft is kept.';
export const SELF_CHECK_NO_WORKER_MESSAGE =
  "The worker isn't running, so file checks and scripts can't be self-checked. Your draft is kept.";

/** "./suites/invoices-v1 changed on disk after this draft began. A reload created v7. …" */
export function conflictMessage(folder: string, c: DraftConflict): string {
  const how =
    c.cause === 'version_moved'
      ? `A reload created v${c.current.versionNumber}`
      : `Files edited on disk were loaded as v${c.current.versionNumber}`;
  return `${suiteDisplayPath(folder)} changed on disk after this draft began. ${how}. Your draft is based on v${c.baseVersion}.`;
}

/** "Not saved. overdue_count/task.yaml line 9: unknown key prmary. Nothing on disk changed. …" */
export function notSavedMessage(error: DraftSaveFailureBody['error']): string {
  const where =
    error.file === '.' ? '' : `${error.file}${error.line === null ? '' : ` line ${error.line}`}: `;
  return `Not saved. ${where}${error.message.replace(/\.$/, '')}. Nothing on disk changed. Your draft is kept.`;
}

@Injectable()
export class DraftJobsService {
  private readonly writer: DraftWriter;

  constructor(
    @Inject(DB) private readonly db: AppDb,
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DraftJobsService.name);
    this.writer = new DraftWriter(db, storage);
  }

  /** POST /suites/:suite/draft/tasks/:key/self-check. */
  async selfCheck(folder: string, key: string): Promise<DraftSelfCheckView> {
    const draft = await requireDraft(this.db, folder);
    const [task] = await this.db
      .select()
      .from(suiteDraftTasks)
      .where(and(eq(suiteDraftTasks.draftId, draft.id), eq(suiteDraftTasks.key, key)));
    if (!task) throw notFound(`task ${key} in the draft of ${folder}`);
    if (!(await findLiveWorker(this.db))) throw unavailable(SELF_CHECK_NO_WORKER_MESSAGE);

    const job: SelfCheckDraftJob = { draftTaskId: task.id, contentHash: task.contentHash ?? '' };
    const outcome = await this.wait(QUEUES.selfCheckDraft, job, draftSelfCheckKey(job), true);
    const output = this.output(outcome, SelfCheckDraftOutputSchema, 'self-check');
    if (output.kind === 'gone') throw notFound(`task ${key} in the draft of ${folder}`);
    if (output.kind === 'unavailable') throw unavailable(`${output.message}. Your draft is kept.`);
    // Recorded on the task, which is checked again with it (rows 12 and 13 of the panel).
    const row = await this.writer.write(folder, undefined, (ctx) =>
      ctx.change(ctx.task(key), { selfCheck: output.record }),
    );
    const view = selfCheckView(row.selfCheck, row.contentHash);
    if (view === null) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        message: `${key} has problems that stop its self-check; fix them, then run it again.`,
      });
    }
    return view;
  }

  /** POST /suites/:suite/draft/save. */
  async save(folder: string, body: SaveSuiteDraftRequest): Promise<DraftSaveResult> {
    if (!(await findLiveWorker(this.db))) throw unavailable(SAVE_NO_WORKER_MESSAGE);
    const claim = await this.claim(folder, body);
    let outcome: JobOutcome;
    try {
      outcome = await this.wait(
        QUEUES.saveSuiteDraft,
        { draftId: claim.draftId, claim: claim.at.toISOString() },
        claim.draftId,
        false,
      );
    } catch (err) {
      // A save still running keeps its claim; anything else leaves the draft free again.
      if (!(err instanceof GatewayTimeoutException)) await this.release(claim.draftId, claim.at);
      throw err;
    }
    if (outcome.state !== 'completed') await this.release(claim.draftId, claim.at);
    const output = this.output(outcome, SaveDraftOutputSchema, 'save');
    switch (output.kind) {
      case 'saved':
        return output.result;
      case 'conflict':
        throw new ConflictException({
          statusCode: 409,
          message: conflictMessage(folder, output.conflict),
          conflict: output.conflict,
        } satisfies DraftConflictBody);
      case 'not_saved':
        throw new UnprocessableEntityException({
          statusCode: 422,
          message: notSavedMessage(output.error),
          step: output.step,
          error: output.error,
        } satisfies DraftSaveFailureBody);
      case 'unavailable':
        throw unavailable(`${output.message}. Nothing on disk changed. Your draft is kept.`);
      case 'gone':
        throw conflict(`The draft of ${folder} changed hands during the save; open it again.`);
    }
  }

  /** POST /suites/:suite/draft/rebase. */
  async rebase(folder: string, body: RebaseSuiteDraftRequest): Promise<SuiteDraftView> {
    await rebaseDraft(this.db, this.storage, folder, body);
    return draftViewOf(this.db, await requireDraft(this.db, folder), new Date());
  }

  /** Claims the draft for one save: 404, 409 while another runs or for an older revision, 400 for a suite-level problem. */
  private async claim(
    folder: string,
    body: SaveSuiteDraftRequest,
  ): Promise<{ draftId: string; at: Date }> {
    const at = new Date();
    return this.db.transaction(async (tx) => {
      const draft = await lockDraft(tx, folder);
      if (!draft) throw notFound(`draft of ${folder}`);
      if (isSaving(draft, at)) {
        throw conflict(`A save of ${suiteDisplayPath(folder)} is already running.`);
      }
      if (body.revision !== undefined && body.revision !== draft.revision) {
        throw conflict(`The draft of ${folder} changed since you reviewed it; review it again.`);
      }
      const label = body.versionLabel ?? draft.versionLabel;
      if (label.trim() === '') throw badRequest('Add a version label.');
      const kept = await tx
        .select({ id: suiteDraftTasks.id })
        .from(suiteDraftTasks)
        .where(and(eq(suiteDraftTasks.draftId, draft.id), ne(suiteDraftTasks.state, 'removed')))
        .limit(1);
      if (kept.length === 0) {
        const next = (await highestVersion(tx, folder)) + 1;
        throw badRequest(`Add at least one task to save v${next}.`);
      }
      const relabelled = label !== draft.versionLabel;
      await tx
        .update(suiteDrafts)
        .set({
          versionLabel: label,
          saveStartedAt: at,
          saveProgress: { startedAt: at.toISOString(), step: 'staging', selfChecks: null },
          ...(relabelled ? { revision: draft.revision + 1, updatedAt: at } : {}),
        })
        .where(eq(suiteDrafts.id, draft.id));
      return { draftId: draft.id, at };
    });
  }

  private async release(draftId: string, at: Date): Promise<void> {
    await this.db
      .update(suiteDrafts)
      .set({ saveStartedAt: null, saveProgress: null })
      .where(and(eq(suiteDrafts.id, draftId), eq(suiteDrafts.saveStartedAt, at)))
      .catch((err: unknown) => this.logger.warn({ err, draftId }, 'save claim not released'));
  }

  private async wait(
    queue: QueueName,
    data: object,
    singletonKey: string,
    joinActive: boolean,
  ): Promise<JobOutcome> {
    const timeoutS = this.config.get('SUITE_RELOAD_TIMEOUT_S', { infer: true });
    try {
      return await sendAndWait(this.boss(), queue, data, {
        singletonKey,
        timeoutMs: timeoutS * 1000,
        joinActive,
      });
    } catch (err) {
      if (!(err instanceof JobWaitTimeout)) throw err;
      throw gatewayTimeout(
        `The worker did not finish within ${timeoutS} s. It may still be working: open the draft again in a moment.`,
      );
    }
  }

  /** The job's output, parsed; 500 with the worker's message for a failed or cancelled job. */
  private output<T>(
    outcome: JobOutcome,
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    what: string,
  ): T {
    if (outcome.state === 'completed') {
      const parsed = schema.safeParse(outcome.output);
      if (parsed.success) return parsed.data;
      this.logger.error({ jobId: outcome.jobId }, `${what} output has an unexpected shape`);
      throw serverError(`The worker finished the ${what} but its result has an unexpected shape.`);
    }
    if (outcome.state === 'cancelled')
      throw serverError(`The ${what} was cancelled before it finished.`);
    const message = (outcome.output as { message?: unknown } | null)?.message;
    throw serverError(
      `The ${what} failed in the worker: ${typeof message === 'string' && message !== '' ? message : 'no message'}. Your draft is kept.`,
    );
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
