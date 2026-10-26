/**
 * Database access for suite drafts (plan 4.6; migration 0009): the draft,
 * its tasks and their files, and the stored suite versions a draft starts
 * from, restores from or is compared with. Plain functions over AppDb and
 * AppTx, so they run on node-postgres in production and PGlite in tests.
 *
 * Every write to a draft happens in one transaction that first locks the
 * draft's row (lockDraft), so two edits of one draft never interleave and
 * the revision counters stay exact.
 */
import { and, asc, desc, eq, inArray, max, ne, or } from 'drizzle-orm';
import {
  blobs,
  suiteDraftFiles,
  suiteDrafts,
  suiteDraftTasks,
  suiteSources,
  suites,
  tasks,
} from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import { filesOf, rootFilesOf, tasksOf } from '../suites.queries.js';
import type { SuiteRow, TaskFileRow, TaskRootFileRow, TaskRow } from '../views/rows.js';
import { draftTaskFolderOf, type DraftFileRef, type DraftTaskFolder } from './materialise.js';

export type DraftRow = typeof suiteDrafts.$inferSelect;
export type DraftTaskDbRow = typeof suiteDraftTasks.$inferSelect;
export type DraftFileDbRow = typeof suiteDraftFiles.$inferSelect;

/** A draft with every task and file, tasks in draft order (position, then key). */
export interface StoredDraft {
  draft: DraftRow;
  tasks: DraftTaskDbRow[];
  /** Files by draft task id, by path. */
  files: Map<string, DraftFileDbRow[]>;
}

/** A stored task version with its files and recorded root texts. */
export interface StoredTask {
  task: TaskRow;
  suite: SuiteRow;
  files: TaskFileRow[];
  roots: TaskRootFileRow[];
}

export async function draftByFolder(db: AppDb, folder: string): Promise<DraftRow | null> {
  const [row] = await db.select().from(suiteDrafts).where(eq(suiteDrafts.sourcePath, folder));
  return row ?? null;
}

/** The draft of `folder`, its row locked until the transaction ends. */
export async function lockDraft(tx: AppTx, folder: string): Promise<DraftRow | null> {
  const [row] = await tx
    .select()
    .from(suiteDrafts)
    .where(eq(suiteDrafts.sourcePath, folder))
    .for('update');
  return row ?? null;
}

export async function listDrafts(db: AppDb): Promise<DraftRow[]> {
  return db.select().from(suiteDrafts).orderBy(desc(suiteDrafts.updatedAt));
}

/** The draft's tasks and files. */
export async function loadDraft(db: AppDb, draft: DraftRow): Promise<StoredDraft> {
  const taskRows = await db
    .select()
    .from(suiteDraftTasks)
    .where(eq(suiteDraftTasks.draftId, draft.id))
    .orderBy(asc(suiteDraftTasks.position), asc(suiteDraftTasks.key));
  const files = new Map<string, DraftFileDbRow[]>(taskRows.map((t) => [t.id, []]));
  if (taskRows.length > 0) {
    const rows = await db
      .select()
      .from(suiteDraftFiles)
      .where(
        inArray(
          suiteDraftFiles.draftTaskId,
          taskRows.map((t) => t.id),
        ),
      )
      .orderBy(asc(suiteDraftFiles.path));
    for (const row of rows) files.get(row.draftTaskId)?.push(row);
  }
  return { draft, tasks: taskRows, files };
}

/** One draft task as the folder it stands for. */
export const folderOf = (stored: StoredDraft, task: DraftTaskDbRow): DraftTaskFolder =>
  draftTaskFolderOf(task, stored.files.get(task.id) ?? []);

/** The highest version number a folder has had; 0 for none. */
export async function highestVersion(db: AppDb, folder: string): Promise<number> {
  const [row] = await db
    .select({ n: max(suites.versionNumber) })
    .from(suites)
    .where(eq(suites.sourcePath, folder));
  return row?.n ?? 0;
}

export async function suiteVersion(
  db: AppDb,
  folder: string,
  versionNumber: number,
): Promise<SuiteRow | null> {
  const [row] = await db
    .select()
    .from(suites)
    .where(and(eq(suites.sourcePath, folder), eq(suites.versionNumber, versionNumber)));
  return row ?? null;
}

/** Every task of a suite version with its files and root texts, in suite order. */
export async function storedTasks(
  db: AppDb,
  suite: SuiteRow,
  keys?: readonly string[],
): Promise<StoredTask[]> {
  const rows = (await tasksOf(db, [suite.id])).filter((t) => !keys || keys.includes(t.key));
  const ids = rows.map((t) => t.id);
  const [files, roots] = await Promise.all([filesOf(db, ids), rootFilesOf(db, ids)]);
  return rows.map((task) => ({
    task,
    suite,
    files: files.filter((f) => f.taskId === task.id),
    roots: roots.filter((r) => r.taskId === task.id),
  }));
}

/** Task rows by id, with their suite version: the base and restored-from tasks a view names. */
export async function tasksById(
  db: AppDb,
  ids: readonly string[],
): Promise<Map<string, { task: TaskRow; suite: SuiteRow }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ task: tasks, suite: suites })
    .from(tasks)
    .innerJoin(suites, eq(suites.id, tasks.suiteId))
    .where(inArray(tasks.id, unique));
  return new Map(rows.map((r) => [r.task.id, r]));
}

/** Registers each distinct blob a file names (its bytes are in the store already). */
export async function recordBlobs(tx: AppDb, refs: readonly DraftFileRef[]): Promise<void> {
  const unique = new Map(refs.map((r) => [r.sha256, r.size]));
  if (unique.size === 0) return;
  await tx
    .insert(blobs)
    .values([...unique].map(([sha256, size]) => ({ sha256, size })))
    .onConflictDoNothing();
}

/** Replaces every file row of a draft task. */
export async function setTaskFiles(
  tx: AppDb,
  draftTaskId: string,
  refs: readonly DraftFileRef[],
): Promise<void> {
  await tx.delete(suiteDraftFiles).where(eq(suiteDraftFiles.draftTaskId, draftTaskId));
  if (refs.length === 0) return;
  await recordBlobs(tx, refs);
  await tx.insert(suiteDraftFiles).values(
    refs.map((r) => ({
      draftTaskId,
      path: r.path,
      kind: r.kind,
      sha256: r.sha256,
      size: r.size,
    })),
  );
}

/** The live folder whose path or suite.yaml name is `name` (one not gone missing), or null. */
export async function folderHoldingName(db: AppDb, name: string): Promise<string | null> {
  const [row] = await db
    .select({ path: suiteSources.path })
    .from(suiteSources)
    .where(
      and(
        ne(suiteSources.lastOutcome, 'missing'),
        or(eq(suiteSources.path, name), eq(suiteSources.name, name)),
      ),
    )
    .limit(1);
  return row?.path ?? null;
}

/** The draft holding `name` as its folder or suite name, or null. */
export async function draftHoldingName(db: AppDb, name: string): Promise<string | null> {
  const [row] = await db
    .select({ path: suiteDrafts.sourcePath })
    .from(suiteDrafts)
    .where(or(eq(suiteDrafts.sourcePath, name), eq(suiteDrafts.name, name)))
    .limit(1);
  return row?.path ?? null;
}
