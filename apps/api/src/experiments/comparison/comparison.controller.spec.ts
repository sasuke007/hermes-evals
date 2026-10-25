/**
 * GET /api/experiments/:id/comparison over HTTP, as AppModule mounts it: a
 * Nest application with ComparisonModule beside ExperimentViewsModule and
 * DatabaseModule, the DB token on PGlite. Every 200 parses with
 * ComparisonViewSchema and every refusal with ApiErrorBodySchema; the
 * route sits beside the Phase 2 reads without shadowing them, and the views
 * share the comparison's cache.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  ApiErrorBodySchema,
  ComparisonViewSchema,
  ExperimentDetailSchema,
} from '@hermes-evals/shared';
import type { Server } from 'node:http';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { DatabaseModule } from '../../database/database.module.js';
import { DB } from '../../database/db.provider.js';
import { buildApiDocument } from '../../openapi/document.js';
import { ExperimentViewsModule } from '../experiment-views.module.js';
import { reconcileExperiment } from '../reconcile.js';
import { ExperimentViewsService } from '../views/experiment-views.service.js';
import { ComparisonModule } from './comparison.module.js';
import { ComparisonService } from './comparison.service.js';
import { Design, type DesignWorld } from './design-world.support-spec.js';

const quiet = () => {};

@Global()
@Module({
  providers: [
    { provide: ConfigService, useValue: { get: () => undefined } },
    {
      provide: PinoLogger,
      useValue: { setContext: quiet, info: quiet, warn: quiet, error: quiet },
    },
  ],
  exports: [ConfigService, PinoLogger],
})
class InfraModule {}

let t: TestDatabase;
let world: DesignWorld;
let moduleRef: TestingModule;
let app: INestApplication;
let server: Server;

beforeAll(async () => {
  t = await createTestDatabase();
  const design = await Design.load();
  world = await design.insert(t.db, design.seed('skillVsNoSkill'));
  await t.db.transaction((tx) => reconcileExperiment(tx, world.experimentId));
  moduleRef = await Test.createTestingModule({
    imports: [InfraModule, DatabaseModule, ExperimentViewsModule, ComparisonModule],
  })
    .overrideProvider(DB)
    .useValue(t.db)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  server = app.getHttpServer() as Server;
});

afterAll(async () => {
  await app?.close();
  await t?.close();
});

const path = (query = '') => `/api/experiments/${world.experimentId}/comparison${query}`;

const refusal = (body: unknown) => ApiErrorBodySchema.parse(body);

describe('GET /api/experiments/:id/comparison', () => {
  it('answers the comparison of the first candidate on the primary key by default', async () => {
    const res = await request(server).get(path()).expect(200);
    const view = ComparisonViewSchema.parse(res.body);
    expect(view).toMatchObject({
      candidate: { versionId: world.versionIds.get('with-skill') },
      scoreKey: 'primary',
      filter: 'all',
      statistics: { observedDelta: 0.217, lo: 0.117, hi: 0.333, verdict: 'better' },
    });
    expect(view.rows).toHaveLength(12);
  });

  it('takes the candidate, the key and the filter from the query', async () => {
    const candidate = world.versionIds.get('with-skill')!;
    const res = await request(server)
      .get(path(`?candidate=${candidate}&key=any_failed&filter=unchanged`))
      .expect(200);
    const view = ComparisonViewSchema.parse(res.body);
    expect(view).toMatchObject({ scoreKey: 'any_failed', filter: 'unchanged' });
    expect(view.rows.every((r) => r.change === 'unchanged')).toBe(true);
    expect(view.rows).toHaveLength(view.filterCounts.unchanged);
  });

  it('answers 404 for an unknown experiment', async () => {
    const res = await request(server).get('/api/experiments/01NOPE/comparison').expect(404);
    expect(refusal(res.body)).toEqual({
      statusCode: 404,
      message: 'Experiment 01NOPE does not exist.',
    });
  });

  it('answers 400 for a candidate the experiment does not test', async () => {
    const baseline = world.versionIds.get('baseline')!;
    const res = await request(server)
      .get(path(`?candidate=${baseline}`))
      .expect(400);
    expect(refusal(res.body)).toEqual({
      statusCode: 400,
      message: `Configuration version ${baseline} is not a candidate of experiment ${world.experimentId}.`,
    });
  });

  it('answers 400 for a key that is not on every selected task', async () => {
    const res = await request(server).get(path('?key=rationale')).expect(400);
    expect(refusal(res.body).message).toMatch(
      /^Score key rationale is not declared by every selected task \(missing from /,
    );
  });

  it('answers 400 with the issue for a filter it does not know, or an empty candidate', async () => {
    const res = await request(server).get(path('?filter=better')).expect(400);
    expect(refusal(res.body)).toMatchObject({
      statusCode: 400,
      message: 'Validation failed',
      issues: [{ path: 'filter' }],
    });
    await request(server).get(path('?candidate=')).expect(400);
  });

  it('leaves GET /api/experiments/:id to the Phase 2 reads, which share its cache', async () => {
    const res = await request(server).get(`/api/experiments/${world.experimentId}`).expect(200);
    const detail = ExperimentDetailSchema.parse(res.body);
    expect(detail.verdicts.map((v) => [v.verdict, v.delta, v.lo, v.hi])).toEqual([
      ['better', 0.217, 0.117, 0.333],
    ]);
    const views = moduleRef.get(ExperimentViewsService) as unknown as { comparisons: unknown };
    expect(views.comparisons).toBe(moduleRef.get(ComparisonService));
  });

  it('is in the API document with its query', () => {
    const document = buildApiDocument(app);
    const operation = document.paths['/api/experiments/{id}/comparison']?.get;
    expect(operation?.parameters?.map((p) => ('name' in p ? p.name : null)).sort()).toEqual([
      'candidate',
      'filter',
      'id',
      'key',
    ]);
    expect(Object.keys(operation?.responses ?? {})).toEqual(
      expect.arrayContaining(['200', '400', '404']),
    );
  });
});
