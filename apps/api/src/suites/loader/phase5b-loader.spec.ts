/**
 * What Phase 5b adds to the loader, on PGlite with the fixture suites copied
 * into a fresh SUITES_DIR: root files recorded with each version and filled
 * in when a load reuses one, a verifier that cannot run at all failing the
 * directory without recording a version (R7), and the scan that starts a
 * Reload all of one job per directory (Phase 4 question 9).
 */
import { cp, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { SuiteReloadResultSchema } from '@hermes-evals/shared';
import { suites, taskRootFiles, tasks } from '../../database/schema/index.js';
import { useVerifierRunner, VerifierUnavailable } from '../../scoring/verifier-runner.js';
import { BlobStore } from '../../storage/blob-store.js';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { SuiteScanSchema } from './load-suites.handler.js';
import { LOADER_VERSION } from './limits.js';
import { lockDirectory, persistSuite } from './persist.js';
import { readSuiteDirectory } from './read-suite.js';
import { SuiteLoader, type LoaderLogger } from './suite-loader.js';

const FIXTURES = join(import.meta.dirname, '../../../test/fixtures/suites');
vi.setConfig({ testTimeout: 60_000 });

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoaderLogger;

let t: TestDatabase;
let root: string;
let suitesDir: string;
let store: BlobStore;
let loader: SuiteLoader;

beforeEach(async () => {
  t = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'hermes-evals-loader-5b-'));
  suitesDir = join(root, 'suites');
  await cp(FIXTURES, suitesDir, { recursive: true });
  store = new BlobStore(join(root, 'data'));
  loader = new SuiteLoader({ db: t.db, blobs: store, suitesDir, logger });
}, 30_000);

afterEach(async () => {
  useVerifierRunner(null);
  await t.close();
  await rm(root, { recursive: true, force: true });
});

async function rootRows(suiteId: string) {
  return t.db
    .select({
      key: tasks.key,
      path: taskRootFiles.path,
      size: taskRootFiles.size,
      text: taskRootFiles.text,
    })
    .from(taskRootFiles)
    .innerJoin(tasks, eq(tasks.id, taskRootFiles.taskId))
    .where(eq(tasks.suiteId, suiteId))
    .orderBy(asc(tasks.position), asc(taskRootFiles.path));
}

describe('root files', () => {
  it('records task.yaml, prompt.md and reference.json of every task, byte for byte', async () => {
    const [entry] = SuiteReloadResultSchema.parse(await loader.loadOne('complete')).suites;
    const rows = await rootRows(entry!.suiteId!);
    expect(rows.filter((r) => r.key === 'numeric').map((r) => r.path)).toEqual([
      'prompt.md',
      'reference.json',
      'task.yaml',
    ]);
    expect(rows).toHaveLength(15);
    for (const row of rows) {
      const bytes = await readFile(join(suitesDir, 'complete', row.key, row.path));
      expect(row.text).toBe(bytes.toString('utf8'));
      expect(row.size).toBe(bytes.length);
    }
  });

  it('fills them in when a load reuses a version recorded without them', async () => {
    // A version loaded before Phase 5b: recorded from a read whose root files are left out.
    const read = await readSuiteDirectory(suitesDir, 'complete', {
      loaderVersion: LOADER_VERSION,
      scratch: (prefix) => store.scratchDir(prefix),
    });
    if (!read.ok) throw new Error('fixture did not read');
    const bare = { ...read.suite, tasks: read.suite.tasks.map((x) => ({ ...x, rootFiles: [] })) };
    const outcome = await t.db.transaction(async (tx) => {
      await lockDirectory(tx, 'complete');
      return persistSuite(tx, { db: t.db, blobs: store, now: () => new Date(), suitesDir }, bare);
    });
    if (outcome?.outcome !== 'created') throw new Error('not created');
    expect(await rootRows(outcome.suiteId)).toEqual([]);

    const [entry] = (await loader.loadOne('complete')).suites;
    expect(entry).toMatchObject({ outcome: 'unchanged', suiteId: outcome.suiteId });
    expect(await rootRows(outcome.suiteId)).toHaveLength(15);
    // Immutable rows: a second reuse inserts nothing and fails nothing.
    expect((await loader.loadOne('complete')).suites[0]!.outcome).toBe('unchanged');
  });
});

describe('a verifier that cannot run at all', () => {
  it('fails the directory and records no version; the next load with a runner loads it', async () => {
    useVerifierRunner({
      run: () => Promise.reject(new VerifierUnavailable('could not start the verifier container')),
    });
    const [failed] = (await loader.loadOne('complete')).suites;
    expect(failed).toMatchObject({
      outcome: 'error',
      versionNumber: null,
      message: expect.stringContaining('could not start the verifier container'),
    });
    expect(await t.db.select().from(suites)).toEqual([]);

    useVerifierRunner(null);
    const [loaded] = (await loader.loadOne('complete')).suites;
    expect(loaded).toMatchObject({ outcome: 'created', versionNumber: 1 });
  });
});

describe('scan', () => {
  it('marks vanished directories missing and lists the ones on disk, loading nothing', async () => {
    await loader.loadOne('complete');
    await loader.loadOne('mixed');
    await rename(join(suitesDir, 'mixed'), join(root, 'mixed-away'));
    const scan = SuiteScanSchema.parse(await loader.scan());
    expect(scan.directories).toEqual(['complete', 'no-suite-yaml']);
    expect(scan.missing).toEqual([
      expect.objectContaining({ sourcePath: './suites/mixed', outcome: 'missing' }),
    ]);
    expect(await t.db.select({ id: suites.id }).from(suites)).toHaveLength(2);
  });
});
