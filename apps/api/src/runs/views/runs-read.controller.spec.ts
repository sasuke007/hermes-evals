/**
 * The run read routes over HTTP: a Nest testing module with RunViewsModule
 * on PGlite, driven with supertest. Bodies parse with their shared schemas,
 * queries are validated by them, errors keep the { statusCode, message }
 * shape, and artifacts leave as downloads a browser saves, never renders.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AttemptStderrSchema,
  RunDetailSchema,
  RunEventsPageSchema,
  RunListResultSchema,
  TablePreviewSchema,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { DB } from '../../database/db.provider.js';
import { StorageService } from '../../storage/storage.service.js';
import { RunViewsModule } from './run-views.module.js';
import { PROVIDER_STDERR_LOG, seedAllStates, type AllStates } from './run-states-spec.js';
import { REPORT_HTML, SUMMARY_CSV, viewsConfig } from './run-fixtures-spec.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let seed: AllStates;
let app: INestApplication;

beforeAll(async () => {
  t = await createTestDatabase();
  seed = await seedAllStates(t.db);

  /** What AppModule's DatabaseModule, StorageModule and ConfigModule provide. */
  @Global()
  @Module({
    providers: [
      { provide: DB, useValue: t.db },
      { provide: StorageService, useValue: seed.store },
      { provide: ConfigService, useValue: viewsConfig() },
    ],
    exports: [DB, StorageService, ConfigService],
  })
  class InfraModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [InfraModule, RunViewsModule],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
});

afterAll(async () => {
  await app.close();
  await t.close();
  await seed.dispose();
});

const http = () => request(app.getHttpServer());

/** Reads a download's body as text, whatever its content type. */
const asText = (req: request.Test) =>
  req.buffer(true).parse((res, done) => {
    let body = '';
    res.on('data', (chunk: Buffer) => (body += chunk.toString()));
    res.on('end', () => done(null, body));
  });

describe('GET /api/experiments/:id/runs', () => {
  it('answers the filtered, sorted rows with the shared query names', async () => {
    const res = await http()
      .get(`/api/experiments/${seed.experimentId}/runs`)
      .query({ config: 'with-skill', exec_error: '1', sort: 'duration', dir: 'asc' })
      .expect(200);
    const result = RunListResultSchema.parse(res.body);
    expect(result.rows.map((r) => r.executionErrorCategory)).toEqual([
      'setup',
      'other',
      'worker_lost',
    ]);
    expect(result.summary.total).toBe(20);
  });

  it('refuses a query the schema does not accept, naming the field', async () => {
    const res = await http()
      .get(`/api/experiments/${seed.experimentId}/runs`)
      .query({ status: 'bogus', sort: 'nope' })
      .expect(400);
    expect(res.body).toMatchObject({ statusCode: 400, message: 'Validation failed' });
    expect((res.body as { issues: { path: string }[] }).issues.map((i) => i.path).sort()).toEqual([
      'sort',
      'status',
    ]);
  });

  it('answers 404 for an unknown experiment', async () => {
    const res = await http().get('/api/experiments/exp_nope/runs').expect(404);
    expect(res.body).toEqual({ statusCode: 404, message: 'experiment exp_nope not found' });
  });
});

describe('GET /api/runs/:id and /events', () => {
  it('answers the inspector detail', async () => {
    const res = await http()
      .get(`/api/runs/${seed.cell('dup_invoices/baseline/1')}`)
      .expect(200);
    expect(RunDetailSchema.parse(res.body).scores).toHaveLength(3);
  });

  it('pages events after a seq and validates `after`', async () => {
    const run = seed.cell('dup_invoices/baseline/1');
    const res = await http().get(`/api/runs/${run}/events`).query({ after: 7 }).expect(200);
    expect(RunEventsPageSchema.parse(res.body).lastSeq).toBe(11);
    const first = await http().get(`/api/runs/${run}/events`).expect(200);
    expect(RunEventsPageSchema.parse(first.body).events).toHaveLength(8);
    for (const after of ['-1', 'abc', '1.5']) {
      const bad = await http().get(`/api/runs/${run}/events`).query({ after }).expect(400);
      expect(bad.body).toMatchObject({ statusCode: 400, issues: [{ path: 'after' }] });
    }
  });

  it('answers 404 for an unknown run', async () => {
    expect((await http().get('/api/runs/run_nope').expect(404)).body).toEqual({
      statusCode: 404,
      message: 'run run_nope not found',
    });
    await http().get('/api/runs/run_nope/events').expect(404);
  });
});

describe('artifacts', () => {
  const base = () => `/api/runs/${seed.cell('dup_invoices/baseline/1')}/artifacts`;

  it('downloads a CSV as an attachment that is never sniffed or rendered', async () => {
    const res = await asText(http().get(`${base()}/${seed.artifactIds.summary}/content`)).expect(
      200,
    );
    expect(res.body).toBe(SUMMARY_CSV);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="summary.csv"; filename*=UTF-8''summary.csv`,
    );
    expect(res.headers['content-length']).toBe(String(Buffer.byteLength(SUMMARY_CSV)));
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });

  it('sends HTML the agent wrote as plain bytes', async () => {
    const res = await asText(http().get(`${base()}/${seed.artifactIds.report}/content`)).expect(
      200,
    );
    expect(res.body).toBe(REPORT_HTML);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="report.html"/);
  });

  it("answers 404 for another run's artifact and for a file stored without content", async () => {
    const other = await http().get(`${base()}/${seed.artifactIds.partial}/content`).expect(404);
    expect(other.body).toEqual({
      statusCode: 404,
      message: `artifact ${seed.artifactIds.partial} not found`,
    });
    await http().get(`${base()}/${seed.artifactIds.big}/content`).expect(404);
  });

  it('previews a CSV, and answers the JSON null for any other file', async () => {
    const csv = await http().get(`${base()}/${seed.artifactIds.summary}/preview`).expect(200);
    expect(TablePreviewSchema.parse(csv.body).columns).toEqual(['vendor', 'outstanding']);
    const html = await http().get(`${base()}/${seed.artifactIds.report}/preview`).expect(200);
    expect(html.text).toBe('null');
    expect(html.headers['content-type']).toMatch(/^application\/json/);
  });
});

describe('GET /api/runs/:id/attempts/:n/stderr (Phase 7)', () => {
  it('answers the stored stderr.log of the attempt', async () => {
    const res = await http()
      .get(`/api/runs/${seed.cell('dup_invoices/baseline/4')}/attempts/1/stderr`)
      .expect(200);
    expect(AttemptStderrSchema.parse(res.body)).toEqual({
      runId: seed.cell('dup_invoices/baseline/4'),
      attempt: 1,
      text: PROVIDER_STDERR_LOG,
      sizeBytes: Buffer.byteLength(PROVIDER_STDERR_LOG),
      totalLines: 57,
      truncated: false,
    });
  });

  it('answers 404 with the error shape when no log was stored, and 400 for a bad number', async () => {
    const missing = await http()
      .get(`/api/runs/${seed.cell('dup_invoices/baseline/1')}/attempts/1/stderr`)
      .expect(404);
    expect(missing.body).toEqual({ statusCode: 404, message: 'stderr.log of attempt 1 not found' });
    await http().get('/api/runs/01NOSUCHRUN000000000000000/attempts/1/stderr').expect(404);
    for (const n of ['0', 'x', '1.5']) {
      await http()
        .get(`/api/runs/${seed.cell('dup_invoices/baseline/1')}/attempts/${n}/stderr`)
        .expect(400);
    }
  });
});
