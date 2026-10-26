/**
 * Combine onto the newer version (POST /suites/:suite/draft/rebase, board
 * SA.12): the draft's base moves to the folder's current version, which a
 * reload or a save that found edits on disk created. Database work only:
 * the version is stored, so nothing reads the disk.
 *
 * Per draft task, by its identity in the folder (its base key, else its key):
 *
 * - a task the draft did not touch, and a task of the overlap the user chose
 *   to take `disk` for, follow the new version: its files there, or gone
 *   when the version no longer has it;
 * - every other task keeps the draft's content and is checked again
 *   against the new version's task of the same identity (`changed`, or
 *   `unchanged` when the disk made the same edit); a task both sides
 *   removed is dropped;
 * - a task the new version added that the draft does not hold joins the
 *   draft, unchanged, after the others.
 *
 * The draft's revision goes up, and every task's readiness is checked again.
 */
import { ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DraftConflict, RebaseSuiteDraftRequest } from '@hermes-evals/shared';
import { suiteDrafts, suiteDraftTasks } from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import type { BlobStore } from '../../storage/blob-store.js';
import { baseTaskFolder } from '../drafts/draft-folder.js';
import { evaluateTask, recordOf } from '../drafts/draft-evaluate.js';
import {
  folderOf,
  loadDraft,
  lockDraft,
  setTaskFiles,
  storedTasks,
  tasksById,
  type DraftTaskDbRow,
  type StoredDraft,
  type StoredTask,
} from '../drafts/draft-store.js';
import { conflict, draftBase, isSaving } from '../drafts/draft-writer.js';
import type { DraftTaskFolder } from '../drafts/materialise.js';
import { badRequest, notFound } from '../http-errors.js';
import { sourceOf, suiteById } from '../suites.queries.js';
import { suiteDisplayPath } from '../views/format.js';
import { baseKeysOf, conflictOf } from './conflict.js';

/** The 409 of a rebase whose `onto` is no longer the folder's current version. */
export const movedAgain = (folder: string, conflictBody: DraftConflict): ConflictException =>
  new ConflictException({
    statusCode: 409,
    message: `${suiteDisplayPath(folder)} changed again: its current version is v${conflictBody.current.versionNumber}.`,
    conflict: conflictBody,
  });

export async function rebaseDraft(
  db: AppDb,
  blobs: Pick<BlobStore, 'read'>,
  folder: string,
  request: RebaseSuiteDraftRequest,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    const draft = await lockDraft(tx, folder);
    if (!draft) throw notFound(`draft of ${folder}`);
    if (isSaving(draft, now))
      throw conflict(`${folder} is being saved; edits wait until the save ends`);
    if (draft.origin !== 'edit') {
      throw badRequest('Only the draft of a suite on disk has a version to combine onto.');
    }
    const source = await sourceOf(tx, folder);
    const current = source?.currentSuiteId ? await suiteById(tx, source.currentSuiteId) : null;
    if (current === null) throw notFound(`suite ${folder}`);
    const stored = await loadDraft(tx, draft);
    if (current.id === draft.baseSuiteId) return;
    const found = await conflictOf(tx, stored, current, 'version_moved');
    if (current.versionNumber !== request.onto) throw movedAgain(folder, found);
    const choices = new Map(request.choices.map((c) => [c.key, c.keep]));
    const missing = found.overlap.filter((key) => !choices.has(key));
    if (missing.length > 0) {
      throw badRequest(`Choose which version to keep of ${missing.join(', ')} before combining.`);
    }

    const baseKeys = baseKeysOf(await draftBase(tx, draft), stored);
    const newTasks = await storedTasks(tx, current);
    const byKey = new Map(newTasks.map((t) => [t.task.key, t]));
    const read = (sha256: string) => blobs.read(sha256);
    const used = new Set<string>();
    const keys = new Set(stored.tasks.map((t) => t.key));
    const restored = await tasksById(
      tx,
      stored.tasks.flatMap((t) => (t.restoredFromTaskId ? [t.restoredFromTaskId] : [])),
    );
    const store = storeTask(tx, stored, folder, read, now);

    // A copy: drop() takes tasks out of stored.tasks as the loop goes.
    for (const task of stored.tasks.slice()) {
      const disk = byKey.get(baseKeys.get(task.id) ?? task.key) ?? null;
      const followDisk = task.state === 'unchanged' || choices.get(task.key) === 'disk';
      if (followDisk) {
        // The key it would take back must be free (the draft may have reused it).
        if (disk === null || (disk.task.key !== task.key && keys.has(disk.task.key))) {
          await drop(tx, stored, task);
          keys.delete(task.key);
          continue;
        }
        used.add(disk.task.key);
        keys.delete(task.key);
        keys.add(disk.task.key);
        const { folder: files } = await baseTaskFolder(disk.task, disk.files, disk.roots, read);
        await store(task, files, disk, null, false, recordOf(disk.task));
        continue;
      }
      if (task.state === 'removed' && disk === null) {
        await drop(tx, stored, task);
        keys.delete(task.key);
        continue;
      }
      if (disk !== null) used.add(disk.task.key);
      const restoredFrom = task.restoredFromTaskId
        ? (restored.get(task.restoredFromTaskId)?.task ?? null)
        : null;
      await store(
        task,
        folderOf(stored, task),
        disk,
        restoredFrom,
        task.state === 'removed',
        task.selfCheck,
      );
    }

    let position = Math.max(-1, ...stored.tasks.map((t) => t.position));
    for (const added of newTasks) {
      if (used.has(added.task.key) || keys.has(added.task.key)) continue;
      const { folder: files } = await baseTaskFolder(added.task, added.files, added.roots, read);
      const [row] = await tx
        .insert(suiteDraftTasks)
        .values({
          draftId: draft.id,
          key: added.task.key,
          position: (position += 1),
          state: 'unchanged',
          baseTaskId: added.task.id,
          contentHash: added.task.contentHash,
          rubrics: {},
          updatedAt: now,
        })
        .returning();
      stored.tasks.push(row!);
      await store(row!, files, added, null, false, recordOf(added.task));
    }

    await tx
      .update(suiteDrafts)
      .set({ baseSuiteId: current.id, revision: draft.revision + 1, updatedAt: now })
      .where(eq(suiteDrafts.id, draft.id));
  });
}

async function drop(tx: AppTx, stored: StoredDraft, task: DraftTaskDbRow): Promise<void> {
  await tx.delete(suiteDraftTasks).where(eq(suiteDraftTasks.id, task.id));
  stored.tasks.splice(stored.tasks.indexOf(task), 1);
}

/**
 * Writes one task's content against its new base (or none), checked again
 * as any edit is: its state, content hash and readiness.
 */
function storeTask(
  tx: AppTx,
  stored: StoredDraft,
  suiteFolder: string,
  read: (sha256: string) => Promise<Buffer>,
  now: Date,
) {
  return async (
    task: DraftTaskDbRow,
    folder: DraftTaskFolder,
    base: StoredTask | null,
    restoredFrom: StoredTask['task'] | null,
    removed: boolean,
    selfCheck: DraftTaskDbRow['selfCheck'],
  ): Promise<void> => {
    const evaluated = await evaluateTask({
      folder,
      suiteFolder,
      otherKeys: stored.tasks.filter((t) => t.id !== task.id).map((t) => t.key),
      baseTask: base?.task ?? null,
      restoredFrom,
      removed,
      selfCheck,
      readBlob: read,
      now: () => now,
    });
    await tx
      .update(suiteDraftTasks)
      .set({
        key: folder.key,
        taskYaml: folder.taskYaml,
        prompt: folder.prompt,
        reference: folder.reference,
        rubrics: { ...folder.rubrics },
        baseTaskId: base?.task.id ?? null,
        state: evaluated.state,
        restoredFromTaskId: evaluated.restoredFromTaskId,
        contentHash: evaluated.contentHash,
        readiness: evaluated.readiness,
        selfCheck,
        revision: task.revision + 1,
        updatedAt: now,
      })
      .where(eq(suiteDraftTasks.id, task.id));
    await setTaskFiles(tx, task.id, folder.files);
  };
}
