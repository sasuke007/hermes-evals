/**
 * Writes one directory's load to the database (plan 4.4 steps 2 to 4). The
 * loader (suite-loader.ts) opens one transaction per directory, takes the
 * directory's advisory lock (lockDirectory) and only then reads the files, so
 * the read, the self-checks and these writes are one serialised unit: two
 * loads of one directory (the start-up pass and a reload job, or two workers)
 * never interleave, and the later one always reads the later files.
 *
 * - Every load, whatever its outcome, first makes sure each distinct file is
 *   in the blob store and has its row (storeBlobs), so a reload of unchanged
 *   files repairs a blob store that lost files.
 * - Same content hash and check hash as an existing version: that row is
 *   reused, `unchanged` when it is current, `reverted` when it is older and
 *   the pointer moves back to it.
 * - Otherwise a new suites row (v = highest + 1) with its tasks and task
 *   files, inserted in chunks under the bind-parameter limit.
 * - A task keeps its version number and introducing suite when an earlier
 *   version of this directory had the same key and content hash; otherwise
 *   it takes the key's highest number plus one and is introduced here.
 * - A failed load records the error and leaves the pointer alone. A vanished
 *   directory becomes `missing`, which releases its name (partial index
 *   suite_sources_name_uq) but keeps the pointer for old experiments. Both
 *   re-check the disk under the lock, so a stale decision never overwrites a
 *   newer load.
 *
 * Suites, tasks and task files are immutable (0001 triggers): nothing here
 * updates or deletes them.
 */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { SuiteChanges } from '@hermes-evals/shared';
import { newId } from '../../database/ids.js';
import { storable, toJsonb } from '../../database/schema/_columns.js';
import { blobs, suiteSources, suites, taskFiles, tasks } from '../../database/schema/index.js';
import type { AppDb, AppTx } from '../../database/types.js';
import type { BlobRef, BlobStore } from '../../storage/blob-store.js';
import { noChanges, suiteChanges, type TaskState } from './changes.js';
import { SUITE_LOCK_PREFIX, SUITE_YAML } from './limits.js';
import type { LoadedSuite } from './read-suite.js';
import { namePosition } from './suite-yaml.js';
import { locatedError, toStoredError, type LocatedError } from './yaml-source.js';

export interface PersistDeps {
  db: AppDb;
  blobs: BlobStore;
  now: () => Date;
  /** SUITES_DIR, resolved: where the disk is re-checked under the lock. */
  suitesDir: string;
}

/**
 * Rows per multi-row insert. A statement has at most 65,535 bind parameters;
 * a task row has 17 and a task file row 5, so 1,000 rows stay well under.
 */
export const INSERT_CHUNK_ROWS = 1000;

/** A load that leaves a version current. */
export interface ServedOutcome {
  outcome: 'created' | 'unchanged' | 'reverted';
  path: string;
  name: string;
  suiteId: string;
  versionNumber: number;
  changes: SuiteChanges;
  /** created only: no version of the directory was current before. */
  first: boolean;
  /** created only: the latest earlier version with the same files (only the check hash differs). */
  sameFilesAs: number | null;
}

export interface ErrorOutcome {
  outcome: 'error';
  path: string;
  name: string | null;
  error: LocatedError;
  /** When the error was recorded (suite_sources.last_attempted_at). */
  attemptedAt?: Date;
  /** Set when the suite name is held by this other directory; the loader retries these. */
  nameTakenBy?: string;
}

export type DirectoryOutcome =
  ServedOutcome | ErrorOutcome | { outcome: 'missing'; path: string; name: string | null };

type SourceRow = typeof suiteSources.$inferSelect;

/** Serialises loads of one directory until the transaction ends. */
export async function lockDirectory(tx: AppTx, path: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${SUITE_LOCK_PREFIX + path}, 0))`,
  );
}

async function sourceRow(tx: AppTx, path: string): Promise<SourceRow | null> {
  const [row] = await tx.select().from(suiteSources).where(eq(suiteSources.path, path));
  return row ?? null;
}

/** The other live directory that holds `name`, if any. */
async function nameHolder(tx: AppTx, name: string, path: string): Promise<string | null> {
  const [row] = await tx
    .select({ path: suiteSources.path })
    .from(suiteSources)
    .where(
      and(
        eq(suiteSources.name, name),
        ne(suiteSources.path, path),
        ne(suiteSources.lastOutcome, 'missing'),
      ),
    )
    .limit(1);
  return row?.path ?? null;
}

async function taskStates(tx: AppTx, suiteId: string): Promise<TaskState[]> {
  return tx
    .select({ key: tasks.key, contentHash: tasks.contentHash, valid: tasks.valid })
    .from(tasks)
    .where(eq(tasks.suiteId, suiteId))
    .orderBy(asc(tasks.position));
}

/** The error a second directory gets for a suite name another directory holds. */
export function nameTakenError(
  suite: Pick<LoadedSuite, 'yaml' | 'yamlSource'>,
  holder: string,
): LocatedError {
  return locatedError(
    SUITE_YAML,
    suite.yamlSource,
    namePosition(suite.yamlSource),
    `suite name ${suite.yaml.name} is already used by directory ${holder}; give one of them another name`,
  );
}

/**
 * Whether the directory is on disk now, as a folder or a link (which loads as
 * an error); checked under the lock.
 */
async function onDisk(deps: PersistDeps, path: string): Promise<boolean> {
  try {
    const stat = await lstat(join(deps.suitesDir, path));
    return stat.isDirectory() || stat.isSymbolicLink();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

/**
 * Records a loaded suite, inside the caller's locked transaction. With
 * `onlyAfter`, the write happens only while the directory's last load is
 * still the error recorded at that time: the loader's name-conflict retry
 * reuses a read from an earlier transaction, and must not overwrite a load
 * that came in between. Null when it did not write.
 */
export async function persistSuite(
  tx: AppTx,
  deps: PersistDeps,
  suite: LoadedSuite,
  onlyAfter?: Date,
): Promise<DirectoryOutcome | null> {
  const now = deps.now();
  const source = await sourceRow(tx, suite.path);
  if (
    onlyAfter &&
    (source?.lastOutcome !== 'error' || source.lastAttemptedAt.getTime() !== onlyAfter.getTime())
  ) {
    return null;
  }
  const holder = await nameHolder(tx, suite.yaml.name, suite.path);
  if (holder !== null) {
    // A directory whose suite.yaml no longer declares its old name lets it
    // go, so two directories can swap names (the loader retries the loser).
    const outcome = await writeError(tx, source, suite.path, nameTakenError(suite, holder), now, {
      releaseName: source?.name !== suite.yaml.name,
    });
    return { ...outcome, nameTakenBy: holder };
  }

  await storeBlobs(tx, deps.blobs, suite);
  const previous = source?.currentSuiteId ? await taskStates(tx, source.currentSuiteId) : null;
  const [existing] = await tx
    .select({ id: suites.id, versionNumber: suites.versionNumber })
    .from(suites)
    .where(
      and(
        eq(suites.sourcePath, suite.path),
        eq(suites.contentHash, suite.contentHash),
        eq(suites.checkHash, suite.checkHash),
      ),
    );

  let result: ServedOutcome;
  if (existing) {
    const unchanged = existing.id === source?.currentSuiteId;
    result = {
      outcome: unchanged ? 'unchanged' : 'reverted',
      path: suite.path,
      name: suite.yaml.name,
      suiteId: existing.id,
      versionNumber: existing.versionNumber,
      changes: unchanged ? noChanges() : suiteChanges(previous, await taskStates(tx, existing.id)),
      first: false,
      sameFilesAs: null,
    };
  } else {
    result = await insertVersion(tx, suite, previous, now);
  }

  await tx
    .insert(suiteSources)
    .values({
      path: suite.path,
      name: suite.yaml.name,
      currentSuiteId: result.suiteId,
      lastAttemptedAt: now,
      lastOutcome: result.outcome,
      lastError: null,
      lastChanges: result.changes,
    })
    .onConflictDoUpdate({
      target: suiteSources.path,
      set: {
        name: suite.yaml.name,
        currentSuiteId: result.suiteId,
        lastAttemptedAt: now,
        lastOutcome: result.outcome,
        lastError: null,
        lastChanges: result.changes,
      },
    });
  return result;
}

/**
 * Plan 4.4 step 2: every distinct file of the suite is in the blob store
 * (temp, fsync, rename; putBuffer returns at once for a file that exists)
 * and has its row. Rows go in ascending sha256 order, so two loads that
 * share new files take those row locks in one global order and cannot
 * deadlock; a row means its file exists, so files are written first.
 */
async function storeBlobs(tx: AppTx, store: BlobStore, suite: LoadedSuite): Promise<void> {
  const distinct = new Map<string, { content: Buffer; where: string }>();
  for (const task of suite.tasks) {
    for (const file of task.files) {
      if (!distinct.has(file.sha256)) {
        distinct.set(file.sha256, { content: file.content, where: `${task.key}/${file.path}` });
      }
    }
  }
  const refs: BlobRef[] = [];
  for (const [sha256, file] of distinct) {
    const ref = await store.putBuffer(file.content);
    if (ref.sha256 !== sha256) throw new Error(`blob hash mismatch for ${file.where}`);
    refs.push(ref);
  }
  refs.sort((a, b) => (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0));
  for (let i = 0; i < refs.length; i += INSERT_CHUNK_ROWS) {
    await tx
      .insert(blobs)
      .values(refs.slice(i, i + INSERT_CHUNK_ROWS).map(({ sha256, size }) => ({ sha256, size })))
      .onConflictDoNothing();
  }
}

async function insertVersion(
  tx: AppTx,
  suite: LoadedSuite,
  previous: TaskState[] | null,
  now: Date,
): Promise<ServedOutcome> {
  const versions = await tx
    .select({ versionNumber: suites.versionNumber, contentHash: suites.contentHash })
    .from(suites)
    .where(eq(suites.sourcePath, suite.path));
  const versionNumber = Math.max(0, ...versions.map((v) => v.versionNumber)) + 1;
  const sameFiles = versions
    .filter((v) => v.contentHash === suite.contentHash)
    .map((v) => v.versionNumber);

  const suiteId = newId();
  await tx.insert(suites).values({
    id: suiteId,
    sourcePath: suite.path,
    versionNumber,
    name: suite.yaml.name,
    versionLabel: storable(suite.yaml.version_label),
    description: suite.yaml.description === undefined ? null : storable(suite.yaml.description),
    contentHash: suite.contentHash,
    checkHash: suite.checkHash,
    taskCount: suite.tasks.length,
    validCount: suite.tasks.filter((t) => t.valid).length,
    loadedAt: now,
  });

  const numbering = await taskNumbering(tx, suite.path);
  const taskRows = suite.tasks.map((task) => {
    const reuse = numbering.byContent.get(`${task.key}\0${task.contentHash}`);
    return {
      id: newId(),
      suiteId,
      key: task.key,
      versionNumber: reuse?.versionNumber ?? (numbering.maxByKey.get(task.key) ?? 0) + 1,
      introducedInSuiteId: reuse?.introducedInSuiteId ?? suiteId,
      position: task.position,
      summary: task.summary === null ? null : storable(task.summary),
      prompt: task.prompt,
      taskYaml: task.taskYaml,
      limits: task.limits,
      reference: task.reference === undefined ? null : toJsonb(task.reference),
      verification: task.verification,
      selfCheck: task.selfCheck,
      loadIssues: task.issues,
      valid: task.valid,
      invalidReason: task.invalidReason === null ? null : storable(task.invalidReason),
      contentHash: task.contentHash,
    };
  });
  for (let i = 0; i < taskRows.length; i += INSERT_CHUNK_ROWS) {
    await tx.insert(tasks).values(taskRows.slice(i, i + INSERT_CHUNK_ROWS));
  }

  const fileRows = suite.tasks.flatMap((task, i) =>
    task.files.map((file) => ({
      taskId: taskRows[i]!.id,
      path: file.path,
      kind: file.kind,
      sha256: file.sha256,
      size: file.size,
    })),
  );
  for (let i = 0; i < fileRows.length; i += INSERT_CHUNK_ROWS) {
    await tx.insert(taskFiles).values(fileRows.slice(i, i + INSERT_CHUNK_ROWS));
  }

  return {
    outcome: 'created',
    path: suite.path,
    name: suite.yaml.name,
    suiteId,
    versionNumber,
    changes: suiteChanges(previous, suite.tasks),
    first: previous === null,
    sameFilesAs: sameFiles.length > 0 ? Math.max(...sameFiles) : null,
  };
}

interface TaskNumbering {
  /** `key\0contentHash` → the first version of the directory that held that content. */
  byContent: Map<string, { versionNumber: number; introducedInSuiteId: string }>;
  maxByKey: Map<string, number>;
}

async function taskNumbering(tx: AppTx, path: string): Promise<TaskNumbering> {
  const rows = await tx
    .select({
      key: tasks.key,
      contentHash: tasks.contentHash,
      versionNumber: tasks.versionNumber,
      introducedInSuiteId: tasks.introducedInSuiteId,
      suiteNumber: suites.versionNumber,
    })
    .from(tasks)
    .innerJoin(suites, eq(suites.id, tasks.suiteId))
    .where(eq(suites.sourcePath, path))
    .orderBy(asc(suites.versionNumber));
  const numbering: TaskNumbering = { byContent: new Map(), maxByKey: new Map() };
  for (const row of rows) {
    const id = `${row.key}\0${row.contentHash}`;
    if (!numbering.byContent.has(id)) numbering.byContent.set(id, row);
    numbering.maxByKey.set(
      row.key,
      Math.max(numbering.maxByKey.get(row.key) ?? 0, row.versionNumber),
    );
  }
  return numbering;
}

/**
 * Records a failed load. The pointer stays on the last good version. The
 * name stays too, unless `releaseName` (suite.yaml now declares another name)
 * or another live directory has taken it meanwhile (a directory that was
 * missing and came back), which the unique index forbids.
 */
async function writeError(
  tx: AppTx,
  source: SourceRow | null,
  path: string,
  error: LocatedError,
  now: Date,
  options: { releaseName?: boolean } = {},
): Promise<ErrorOutcome> {
  let name = options.releaseName ? null : (source?.name ?? null);
  if (name !== null && (await nameHolder(tx, name, path)) !== null) name = null;
  const values = {
    name,
    lastAttemptedAt: now,
    lastOutcome: 'error' as const,
    lastError: toStoredError(error),
    lastChanges: null,
  };
  await tx
    .insert(suiteSources)
    .values({ path, currentSuiteId: null, ...values })
    .onConflictDoUpdate({ target: suiteSources.path, set: values });
  return { outcome: 'error', path, name, error, attemptedAt: now };
}

/**
 * Records a failed load inside the caller's locked transaction. A directory
 * that is no longer on disk (it vanished during the read) is recorded as
 * missing instead, so it does not keep a name a renamed copy now declares.
 */
export async function persistError(
  tx: AppTx,
  deps: PersistDeps,
  path: string,
  error: LocatedError,
): Promise<DirectoryOutcome> {
  if (!(await onDisk(deps, path))) {
    return (await markMissing(tx, deps, path)) ?? { outcome: 'missing', path, name: null };
  }
  return writeError(tx, await sourceRow(tx, path), path, error, deps.now());
}

/**
 * Marks a directory that is no longer on disk, inside the caller's locked
 * transaction. Null when the loader never saw it, or when it is back on disk
 * (renamed away and back): then the row is left for the next load to read.
 */
export async function markMissing(
  tx: AppTx,
  deps: PersistDeps,
  path: string,
): Promise<DirectoryOutcome | null> {
  const source = await sourceRow(tx, path);
  if (!source) return null;
  if (await onDisk(deps, path)) return null;
  await tx
    .update(suiteSources)
    .set({
      lastOutcome: 'missing',
      lastAttemptedAt: deps.now(),
      lastError: null,
      lastChanges: null,
    })
    .where(eq(suiteSources.path, path));
  return { outcome: 'missing', path, name: source.name };
}

/** Every directory the database knows and has not already marked missing. */
export async function liveDirectories(db: AppDb): Promise<string[]> {
  const rows = await db
    .select({ path: suiteSources.path })
    .from(suiteSources)
    .where(ne(suiteSources.lastOutcome, 'missing'));
  return rows.map((r) => r.path);
}
