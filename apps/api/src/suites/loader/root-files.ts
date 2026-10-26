/**
 * task_root_files (Phase 5b): task.yaml, prompt.md and reference.json of each
 * task version exactly as the loader read them, with their size and hash,
 * and their text when it is UTF-8. A task diff shows their sizes and hashes
 * beside the task files', and a draft of the task starts from these bytes, so
 * a file nobody edits is written back unchanged (plan 4.6).
 *
 * Rows are written with a new version's tasks, and also when a load reuses a
 * version (`unchanged`, `reverted`): versions loaded before Phase 5b have
 * none, and the same content hash means the same bytes, so the next load
 * fills them in. Rows are immutable (0009), hence ON CONFLICT DO NOTHING.
 */
import { eq } from 'drizzle-orm';
import {
  TASK_ROOT_FILES,
  taskRootFiles,
  tasks,
  type TaskRootFile,
} from '../../database/schema/index.js';
import type { AppTx } from '../../database/types.js';
import type { RootFileRead } from './task.js';

/** Rows per insert: five bind parameters a row, far under the 65,535 limit. */
const CHUNK = 1000;

const isRootFile = (path: string): path is TaskRootFile =>
  (TASK_ROOT_FILES as readonly string[]).includes(path);

/** Records the root files of tasks just inserted, or of a version that has none yet. */
export async function insertRootFiles(
  tx: AppTx,
  rows: ReadonlyArray<{ taskId: string; files: readonly RootFileRead[] }>,
): Promise<void> {
  const values = rows.flatMap(({ taskId, files }) =>
    files
      .filter((f) => isRootFile(f.path))
      .map((f) => ({
        taskId,
        path: f.path as TaskRootFile,
        sha256: f.sha256,
        size: f.size,
        text: f.text,
      })),
  );
  for (let i = 0; i < values.length; i += CHUNK) {
    await tx
      .insert(taskRootFiles)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoNothing();
  }
}

/**
 * Fills in the root files of a reused version from what this load read: the
 * same content hash, so each task key holds the same bytes.
 */
export async function backfillRootFiles(
  tx: AppTx,
  suiteId: string,
  read: ReadonlyArray<{ key: string; rootFiles: readonly RootFileRead[] }>,
): Promise<void> {
  const stored = await tx
    .select({ id: tasks.id, key: tasks.key })
    .from(tasks)
    .where(eq(tasks.suiteId, suiteId));
  const byKey = new Map(read.map((task) => [task.key, task.rootFiles]));
  await insertRootFiles(
    tx,
    stored.flatMap(({ id, key }) => {
      const files = byKey.get(key);
      return files ? [{ taskId: id, files }] : [];
    }),
  );
}
