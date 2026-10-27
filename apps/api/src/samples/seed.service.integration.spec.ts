/**
 * SampleSeedService (Phase 8 G3) on PGlite: SEED_SAMPLES off leaves the
 * report `off`; on, the seed runs in the background after bootstrap (which
 * returns at once, even while the seed hangs), reports `running` then `done`; it never rejects, and whatever stops it
 * (no database, no samples folder) becomes a `failed` report with the
 * reason. Every report parses with SeedReportSchema, whose refinements tie
 * the state to its times and error.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeedReportSchema, seedCounts, type SeedReport } from '@hermes-evals/shared';
import { PinoLogger } from 'nestjs-pino';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import type { Env } from '../config/env.js';
import { ConfigurationWritesService } from '../configurations/configuration-writes.service.js';
import type { MigrationService, MigrationState } from '../database/migration.service.js';
import { DocumentsService } from '../resources/documents/documents.service.js';
import { McpServersService } from '../resources/mcp/mcp-servers.service.js';
import { SkillUploadStore } from '../resources/skills/skill-uploads.js';
import { SkillsService } from '../resources/skills/skills.service.js';
import { configOf, silentLogger, testEnv } from '../resources/skills/testing.helper-spec.js';
import { StorageService } from '../storage/storage.service.js';
import { SeedReporter } from './seed-report.js';
import { SampleSeedService } from './seed.service.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

const SAMPLES = fileURLToPath(new URL('../../../../samples', import.meta.url));

let t: TestDatabase;
let dataDir: string;
let reporter: SeedReporter;
let logged: { level: string; msg: string }[];

beforeEach(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'samples-seed-service-'));
  reporter = new SeedReporter();
  logged = [];
});

afterEach(async () => {
  await t.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** A PinoLogger that keeps the level and message of each line. */
const recordingLogger = (): PinoLogger => {
  const keep = (level: string) => (_obj: unknown, msg?: string) =>
    logged.push({ level, msg: typeof _obj === 'string' ? _obj : (msg ?? '') });
  const quiet = () => {};
  return {
    setContext: quiet,
    trace: quiet,
    debug: quiet,
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
    fatal: quiet,
  } as unknown as PinoLogger;
};

function service(
  env: Partial<Env>,
  migrations: MigrationState = 'ok',
  hangUploads = false,
): SampleSeedService {
  const config = configOf({ ...testEnv(dataDir), ...env });
  const storage = new StorageService(config, silentLogger);
  const documents = new DocumentsService(t.db, storage, silentLogger);
  // A document upload that never ends, as a seed stuck on a database lock would be.
  if (hangUploads) vi.spyOn(documents, 'upload').mockReturnValue(new Promise(() => {}));
  return new SampleSeedService(
    config,
    reporter,
    { status: () => migrations } as unknown as MigrationService,
    t.db,
    storage,
    new SkillsService(
      t.db,
      storage,
      new SkillUploadStore(storage, config, silentLogger),
      silentLogger,
    ),
    documents,
    new McpServersService(t.db),
    new ConfigurationWritesService(t.db),
    recordingLogger(),
  );
}

const report = (): SeedReport => SeedReportSchema.parse(reporter.report());

describe('SampleSeedService', () => {
  it('is off with SEED_SAMPLES false: nothing runs, the report says off', async () => {
    const seed = service({ SEED_SAMPLES: false, SAMPLES_DIR: SAMPLES });
    seed.onApplicationBootstrap();
    await seed.settled();
    expect(report()).toEqual({
      state: 'off',
      startedAt: null,
      finishedAt: null,
      items: [],
      error: null,
    });
    expect(logged).toEqual([{ level: 'info', msg: 'samples seed off (SEED_SAMPLES=false)' }]);
  });

  it('runs after bootstrap without holding it up, running then done, and logs the counts', async () => {
    const seed = service({ SEED_SAMPLES: true, SAMPLES_DIR: SAMPLES });
    // Bootstrap returns nothing for Nest to await (a promise would hold app.listen up), while
    // the seed works.
    expect(seed.onApplicationBootstrap()).toBeUndefined();
    expect(report().state).toBe('running');
    await seed.settled();
    const done = report();
    expect(done.state).toBe('done');
    expect(done.error).toBeNull();
    expect(seedCounts(done)).toEqual({ created: 40, skipped: 0, failed: 0 });
    expect(Date.parse(done.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(done.startedAt!));
    expect(logged.at(-1)).toEqual({ level: 'info', msg: 'samples seed done' });
    expect(logged.filter((l) => l.msg === 'sample created')).toHaveLength(40);

    // The next start finds everything.
    const again = service({ SEED_SAMPLES: true, SAMPLES_DIR: SAMPLES });
    again.onApplicationBootstrap();
    await again.settled();
    expect(seedCounts(report())).toEqual({ created: 0, skipped: 40, failed: 0 });
  });

  it('returns from bootstrap while the seed hangs, and the report stays running', async () => {
    const seed = service({ SEED_SAMPLES: true, SAMPLES_DIR: SAMPLES }, 'ok', true);
    expect(seed.onApplicationBootstrap()).toBeUndefined();
    // The skills go in, then the first document's upload never ends.
    await vi.waitFor(() =>
      expect(report().items.filter((i) => i.kind === 'skill')).toHaveLength(4),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(report()).toMatchObject({ state: 'running', finishedAt: null, error: null });
    expect(report().items.some((i) => i.kind === 'document')).toBe(false);
  });

  it('fails, without rejecting, when the database was not migrated or the folder is missing', async () => {
    const noDb = service({ SEED_SAMPLES: true, SAMPLES_DIR: SAMPLES }, 'unavailable');
    noDb.onApplicationBootstrap();
    await expect(noDb.settled()).resolves.toBeUndefined();
    expect(report()).toMatchObject({
      state: 'failed',
      items: [],
      error: 'the database was not reachable at start; restart the api to seed the samples',
    });

    const noFolder = service({ SEED_SAMPLES: true, SAMPLES_DIR: join(dataDir, 'nowhere') });
    noFolder.onApplicationBootstrap();
    await expect(noFolder.settled()).resolves.toBeUndefined();
    expect(report()).toMatchObject({
      state: 'failed',
      items: [],
      error: `no samples folder at ${join(dataDir, 'nowhere')} (SAMPLES_DIR)`,
    });
    expect(logged.filter((l) => l.level === 'error').map((l) => l.msg)).toEqual([
      'samples seed failed',
      'samples seed failed',
    ]);
  });
});

describe('SeedReporter', () => {
  it('keeps a report the shared schema accepts in every state', () => {
    const r = new SeedReporter();
    expect(SeedReportSchema.parse(r.report()).state).toBe('off');
    r.start(new Date('2026-10-27T10:00:00Z'));
    r.add({ kind: 'skill', name: 'invoice-method', outcome: 'created', detail: 'version 1.0.0' });
    expect(SeedReportSchema.parse(r.report())).toMatchObject({
      state: 'running',
      startedAt: '2026-10-27T10:00:00.000Z',
      finishedAt: null,
    });
    r.finish(new Date('2026-10-27T10:00:05Z'));
    expect(SeedReportSchema.parse(r.report())).toMatchObject({
      state: 'done',
      finishedAt: '2026-10-27T10:00:05.000Z',
      error: null,
    });
    // A new start forgets the last one; a failure keeps the items met so far.
    r.start(new Date('2026-10-27T11:00:00Z'));
    r.add({ kind: 'document', name: 'mcp-v1/invoices.csv', outcome: 'skipped', detail: 'exists' });
    r.fail('the database refused', new Date('2026-10-27T11:00:01Z'));
    expect(SeedReportSchema.parse(r.report())).toEqual({
      state: 'failed',
      startedAt: '2026-10-27T11:00:00.000Z',
      finishedAt: '2026-10-27T11:00:01.000Z',
      items: [
        { kind: 'document', name: 'mcp-v1/invoices.csv', outcome: 'skipped', detail: 'exists' },
      ],
      error: 'the database refused',
    });
  });
});
