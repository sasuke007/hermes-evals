/**
 * The System endpoints over HTTP, as AppModule mounts them under /api: a Nest
 * application with SystemModule and DatabaseModule, the DB token swapped for
 * PGlite. Every body is checked against the shared contract.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  HERMES_REVISION,
  SandboxStatusSchema,
  SystemSummarySchema,
  WorkerSchema,
} from '@hermes-evals/shared';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { seedExperiment } from '../../test/support/seed.js';
import { DatabaseModule } from '../database/database.module.js';
import { DB } from '../database/db.provider.js';
import { workers } from '../database/schema/index.js';
import { SystemModule } from './system.module.js';

/** What AppModule's ConfigModule and LoggerModule provide; DATABASE_URL unset. */
@Global()
@Module({
  providers: [
    { provide: ConfigService, useValue: { get: () => undefined } },
    { provide: PinoLogger, useValue: { setContext: () => {}, info: () => {}, warn: () => {} } },
  ],
  exports: [ConfigService, PinoLogger],
})
class InfraModule {}

// PGlite databases are slow to create when every test file runs at once.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

async function start(db?: TestDatabase['db']): Promise<INestApplication> {
  let builder = Test.createTestingModule({ imports: [InfraModule, DatabaseModule, SystemModule] });
  if (db) builder = builder.overrideProvider(DB).useValue(db);
  const app = (await builder.compile()).createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  return app;
}

describe('System endpoints', () => {
  let t: TestDatabase;
  let app: INestApplication;

  beforeEach(async () => {
    t = await createTestDatabase();
    app = await start(t.db);
  });

  afterEach(async () => {
    await app.close();
    await t.close();
  });

  it('GET /api/system/summary returns the summary contract', async () => {
    const s = await seedExperiment(t.db);
    const res = await request(app.getHttpServer()).get('/api/system/summary').expect(200);
    const summary = SystemSummarySchema.parse(res.body);
    expect(summary.running).toMatchObject({ count: 1, scored: 0, total: 4 });
    expect(summary.queuedRuns).toBe(4);
    expect(summary.workers).toEqual([
      // Concurrency 3, four slot networks: the total is the slot count.
      expect.objectContaining({
        id: s.worker.id,
        status: 'online',
        concurrency: 3,
        slotsInUse: 0,
        slotsTotal: 4,
      }),
    ]);
  });

  it('GET /api/system/workers returns Worker[]', async () => {
    await seedExperiment(t.db);
    const res = await request(app.getHttpServer()).get('/api/system/workers').expect(200);
    expect(WorkerSchema.array().parse(res.body)).toHaveLength(1);
  });

  it('GET /api/system/sandbox is 404 with the error body until a live worker reports', async () => {
    const res = await request(app.getHttpServer()).get('/api/system/sandbox').expect(404);
    expect(res.body).toEqual({
      statusCode: 404,
      message: expect.stringMatching(/^No worker is connected/),
    });
  });

  it('GET /api/system/sandbox returns the live worker report', async () => {
    await t.db.insert(workers).values({
      hostname: 'worker-1',
      concurrency: 3,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      sandbox: {
        state: 'failed',
        checks: [
          {
            id: 'gateway-only',
            name: 'reaches nothing but egress',
            passed: false,
            detail: 'open: 192.168.5.2:22',
          },
        ],
        checked_at: new Date().toISOString(),
        image: 'hermes-evals/trial:v0.22.4-4d04303',
        revision: HERMES_REVISION,
        trigger: 'worker start',
      },
    });
    const res = await request(app.getHttpServer()).get('/api/system/sandbox').expect(200);
    const status = SandboxStatusSchema.parse(res.body);
    expect(status).toMatchObject({ proven: false, digest: 'unknown' });
    expect(status.checks).toEqual([expect.objectContaining({ id: 'gateway-only', passed: false })]);
  });
});

describe('System endpoints without a database', () => {
  it('answer 503 with the error body', async () => {
    const app = await start();
    for (const path of ['summary', 'workers', 'sandbox']) {
      const res = await request(app.getHttpServer()).get(`/api/system/${path}`).expect(503);
      expect(res.body).toEqual({
        statusCode: 503,
        message: 'database is not configured: DATABASE_URL is not set',
      });
    }
    await app.close();
  });
});
