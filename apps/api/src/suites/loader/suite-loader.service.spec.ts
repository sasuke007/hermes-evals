/**
 * The Nest wiring of the loader and its job handler: the provider resolves
 * with the DB token overridden by PGlite, the start-up load never throws,
 * and the handler turns a load-suites job into the job's output.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import type { PgBoss } from 'pg-boss';
import { SuiteReloadResultSchema, type SuiteReloadResult } from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import { MAX_LOAD_SELF_CHECK_SECONDS, QUEUES } from '../../queue/queues.js';
import { BlobStore } from '../../storage/blob-store.js';
import { StorageService } from '../../storage/storage.service.js';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { handleLoadSuitesJob, registerSuiteLoadHandler } from './load-suites.handler.js';
import type { LoaderLogger } from './suite-loader.js';
import { SuiteLoaderService } from './suite-loader.service.js';

const FIXTURES = join(import.meta.dirname, '../../../test/fixtures/suites');

// Each test runs several loads with python verifiers; give them room when every spec runs at once.
vi.setConfig({ testTimeout: 60_000 });

const pino = () => ({ setContext: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('SuiteLoaderService', () => {
  let t: TestDatabase;
  let root: string;

  beforeEach(async () => {
    t = await createTestDatabase();
    root = await mkdtemp(join(tmpdir(), 'hermes-evals-loader-svc-'));
    await cp(join(FIXTURES, 'mixed'), join(root, 'suites/mixed'), { recursive: true });
  }, 30_000);

  afterEach(async () => {
    await t.close();
    await rm(root, { recursive: true, force: true });
  });

  async function service(suitesDir: string, logger = pino()) {
    const module = await Test.createTestingModule({
      providers: [
        SuiteLoaderService,
        { provide: DB, useValue: t.db },
        { provide: StorageService, useValue: new BlobStore(join(root, 'data')) },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (key === 'SUITES_DIR' ? suitesDir : undefined) },
        },
        { provide: PinoLogger, useValue: logger },
      ],
    }).compile();
    return module.get(SuiteLoaderService);
  }

  it('loads SUITES_DIR at start', async () => {
    const loader = await service(join(root, 'suites'));
    const result = SuiteReloadResultSchema.parse(await loader.loadAtStartup());
    expect(result.suites.map((s) => [s.sourcePath, s.outcome])).toEqual([
      ['./suites/mixed', 'created'],
    ]);
  });

  it('logs and returns null at start when SUITES_DIR is not there', async () => {
    const logger = pino();
    const loader = await service(join(root, 'nowhere'), logger);
    expect(await loader.loadAtStartup()).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'suites could not be loaded at start',
    );
  });

  it('refuses a path that is not one directory name', async () => {
    const loader = await service(join(root, 'suites'));
    await expect(loader.loadOne('../etc')).rejects.toThrow(/not a suite directory name/);
    await expect(loader.loadOne('.hidden')).rejects.toThrow(/not a suite directory name/);
  });

  it('reports a directory it never saw and that is not on disk as missing, without a row', async () => {
    const loader = await service(join(root, 'suites'));
    const result = SuiteReloadResultSchema.parse(await loader.loadOne('ghost'));
    expect(result.suites).toEqual([
      expect.objectContaining({
        sourcePath: './suites/ghost',
        name: 'ghost',
        outcome: 'missing',
        message: 'Missing from disk',
      }),
    ]);
  });
});

describe('the load-suites handler', () => {
  const result: SuiteReloadResult = { at: '2026-10-24T10:00:00.000Z', suites: [] };
  const loader = { loadAll: vi.fn(async () => result), loadOne: vi.fn(async () => result) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoaderLogger;

  beforeEach(() => vi.clearAllMocks());

  it('loads every directory for path null, else the one named', async () => {
    expect(await handleLoadSuitesJob({ path: null }, loader, logger)).toBe(result);
    // Every directory shares the one budget of declared self-check time a job has.
    expect(loader.loadAll).toHaveBeenCalledWith({
      selfCheckBudgetS: MAX_LOAD_SELF_CHECK_SECONDS,
    });
    await handleLoadSuitesJob({ path: 'invoices-v1' }, loader, logger);
    expect(loader.loadOne).toHaveBeenCalledWith('invoices-v1');
  });

  it('fails the job on data it does not understand', async () => {
    await expect(handleLoadSuitesJob({ path: 3 }, loader, logger)).rejects.toThrow();
    await expect(handleLoadSuitesJob({}, loader, logger)).rejects.toThrow();
  });

  it('registers one job at a time on the load-suites queue and returns the result as output', async () => {
    let handler: ((jobs: { data: unknown }[]) => Promise<unknown>) | undefined;
    const boss = {
      work: vi.fn(async (_queue: string, _options: unknown, fn: typeof handler) => {
        handler = fn;
        return 'worker-1';
      }),
    };
    expect(await registerSuiteLoadHandler(boss as unknown as PgBoss, loader, logger)).toBe(
      'worker-1',
    );
    expect(boss.work).toHaveBeenCalledWith(
      QUEUES.loadSuites,
      { batchSize: 1, localConcurrency: 1 },
      expect.any(Function),
    );
    expect(await handler!([{ data: { path: null } }])).toBe(result);
    expect(await handler!([])).toBeNull();
  });
});
