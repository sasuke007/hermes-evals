/**
 * A folder read without its suite.yaml is read once more, 2 s later, before
 * the loader records it (Phase 5b question 20, settled for Phase 7): through
 * macOS file sharing a folder deleted on the host stays listed, empty, for
 * about a second, and the second read finds it gone, so it is recorded
 * missing rather than as "suite.yaml not found". On PGlite with the fixture
 * suites; the wait is caught here, so the test does not sleep.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SuiteReloadResultSchema } from '@hermes-evals/shared';
import { BlobStore } from '../../storage/blob-store.js';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { SUITE_YAML_RETRY_MS, SuiteLoader, type LoaderLogger } from './suite-loader.js';

const waits = vi.hoisted(() => ({
  ms: [] as number[],
  /** What happens on disk while the loader waits. */
  meanwhile: null as (() => Promise<void>) | null,
}));

vi.mock('node:timers/promises', async (original) => {
  const actual = await original<typeof import('node:timers/promises')>();
  return {
    ...actual,
    setTimeout: async (ms: number) => {
      waits.ms.push(ms);
      await waits.meanwhile?.();
    },
  };
});

const FIXTURES = join(import.meta.dirname, '../../../test/fixtures/suites');
vi.setConfig({ testTimeout: 60_000 });

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoaderLogger;

let t: TestDatabase;
let root: string;
let suitesDir: string;
let loader: SuiteLoader;

beforeEach(async () => {
  waits.ms = [];
  waits.meanwhile = null;
  t = await createTestDatabase();
  root = await mkdtemp(join(tmpdir(), 'hermes-evals-loader-retry-'));
  suitesDir = join(root, 'suites');
  await cp(FIXTURES, suitesDir, { recursive: true });
  loader = new SuiteLoader({
    db: t.db,
    blobs: new BlobStore(join(root, 'data')),
    suitesDir,
    logger,
  });
}, 30_000);

afterEach(async () => {
  await t.close();
  await rm(root, { recursive: true, force: true });
});

const loadOne = async (path: string) =>
  SuiteReloadResultSchema.parse(await loader.loadOne(path)).suites[0]!;

describe('a folder read without its suite.yaml', () => {
  it('is recorded missing when the second read, 2 s later, finds it gone', async () => {
    expect((await loadOne('complete')).outcome).toBe('created');
    // Deleted on the host: the share still lists the folder, empty, for a second.
    await rm(join(suitesDir, 'complete'), { recursive: true });
    await cp(join(FIXTURES, 'no-suite-yaml'), join(suitesDir, 'complete'), { recursive: true });
    waits.meanwhile = () => rm(join(suitesDir, 'complete'), { recursive: true });
    const entry = await loadOne('complete');
    expect(waits.ms).toEqual([SUITE_YAML_RETRY_MS]);
    expect(SUITE_YAML_RETRY_MS).toBe(2000);
    expect(entry).toMatchObject({ sourcePath: './suites/complete', outcome: 'missing' });
  });

  it('is an error when the second read still finds no suite.yaml, after one wait', async () => {
    const entry = await loadOne('no-suite-yaml');
    expect(waits.ms).toEqual([SUITE_YAML_RETRY_MS]);
    expect(entry).toMatchObject({
      outcome: 'error',
      message: 'Could not reload: suite.yaml not found',
    });
  });

  it('loads what the second read finds, and a folder with its suite.yaml waits for nothing', async () => {
    waits.meanwhile = () =>
      cp(join(FIXTURES, 'complete'), join(suitesDir, 'no-suite-yaml'), { recursive: true });
    expect((await loadOne('no-suite-yaml')).outcome).toBe('created');
    waits.ms = [];
    expect((await loadOne('mixed')).outcome).toBe('created');
    expect(waits.ms).toEqual([]);
  });
});
