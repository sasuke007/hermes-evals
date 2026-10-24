/**
 * The suites routes over HTTP: a Nest testing module with SuitesModule on
 * PGlite, driven with supertest. The blob store is a temp directory and the
 * queue a stand-in that answers the load-suites job the way pg-boss reports
 * it (send, then findJobs by id). Every success body is parsed with its
 * shared schema; errors keep the { statusCode, message } shape.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import type { PgBoss } from 'pg-boss';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  SuiteDetailSchema,
  SuiteHistoryEntrySchema,
  SuiteListRowSchema,
  SuiteReloadResultSchema,
  TablePreviewSchema,
  TaskDetailSchema,
  TaskDiffSchema,
  TaskVersionEntrySchema,
  type SuiteReloadResult,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { HERMES_REVISION } from '../../test/support/seed.js';
import { DB } from '../database/db.provider.js';
import { workers } from '../database/schema/index.js';
import { QueueService } from '../queue/queue.service.js';
import { StorageService } from '../storage/storage.service.js';
import { NO_WORKER_MESSAGE } from './suite-reload.service.js';
import { SuitesModule } from './suites.module.js';
import { INVOICES_CSV, README_MD, seedSuiteDirectory, type SeededDirectory } from './seed-spec.js';

/** One job as findJobs reports it. */
interface FakeJob {
  id: string;
  state: string;
  output: unknown;
}

/** The two pg-boss calls sendAndWait makes, answering with whatever `settle` returns. */
class FakeBoss {
  sent: { queue: string; data: object; singletonKey: string | undefined }[] = [];
  settle: () => Omit<FakeJob, 'id'> = () => ({ state: 'completed', output: RESULT });

  async send(queue: string, data: object, options?: { singletonKey?: string }): Promise<string> {
    this.sent.push({ queue, data, singletonKey: options?.singletonKey });
    return `job_${this.sent.length}`;
  }

  async findJobs(_queue: string, options: { id?: string }): Promise<FakeJob[]> {
    return options.id ? [{ id: options.id, ...this.settle() }] : [];
  }
}

const RESULT: SuiteReloadResult = {
  at: '2026-10-23T15:41:07.000Z',
  suites: [
    {
      sourcePath: './suites/invoices-v1',
      name: 'invoices-v1',
      outcome: 'unchanged',
      suiteId: 'suite_x',
      versionNumber: 2,
      changes: { added: [], removed: [], changed: [], nowInvalid: [], nowValid: [] },
      message: 'All self-checks passed',
      error: null,
    },
  ],
};

let t: TestDatabase;
let seed: SeededDirectory;
let app: INestApplication;
const boss = new FakeBoss();

beforeAll(async () => {
  t = await createTestDatabase();
  seed = await seedSuiteDirectory(t.db);
  const env: Record<string, unknown> = { SUITE_RELOAD_TIMEOUT_S: 1, DATA_DIR: seed.store.dataDir };

  /** What AppModule's DatabaseModule, QueueModule, ConfigModule and LoggerModule provide. */
  @Global()
  @Module({
    providers: [
      { provide: DB, useValue: t.db },
      { provide: QueueService, useValue: { instance: boss as unknown as PgBoss } },
      { provide: ConfigService, useValue: { get: (name: string) => env[name] } },
      {
        provide: PinoLogger,
        useValue: { setContext: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      },
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
}, 30_000);

afterAll(async () => {
  await app.close();
  await t.close();
  await seed.dispose();
});

const http = () => request(app.getHttpServer());

describe('suite reads', () => {
  it('GET /api/suites lists the directory at its current version', async () => {
    const res = await http().get('/api/suites').expect(200);
    const rows = SuiteListRowSchema.array().parse(res.body);
    expect(rows.map((r) => [r.suiteId, r.versionNumber])).toEqual([[seed.v2.id, 2]]);
  });

  it('GET /api/suites/:id shows any version', async () => {
    const res = await http().get(`/api/suites/${seed.v1.id}`).expect(200);
    expect(SuiteDetailSchema.parse(res.body)).toMatchObject({
      suiteId: seed.v1.id,
      current: false,
    });
  });

  it('GET /api/suites/:id/history lists every version', async () => {
    const res = await http().get(`/api/suites/${seed.v2.id}/history`).expect(200);
    expect(
      SuiteHistoryEntrySchema.array()
        .parse(res.body)
        .map((e) => e.versionNumber),
    ).toEqual([2, 1]);
  });

  it('answers 404 in the web’s words', async () => {
    const suite = await http().get('/api/suites/suite_nope').expect(404);
    expect(suite.body).toEqual({ statusCode: 404, message: 'suite suite_nope not found' });
    const task = await http().get(`/api/suites/${seed.v2.id}/tasks/nope`).expect(404);
    expect(task.body).toEqual({ statusCode: 404, message: 'task nope not found' });
  });
});

describe('task reads', () => {
  it('GET /api/suites/:id/tasks/:key shows the task', async () => {
    const res = await http().get(`/api/suites/${seed.v2.id}/tasks/late_fees`).expect(200);
    expect(TaskDetailSchema.parse(res.body)).toMatchObject({
      key: 'late_fees',
      version: 2,
      valid: false,
    });
  });

  it('GET …/history lists the task versions', async () => {
    const res = await http().get(`/api/suites/${seed.v2.id}/tasks/late_fees/history`).expect(200);
    expect(
      TaskVersionEntrySchema.array()
        .parse(res.body)
        .map((e) => e.version),
    ).toEqual([2, 1]);
  });

  it('GET …/diff?against= diffs two versions, and needs `against`', async () => {
    const res = await http()
      .get(`/api/suites/${seed.v2.id}/tasks/late_fees/diff`)
      .query({ against: seed.v1.id })
      .expect(200);
    expect(TaskDiffSchema.parse(res.body).from.suiteId).toBe(seed.v1.id);
    const missing = await http().get(`/api/suites/${seed.v2.id}/tasks/late_fees/diff`).expect(400);
    expect(missing.body).toEqual({
      statusCode: 400,
      message: 'against is required: the id of the suite version to compare with',
    });
  });
});

describe('fixtures', () => {
  const base = () => `/api/suites/${seed.v2.id}/tasks/total_due/fixtures`;

  it('downloads a fixture as an attachment, its path one encoded segment', async () => {
    const res = await http()
      .get(`${base()}/${encodeURIComponent('docs/readme.md')}`)
      .buffer(true)
      .parse((r, done) => {
        let body = '';
        r.on('data', (chunk: Buffer) => (body += chunk.toString()));
        r.on('end', () => done(null, body));
      })
      .expect(200);
    expect(res.body).toBe(README_MD);
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="readme.md"; filename*=UTF-8''readme.md`,
    );
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(README_MD)));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves CSV as text/csv', async () => {
    const res = await http().get(`${base()}/invoices.csv`).expect(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.text).toBe(INVOICES_CSV);
  });

  it('answers 404 for a path that is not one of the task’s fixtures', async () => {
    const res = await http()
      .get(`${base()}/${encodeURIComponent('../late_fees/fixtures/policy_terms.json')}`)
      .expect(404);
    expect(res.body).toEqual({
      statusCode: 404,
      message: 'fixture ../late_fees/fixtures/policy_terms.json not found',
    });
  });

  it('previews a tabular fixture, and answers null for one that is not', async () => {
    const csv = await http().get(`${base()}/invoices.csv/preview`).expect(200);
    expect(TablePreviewSchema.parse(csv.body).totalRows).toBe(12);
    const md = await http()
      .get(`${base()}/${encodeURIComponent('docs/readme.md')}/preview`)
      .expect(200);
    expect(md.headers['content-type']).toMatch(/^application\/json/);
    expect(md.text).toBe('null');
    const gone = await http().get(`${base()}/nope.csv/preview`).expect(404);
    expect(gone.body).toEqual({ statusCode: 404, message: 'fixture nope.csv not found' });
  });
});

describe('POST /api/suites/reload', () => {
  beforeEach(() => {
    boss.sent = [];
    boss.settle = () => ({ state: 'completed', output: RESULT });
  });

  it('answers 503 at once when no worker is connected', async () => {
    const res = await http().post('/api/suites/reload').expect(503);
    expect(res.body).toEqual({ statusCode: 503, message: NO_WORKER_MESSAGE });
    expect(boss.sent).toEqual([]);
  });

  describe('with a worker', () => {
    beforeAll(async () => {
      await t.db.insert(workers).values({
        hostname: 'worker-1',
        concurrency: 3,
        hermesVersion: '0.22.4',
        hermesRevision: HERMES_REVISION,
      });
    });

    it('sends one load-suites job for every directory and returns its output', async () => {
      const res = await http().post('/api/suites/reload').expect(200);
      expect(SuiteReloadResultSchema.parse(res.body)).toEqual(RESULT);
      expect(boss.sent).toEqual([
        { queue: 'load-suites', data: { path: null }, singletonKey: '*' },
      ]);
    });

    it('reloads one directory named as the list shows it', async () => {
      await http().post('/api/suites/reload').send({ path: './suites/invoices-v1' }).expect(200);
      expect(boss.sent).toEqual([
        { queue: 'load-suites', data: { path: 'invoices-v1' }, singletonKey: 'invoices-v1' },
      ]);
    });

    it('refuses a path that is not one directory name, and unknown keys', async () => {
      const outside = await http().post('/api/suites/reload').send({ path: '../etc' }).expect(400);
      expect(outside.body.message).toMatch(/^path must name one suite directory/);
      await http().post('/api/suites/reload').send({ path: 'a', force: true }).expect(400);
      expect(boss.sent).toEqual([]);
    });

    it('answers 500 with the error of a failed job, without its stack', async () => {
      boss.settle = () => ({
        state: 'failed',
        output: { name: 'Error', message: 'SUITES_DIR is not readable', stack: 'Error: at x' },
      });
      const res = await http().post('/api/suites/reload').expect(500);
      expect(res.body).toEqual({
        statusCode: 500,
        message: 'Suite reload failed in the worker: SUITES_DIR is not readable',
      });
    });

    it('answers 500 when the worker returns something that is not a SuiteReloadResult', async () => {
      boss.settle = () => ({ state: 'completed', output: { value: 42 } });
      const res = await http().post('/api/suites/reload').expect(500);
      expect(res.body.message).toMatch(/unexpected shape/);
    });

    it('answers 504 when the load outlasts SUITE_RELOAD_TIMEOUT_S', async () => {
      boss.settle = () => ({ state: 'active', output: null });
      const res = await http().post('/api/suites/reload').expect(504);
      expect(res.body).toEqual({
        statusCode: 504,
        message:
          'The reload did not finish within 1 s. Suites may still be loading in the worker: refresh the list in a moment, or reload again.',
      });
    });
  });
});
