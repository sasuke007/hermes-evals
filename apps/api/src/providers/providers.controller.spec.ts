/**
 * The providers routes over HTTP as AppModule mounts them: ProvidersModule
 * with the global RequestedWithGuard, PGlite behind the DB token, and the
 * in-process nous-login stand-in at NOUS_LOGIN_URL. Every body is parsed with
 * its shared contract.
 */
import { Global, Inject, Injectable, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  ApiErrorBodySchema,
  NousLoginSchema,
  ProvidersResponseSchema,
  type ProviderInfo,
} from '@hermes-evals/shared';
import { eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { seedExperiment } from '../../test/support/seed.js';
import { MISSING_REQUESTED_WITH, RequestedWithGuard } from '../common/requested-with.guard.js';
import { DatabaseModule } from '../database/database.module.js';
import { DB } from '../database/db.provider.js';
import { experiments, workers } from '../database/schema/index.js';
import { buildApiDocument } from '../openapi/document.js';
import { PROVIDER_READINESS_DEPS } from '../experiments/commands/provider-gate.js';
import { FAKE_USER_CODE, FakeNousLogin } from './fake-nous-login.support-spec.js';
import { ProvidersModule } from './providers.module.js';
import { HOST_LOGIN_CONFLICT } from './providers.service.js';
import type { ProviderReadinessDeps } from './readiness.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let fake: FakeNousLogin;

/** AppModule's ConfigModule (knowing only NOUS_LOGIN_URL) and LoggerModule. */
@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: { get: (key: string) => (key === 'NOUS_LOGIN_URL' ? fake.url : undefined) },
    },
    { provide: PinoLogger, useValue: { setContext: () => {}, info: () => {}, warn: () => {} } },
  ],
  exports: [ConfigService, PinoLogger],
})
class InfraModule {}

/** A module that imports nothing, as the experiment commands' module does not import providers. */
@Injectable()
class NeedsReadiness {
  constructor(@Inject(PROVIDER_READINESS_DEPS) readonly deps: ProviderReadinessDeps) {}
}
@Module({ providers: [NeedsReadiness], exports: [NeedsReadiness] })
class ConsumerModule {}

const JSON_HEADERS = { 'x-requested-with': 'hermes-evals', 'content-type': 'application/json' };

describe('providers routes', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let seeded: Awaited<ReturnType<typeof seedExperiment>>;

  beforeEach(async () => {
    fake = await new FakeNousLogin().listen();
    t = await createTestDatabase();
    seeded = await seedExperiment(t.db);
    const moduleRef = await Test.createTestingModule({
      imports: [InfraModule, DatabaseModule, ProvidersModule, ConsumerModule],
      providers: [{ provide: APP_GUARD, useClass: RequestedWithGuard }],
    })
      .overrideProvider(DB)
      .useValue(t.db)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
    await t?.close();
    await fake?.close();
  });

  const http = () => request(app.getHttpServer());
  const providers = async (): Promise<ProviderInfo[]> =>
    ProvidersResponseSchema.parse((await http().get('/api/providers').expect(200)).body);
  const nous = async () => (await providers()).find((p) => p.id === 'nous')!;
  const send = (method: 'post' | 'delete', path: string) =>
    http()[method](path).set(JSON_HEADERS).send({});

  it('GET /api/providers lists every provider with usage, pauses and presence', async () => {
    let rows = await providers();
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['nous', 'not_connected'],
      ['openrouter', 'missing'],
      ['nous-api', 'missing'],
      ['openai', 'missing'],
      ['anthropic', 'missing'],
    ]);
    expect(rows[0]).toMatchObject({ usedBy: ['baseline', 'with-skill'], pausedExperiments: 0 });

    await t.db
      .update(experiments)
      .set({ status: 'paused', pauseReason: 'provider_disconnected', pausedAt: new Date() })
      .where(eq(experiments.id, seeded.experiment.id));
    await t.db
      .update(workers)
      .set({ egressEnvNames: ['OPENROUTER_API_KEY'] })
      .where(eq(workers.id, seeded.worker.id));
    rows = await providers();
    expect(rows[0]!.pausedExperiments).toBe(1);
    expect(rows.find((r) => r.id === 'openrouter')).toMatchObject({
      status: 'configured',
      envVar: 'OPENROUTER_API_KEY',
      usedBy: [],
      pausedExperiments: 0,
    });
  });

  it('runs the connect flow through nous-login', async () => {
    const started = NousLoginSchema.parse(
      (await send('post', '/api/providers/nous/login').expect(200)).body,
    );
    expect(started).toMatchObject({ state: 'waiting_for_approval', userCode: FAKE_USER_CODE });
    expect(await nous()).toMatchObject({ status: 'waiting_for_approval', login: started });
    const polled = NousLoginSchema.parse(
      (await http().get('/api/providers/nous/login').expect(200)).body,
    );
    expect(polled.state).toBe('waiting_for_approval');

    fake.approve();
    expect(await nous()).toMatchObject({
      status: 'connected',
      scope: 'inference:invoke',
      login: null,
    });
    expect((await http().get('/api/providers/nous/login').expect(200)).body.state).toBe(
      'connected',
    );

    const cancelled = NousLoginSchema.parse(
      (await send('delete', '/api/providers/nous/login').expect(200)).body,
    );
    expect(cancelled.state).toBe('connected');
    const out = NousLoginSchema.parse(
      (await send('post', '/api/providers/nous/logout').expect(200)).body,
    );
    expect(out.state).toBe('not_connected');
    expect((await nous()).status).toBe('not_connected');
    expect(fake.calls).toEqual(
      expect.arrayContaining(['POST /login', 'GET /login', 'DELETE /login', 'POST /logout']),
    );
  });

  it('refuses the state-changing routes without X-Requested-With', async () => {
    for (const [method, path] of [
      ['post', '/api/providers/nous/login'],
      ['delete', '/api/providers/nous/login'],
      ['post', '/api/providers/nous/logout'],
    ] as const) {
      const res = await http()
        [method](path)
        .set('content-type', 'application/json')
        .send({})
        .expect(403);
      expect(ApiErrorBodySchema.parse(res.body)).toEqual({
        statusCode: 403,
        message: MISSING_REQUESTED_WITH,
      });
    }
    expect(fake.calls).toEqual([]);
  });

  it('answers 409 in host mode, and reports the host login without asking nous-login', async () => {
    await t.db
      .update(workers)
      .set({
        hostProxy: {
          target: 'host.lima.internal:8645',
          reachable: true,
          checked_at: new Date().toISOString(),
        },
      })
      .where(eq(workers.id, seeded.worker.id));
    const res = await send('post', '/api/providers/nous/login').expect(409);
    expect(ApiErrorBodySchema.parse(res.body)).toEqual({
      statusCode: 409,
      message: HOST_LOGIN_CONFLICT,
    });
    expect(await nous()).toMatchObject({
      status: 'host',
      hostCommand: 'hermes proxy start --provider nous',
      login: null,
    });
    expect(fake.calls).toEqual([]);
  });

  it('reports nous-login unavailable with its reason, and still answers the poll', async () => {
    fake.unavailable = 'hermes_cli.auth._nous_device_code_login now requires device_label';
    expect((await nous()).status).toBe('unavailable');
    const res = await send('post', '/api/providers/nous/login').expect(503);
    expect(ApiErrorBodySchema.parse(res.body)).toEqual({
      statusCode: 503,
      message:
        'The Nous Portal login service is unavailable: hermes_cli.auth._nous_device_code_login now requires device_label',
    });
    const polled = NousLoginSchema.parse(
      (await http().get('/api/providers/nous/login').expect(200)).body,
    );
    expect(polled.state).toBe('not_connected');
    await send('post', '/api/providers/nous/logout').expect(503);
  });

  it('answers 502 when nous-login answers outside its contract', async () => {
    fake.brokenStatus = 500;
    const res = await send('post', '/api/providers/nous/login').expect(502);
    expect(ApiErrorBodySchema.parse(res.body)).toEqual({
      statusCode: 502,
      message: 'nous-login answered HTTP 500 to POST /login: Boom: broken',
    });
    expect((await nous()).status).toBe('unavailable');
  });

  it('documents every route in /api/docs with the shared contract', () => {
    const document = buildApiDocument(app);
    const paths = document.paths;
    const ok = (path: string, method: 'get' | 'post' | 'delete') =>
      (paths[path]?.[method]?.responses['200'] as { content?: Record<string, { schema?: object }> })
        ?.content?.['application/json']?.schema;
    expect(ok('/api/providers', 'get')).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/ProviderInfo' },
    });
    expect(document.components?.schemas?.['NousLogin']).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['state']),
    });
    for (const [path, method] of [
      ['/api/providers/nous/login', 'post'],
      ['/api/providers/nous/login', 'get'],
      ['/api/providers/nous/login', 'delete'],
      ['/api/providers/nous/logout', 'post'],
    ] as const) {
      expect(ok(path, method)).toEqual({ $ref: '#/components/schemas/NousLogin' });
    }
  });

  it('provides the readiness deps to every module, on the same nous-login', async () => {
    const { deps } = app.get(NeedsReadiness);
    expect(await deps.nousStatus()).toBe('not_connected');
    fake.approve();
    expect(await deps.nousStatus()).toBe('connected');
  });
});
