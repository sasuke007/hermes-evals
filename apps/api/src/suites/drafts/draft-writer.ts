/**
 * The one way a draft changes (plan 4.6: a draft saves on every change):
 * a transaction that locks the draft's row, refuses the write while a save
 * runs or when it names an older revision (409), applies the change, runs
 * the readiness rules on every task it touched, and bumps the revisions.
 * The services compose their edits from WriteContext's helpers, so the rule
 * that readiness follows every change cannot be skipped.
 */
import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DraftSelfCheckRecord } from '../../database/schema/index.js';
import { suiteDrafts, suiteDraftTasks } from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import { DRAFT_JOB_EXPIRE_SECONDS } from '../../queue/queues.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { notFound } from '../http-errors.js';
import { suiteById, tasksOf } from '../suites.queries.js';
import type { SuiteRow, TaskRow } from '../views/rows.js';
import {
  folderOf,
  loadDraft,
  lockDraft,
  setTaskFiles,
  tasksById,
  type DraftRow,
  type DraftTaskDbRow,
  type StoredDraft,
} from './draft-store.js';
import { evaluateTask } from './draft-evaluate.js';
import type { DraftFileRef, DraftTaskFolder } from './materialise.js';

/**
 * A save that started longer ago than this is taken to have died; writes
 * are allowed again. As long as the save job may live (its self-checks may
 * declare up to an hour), so an edit accepted meanwhile is never lost when
 * the save deletes the draft.
 */
export const DRAFT_SAVE_STALE_MS = DRAFT_JOB_EXPIRE_SECONDS * 1000;

export const conflict = (message: string): ConflictException =>
  new ConflictException({ statusCode: 409, message });

/** Whether a save of the draft is running now (save_started_at set and not stale). */
export function isSaving(draft: Pick<DraftRow, 'saveStartedAt'>, now: Date): boolean {
  return (
    draft.saveStartedAt !== null &&
    now.getTime() - draft.saveStartedAt.getTime() < DRAFT_SAVE_STALE_MS
  );
}

/** The base version of a draft and its tasks. */
export interface DraftBase {
  suite: SuiteRow | null;
  tasks: TaskRow[];
}

export async function draftBase(db: AppDb, draft: DraftRow): Promise<DraftBase> {
  const suite = draft.baseSuiteId === null ? null : await suiteById(db, draft.baseSuiteId);
  if (suite === null) return { suite: null, tasks: [] };
  return { suite, tasks: await tasksOf(db, [suite.id]) };
}

/** The fields of a draft task a change may set. */
export interface TaskChange {
  key?: string;
  taskYaml?: string | null;
  prompt?: string | null;
  reference?: string | null;
  rubrics?: Readonly<Record<string, string>>;
  files?: readonly DraftFileRef[];
  removed?: boolean;
  restoredFromTaskId?: string | null;
  selfCheck?: DraftSelfCheckRecord | null;
}

export interface WriteContext {
  tx: AppTx;
  draft: DraftRow;
  stored: StoredDraft;
  base: DraftBase;
  now: Date;
  /** The task of `key`, or 404. */
  task(key: string): DraftTaskDbRow;
  /** Applies `change` to an existing task, runs its readiness, and stores it. */
  change(task: DraftTaskDbRow, change: TaskChange): Promise<DraftTaskDbRow>;
  /** Adds a task at `position`, moving the tasks from there down (the end when absent). */
  insert(
    folder: DraftTaskFolder,
    options: {
      position?: number;
      baseTaskId?: string | null;
      restoredFromTaskId?: string | null;
      selfCheck?: DraftSelfCheckRecord | null;
    },
  ): Promise<DraftTaskDbRow>;
  /** Drops a task and its files. */
  drop(task: DraftTaskDbRow): Promise<void>;
}

export class DraftWriter {
  constructor(
    private readonly db: AppDb,
    private readonly blobs: Pick<BlobStore, 'read'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Runs `edit` on the draft of `folder` in one transaction. 404 without a
   * draft; 409 while a save runs, or when `revision` is given and is not
   * the draft's (the edit was made on an older picture).
   */
  async write<T>(
    folder: string,
    revision: number | undefined,
    edit: (ctx: WriteContext) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const draft = await lockDraft(tx, folder);
      if (!draft) throw notFound(`draft of ${folder}`);
      const now = this.clock();
      if (isSaving(draft, now)) {
        throw conflict(`${folder} is being saved; edits wait until the save ends`);
      }
      if (revision !== undefined && revision !== draft.revision) {
        throw conflict(`the draft of ${folder} changed since revision ${revision}; reload it`);
      }
      const ctx = await this.context(tx, draft, now);
      const result = await edit(ctx);
      await tx
        .update(suiteDrafts)
        .set({ revision: draft.revision + 1, updatedAt: now })
        .where(eq(suiteDrafts.id, draft.id));
      return result;
    });
  }

  /**
   * Creates a draft and builds it (its tasks) in the same transaction, so a
   * draft is never seen half built. 409 when the folder has a draft already.
   */
  async create<T>(
    values: Omit<typeof suiteDrafts.$inferInsert, 'createdAt' | 'updatedAt' | 'revision'>,
    build: (ctx: WriteContext) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      const now = this.clock();
      const [draft] = await tx
        .insert(suiteDrafts)
        .values({ ...values, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning();
      if (!draft) throw conflict(`A draft of ${values.sourcePath} is open already.`);
      return build(await this.context(tx, draft, now));
    });
  }

  private async context(tx: AppTx, draft: DraftRow, now: Date): Promise<WriteContext> {
    const stored = await loadDraft(tx, draft);
    const base = await draftBase(tx, draft);
    const restored = new Map<string, TaskRow | null>();
    const restoredTask = async (id: string | null): Promise<TaskRow | null> => {
      if (id === null) return null;
      if (!restored.has(id)) restored.set(id, (await tasksById(tx, [id])).get(id)?.task ?? null);
      return restored.get(id) ?? null;
    };
    const baseById = new Map(base.tasks.map((t) => [t.id, t]));
    const readBlob = (sha256: string) => this.blobs.read(sha256);
    const keysBut = (id: string | null) =>
      stored.tasks.filter((t) => t.id !== id).map((t) => t.key);

    const evaluate = async (
      id: string | null,
      folder: DraftTaskFolder,
      row: Pick<DraftTaskDbRow, 'baseTaskId' | 'restoredFromTaskId' | 'selfCheck'>,
      removed: boolean,
    ) =>
      evaluateTask({
        folder,
        suiteFolder: draft.sourcePath,
        otherKeys: keysBut(id),
        baseTask: row.baseTaskId ? (baseById.get(row.baseTaskId) ?? null) : null,
        restoredFrom: await restoredTask(row.restoredFromTaskId),
        removed,
        selfCheck: row.selfCheck,
        readBlob,
        now: () => now,
      });

    const ctx: WriteContext = {
      tx,
      draft,
      stored,
      base,
      now,
      task(key) {
        const task = stored.tasks.find((t) => t.key === key);
        if (!task) throw notFound(`task ${key} in the draft of ${draft.sourcePath}`);
        return task;
      },
      async change(task, change) {
        const current = folderOf(stored, task);
        const folder: DraftTaskFolder = {
          key: change.key ?? task.key,
          taskYaml: change.taskYaml !== undefined ? change.taskYaml : current.taskYaml,
          prompt: change.prompt !== undefined ? change.prompt : current.prompt,
          reference: change.reference !== undefined ? change.reference : current.reference,
          rubrics: change.rubrics ?? current.rubrics,
          files: change.files ?? current.files,
        };
        const selfCheck = change.selfCheck !== undefined ? change.selfCheck : task.selfCheck;
        const restoredFromTaskId =
          change.restoredFromTaskId !== undefined
            ? change.restoredFromTaskId
            : task.restoredFromTaskId;
        const removed = change.removed ?? task.state === 'removed';
        const evaluated = await evaluate(
          task.id,
          folder,
          { baseTaskId: task.baseTaskId, restoredFromTaskId, selfCheck },
          removed,
        );
        const [row] = await tx
          .update(suiteDraftTasks)
          .set({
            key: folder.key,
            taskYaml: folder.taskYaml,
            prompt: folder.prompt,
            reference: folder.reference,
            rubrics: { ...folder.rubrics },
            state: evaluated.state,
            restoredFromTaskId: evaluated.restoredFromTaskId,
            contentHash: evaluated.contentHash,
            readiness: evaluated.readiness,
            selfCheck,
            revision: task.revision + 1,
            updatedAt: now,
          })
          .where(eq(suiteDraftTasks.id, task.id))
          .returning();
        if (change.files !== undefined) await setTaskFiles(tx, task.id, change.files);
        const index = stored.tasks.indexOf(task);
        stored.tasks[index] = row!;
        stored.files.set(
          task.id,
          folder.files.map((f) => ({ draftTaskId: task.id, ...f })),
        );
        return row!;
      },
      async insert(folder, options) {
        if (stored.tasks.some((t) => t.key === folder.key)) {
          throw conflict(`${folder.key} is already a task in ${draft.sourcePath}.`);
        }
        const position =
          options.position ?? Math.max(-1, ...stored.tasks.map((t) => t.position)) + 1;
        // A task placed among others moves the ones from its place down by one.
        for (const other of stored.tasks.filter((t) => t.position >= position)) {
          other.position += 1;
          await tx
            .update(suiteDraftTasks)
            .set({ position: other.position })
            .where(eq(suiteDraftTasks.id, other.id));
        }
        const row0 = {
          baseTaskId: options.baseTaskId ?? null,
          restoredFromTaskId: options.restoredFromTaskId ?? null,
          selfCheck: options.selfCheck ?? null,
        };
        const evaluated = await evaluate(null, folder, row0, false);
        const [row] = await tx
          .insert(suiteDraftTasks)
          .values({
            draftId: draft.id,
            key: folder.key,
            position,
            state: evaluated.state,
            baseTaskId: row0.baseTaskId,
            restoredFromTaskId: evaluated.restoredFromTaskId,
            taskYaml: folder.taskYaml,
            prompt: folder.prompt,
            reference: folder.reference,
            rubrics: { ...folder.rubrics },
            contentHash: evaluated.contentHash,
            readiness: evaluated.readiness,
            selfCheck: row0.selfCheck,
            updatedAt: now,
          })
          .returning();
        await setTaskFiles(tx, row!.id, folder.files);
        stored.tasks.push(row!);
        stored.files.set(
          row!.id,
          folder.files.map((f) => ({ draftTaskId: row!.id, ...f })),
        );
        return row!;
      },
      async drop(task) {
        await tx.delete(suiteDraftTasks).where(eq(suiteDraftTasks.id, task.id));
        stored.tasks.splice(stored.tasks.indexOf(task), 1);
        stored.files.delete(task.id);
      },
    };
    return ctx;
  }
}
