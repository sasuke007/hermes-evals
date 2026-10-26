/**
 * The suites routes on Postgres 17 through node-postgres, with the real
 * QueueService (pg-boss) and a stand-in worker that answers load-suites:
 * what PGlite and the fake queue of the controller spec cannot show.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PinoLogger } from 'nestjs-pino';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SuiteDetailSchema,
  SuiteHistoryEntrySchema,
  SuiteListRowSchema,
  SuiteReloadResultSchema,
  TaskDetailSchema,
  TaskVersionEntrySchema,
  type SuiteReloadResult,
} from '@hermes-evals/shared';
import { HERMES_REVISION } from '../../test/support/seed.js';
import { DB } from '../database/db.provider.js';
import { runMigrations } from '../database/migrator.js';
import * as schema from '../database/schema/index.js';
import type { Env } from '../config/env.js';
import { QueueService } from '../queue/queue.service.js';
import { QUEUES, type LoadSuitesJob } from '../queue/queues.js';
import { StorageService } from '../storage/storage.service.js';
import { seedSuiteDirectory, T_V2, type SeededDirectory } from './seed-spec.js';
import { SuitesModule } from './suites.module.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

const logger = {
  setContext: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as PinoLogger;

describe.skipIf(!SERVER_URL)('suites API on Postgres 17', () => {
  const database = `hermes_evals_suites_e2e_${process.pid}`;
  let pool: pg.Pool;
  let db: NodePgDatabase<typeof schema>;
  let seed: SeededDirectory;
  let queue: QueueService;
  let worker: PgBoss;
  let app: INestApplication;
  const handled: LoadSuitesJob[] = [];

  const admin = async (statement: string) => {
    const client = new pg.Client({ connectionString: SERVER_URL });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };

  /**
   * The stand-in worker: answers load-suites after a second, a Reload all's
   * scan (`path: null`) with one directory, a directory with a fixed result.
   */
  const startWorking = () =>
    worker.work<LoadSuitesJob>(
      QUEUES.loadSuites,
      { pollingIntervalSeconds: 0.5 },
      async ([job]) => {
        if (!job) return undefined;
        handled.push(job.data);
        // Long enough for a second request to find this job still active.
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (job.data.path === null) {
          return { at: new Date().toISOString(), missing: [], directories: ['invoices-v1'] };
        }
        return {
          at: new Date().toISOString(),
          suites: [
            {
              sourcePath: './suites/invoices-v1',
              name: 'invoices-v1',
              outcome: 'unchanged',
              suiteId: seed.v2.id,
              versionNumber: 2,
              changes: { added: [], removed: [], changed: [], nowInvalid: [], nowValid: [] },
              message: 'All self-checks passed',
              error: null,
            },
          ],
        } satisfies SuiteReloadResult;
      },
    );

  beforeAll(async () => {
    await admin(`drop database if exists ${database}`);
    await admin(`create database ${database}`);
    const parsed = new URL(SERVER_URL!);
    parsed.pathname = `/${database}`;
    const url = parsed.toString();
    await runMigrations(url);
    pool = new pg.Pool({ connectionString: url, max: 5 });
    db = drizzle(pool, { schema });
    seed = await seedSuiteDirectory(db);

    const env: Partial<Env> = { DATABASE_URL: url, SUITE_RELOAD_TIMEOUT_S: 30 };
    const config = { get: (name: keyof Env) => env[name] } as unknown as ConfigService<Env, true>;
    queue = new QueueService(config, logger);
    await queue.onModuleInit();

    // The worker side: a separate pg-boss client, as the worker process has.
    worker = new PgBoss({
      connectionString: url,
      schema: 'pgboss',
      supervise: false,
      schedule: false,
    });
    worker.on('error', () => {});
    await worker.start();
    await startWorking();
    await db.insert(schema.workers).values({
      hostname: 'worker-1',
      concurrency: 3,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
    });

    @Global()
    @Module({
      providers: [
        { provide: DB, useValue: db },
        { provide: QueueService, useValue: queue },
        { provide: ConfigService, useValue: config },
        { provide: PinoLogger, useValue: logger },
      ],
      exports: [DB, QueueService, ConfigService, PinoLogger],
    })
    class InfraModule {}

    const moduleRef = await Test.createTestingModule({ imports: [InfraModule, SuitesModule] })
      .overrideProvider(StorageService)
      .useValue(seed.store)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await worker?.stop({ graceful: false, timeout: 1000 });
    await queue?.onModuleDestroy();
    await pool?.end();
    await seed?.dispose();
    await admin(`drop database if exists ${database} with (force)`);
  }, 30_000);

  const http = () => request(app.getHttpServer());

  it('serves the list, detail and history with node-postgres types', async () => {
    const list = SuiteListRowSchema.array().parse(
      (await http().get('/api/suites').expect(200)).body,
    );
    expect(list.map((r) => [r.suiteId, r.loadedAt])).toEqual([[seed.v2.id, T_V2.toISOString()]]);
    const detail = SuiteDetailSchema.parse(
      (await http().get(`/api/suites/${seed.v2.id}`).expect(200)).body,
    );
    expect(detail.tasks.map((t) => [t.key, t.version, t.valid])).toEqual([
      ['total_due', 1, true],
      ['late_fees', 2, false],
    ]);
    const history = SuiteHistoryEntrySchema.array().parse(
      (await http().get(`/api/suites/${seed.v2.id}/history`).expect(200)).body,
    );
    expect(history.map((e) => e.versionNumber)).toEqual([2, 1]);
  });

  it('serves task detail and history, sizes as numbers', async () => {
    const task = TaskDetailSchema.parse(
      (await http().get(`/api/suites/${seed.v2.id}/tasks/total_due`).expect(200)).body,
    );
    expect(task.fixtures.every((f) => typeof f.sizeBytes === 'number')).toBe(true);
    expect(task.experiments).toEqual([]);
    const versions = TaskVersionEntrySchema.array().parse(
      (await http().get(`/api/suites/${seed.v2.id}/tasks/late_fees/history`).expect(200)).body,
    );
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it('reloads through the worker; two requests while it is queued share one pass', async () => {
    // Paused, so the job is still created (nothing read yet) when the second request looks.
    await worker.offWork(QUEUES.loadSuites);
    const a = http()
      .post('/api/suites/reload')
      .expect(200)
      .then((res) => res);
    const b = http()
      .post('/api/suites/reload')
      .send({})
      .expect(200)
      .then((res) => res);
    const created = async () =>
      (await worker.findJobs(QUEUES.loadSuites, { key: '*' })).some((j) => j.state === 'created');
    while (!(await created())) await new Promise((resolve) => setTimeout(resolve, 50));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await startWorking();
    const [ra, rb] = await Promise.all([a, b]);
    expect(SuiteReloadResultSchema.parse(ra.body)).toEqual(SuiteReloadResultSchema.parse(rb.body));
    expect(ra.body.suites[0].suiteId).toBe(seed.v2.id);
    // One pass: the scan, then one job for the directory (Phase 4 question 9).
    expect(handled).toEqual([{ path: null }, { path: 'invoices-v1' }]);
  }, 30_000);

  it('does not join a reload that is already running: a request then gets a pass of its own', async () => {
    handled.length = 0;
    // `then` sends the request now; supertest waits for it otherwise.
    const first = http()
      .post('/api/suites/reload')
      .send({})
      .expect(200)
      .then((res) => res);
    const active = async () =>
      (await worker.findJobs(QUEUES.loadSuites, { key: '*' })).some((j) => j.state === 'active');
    while (!(await active())) await new Promise((resolve) => setTimeout(resolve, 50));
    // The running pass may have read the files before this request's edit.
    const second = http()
      .post('/api/suites/reload')
      .send({})
      .expect(200)
      .then((res) => res);
    await Promise.all([first, second]);
    expect(handled).toEqual([
      { path: null },
      { path: 'invoices-v1' },
      { path: null },
      { path: 'invoices-v1' },
    ]);
  }, 30_000);
});
