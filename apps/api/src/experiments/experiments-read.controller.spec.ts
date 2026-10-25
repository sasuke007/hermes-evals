/**
 * The experiment reads over HTTP, as AppModule mounts them under /api: a
 * Nest application with ExperimentViewsModule and DatabaseModule, the DB
 * token on PGlite and the stream polling every 50 ms. Every body parses with
 * its shared contract, the stream's messages with ExperimentEventSchema, and
 * a 404 or 503 answers as JSON before any stream opens.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  ApiErrorBodySchema,
  ExperimentDetailSchema,
  ExperimentEventSchema,
  ExperimentListRowSchema,
} from '@hermes-evals/shared';
import type { Server } from 'node:http';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { DatabaseModule } from '../database/database.module.js';
import { DB } from '../database/db.provider.js';
import { buildApiDocument } from '../openapi/document.js';
import { ExperimentViewsModule } from './experiment-views.module.js';
import {
  EXPERIMENT_EVENTS_OPTIONS,
  ExperimentEventsHub,
  type ExperimentEventsOptions,
} from './sse/experiment-events.hub.js';
import { eventually, isStream, openSse, type SseStream } from './sse/sse-client.support-spec.js';
import { at, launch, pause, scored, seedWorld, start } from './views/seed.support-spec.js';

const quiet = () => {};

/** What AppModule's ConfigModule and LoggerModule provide, and the stream's test settings. */
function infra(options: Partial<ExperimentEventsOptions>) {
  @Global()
  @Module({
    providers: [
      { provide: ConfigService, useValue: { get: () => undefined } },
      {
        provide: PinoLogger,
        useValue: { setContext: quiet, info: quiet, warn: quiet, error: quiet },
      },
      { provide: EXPERIMENT_EVENTS_OPTIONS, useValue: options },
    ],
    exports: [ConfigService, PinoLogger, EXPERIMENT_EVENTS_OPTIONS],
  })
  class InfraModule {}
  return InfraModule;
}

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: INestApplication;
let server: Server;
const streams: SseStream[] = [];

async function startApp(options: Partial<ExperimentEventsOptions> = {}): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [infra({ pollMs: 50, ...options }), DatabaseModule, ExperimentViewsModule],
  })
    .overrideProvider(DB)
    .useValue(t.db)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  server = app.getHttpServer() as Server;
}

async function stream(path: string): Promise<SseStream> {
  const answer = await openSse(server, path);
  if (!isStream(answer)) throw new Error(`no stream: ${answer.status} ${answer.body}`);
  streams.push(answer);
  return answer;
}

const parsed = (s: SseStream) =>
  s.messages.map((m) => ExperimentEventSchema.parse(JSON.parse(m.data)));

beforeEach(async () => {
  t = await createTestDatabase();
});

afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await app?.close();
  await t.close();
});

describe('GET /api/experiments and /api/experiments/:id', () => {
  beforeEach(() => startApp());

  it('lists experiments newest first and shows one', async () => {
    const w = await seedWorld(t.db);
    const older = await launch(t.db, w, { name: 'older', createdAt: at(0) });
    const newer = await launch(t.db, w, { name: 'newer', createdAt: at(5) });
    await scored(t.db, w, newer.run('a/base/1'), {
      startedAt: at(6),
      durationS: 3,
      status: 'passed',
    });

    const list = ExperimentListRowSchema.array().parse(
      (await request(server).get('/api/experiments').expect(200)).body,
    );
    expect(list.map((r) => [r.name, r.doneRuns])).toEqual([
      ['newer', 1],
      ['older', 0],
    ]);

    const res = await request(server).get(`/api/experiments/${older.experiment.id}`).expect(200);
    const d = ExperimentDetailSchema.parse(res.body);
    expect(d).toMatchObject({ id: older.experiment.id, name: 'older', totalRuns: 8 });
  });

  it('documents the routes in /api/docs with their contracts', () => {
    const document = buildApiDocument(app);
    const schemas = document.components?.schemas ?? {};
    const list = document.paths['/api/experiments']?.get?.responses['200'];
    expect(list).toMatchObject({
      content: {
        'application/json': {
          schema: { type: 'array', items: { $ref: '#/components/schemas/ExperimentListRow' } },
        },
      },
    });
    const detail = document.paths['/api/experiments/{id}']?.get?.responses['200'];
    expect(JSON.stringify(detail)).toContain('#/components/schemas/ExperimentDetail');
    expect(JSON.stringify(schemas['ExperimentDetail'])).toContain('perConfiguration');
    const events = document.paths['/api/experiments/{id}/events']?.get?.responses;
    expect(events?.['200']).toMatchObject({
      content: {
        'text/event-stream': { schema: { $ref: '#/components/schemas/ExperimentEvent' } },
      },
    });
    expect(JSON.stringify(schemas['ExperimentEvent'])).toContain('"feed"');
    expect(events).toHaveProperty('404');
    expect(events).toHaveProperty('503');
  });

  it('answers an unknown experiment with 404 and the error body', async () => {
    const res = await request(server).get('/api/experiments/01NOPE').expect(404);
    expect(ApiErrorBodySchema.parse(res.body)).toEqual({
      statusCode: 404,
      message: 'Experiment 01NOPE does not exist.',
    });
  });
});

describe('GET /api/experiments/:id/events', () => {
  it('opens with experiment and counts, then sends what changes', async () => {
    await startApp();
    const w = await seedWorld(t.db);
    const { experiment, run } = await launch(t.db, w);
    const s = await stream(`/api/experiments/${experiment.id}/events`);
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(s.headers['x-accel-buffering']).toBe('no');

    await s.until((m) => m.length >= 2);
    expect(s.messages.map((m) => m.event)).toEqual(['experiment', 'counts']);
    expect(s.comments).toContain('open');
    const [first, counts] = parsed(s);
    expect(first).toMatchObject({ type: 'experiment', status: 'running', pauseReason: null });
    expect(counts).toMatchObject({ type: 'counts', doneRuns: 0, counts: { queued: 8 } });

    await start(t.db, w, run('a/base/1'), at(1));
    await s.until((m) => m.some((x) => x.event === 'run'));
    expect(parsed(s).find((e) => e.type === 'run')).toMatchObject({
      runId: run('a/base/1'),
      status: 'running',
      attempt: 1,
    });

    await scored(t.db, w, run('a/base/2'), { startedAt: at(1), durationS: 4, status: 'passed' });
    await s.until((m) => m.some((x) => x.event === 'feed'));
    expect(parsed(s).find((e) => e.type === 'feed')).toMatchObject({
      entry: { runId: run('a/base/2'), result: 'passed', durationS: 4 },
    });

    await pause(t.db, experiment.id, 'user', at(10));
    await s.until((m) => m.filter((x) => x.event === 'experiment').length === 2);
    expect(parsed(s).at(-1)).toMatchObject({
      type: 'experiment',
      status: 'paused',
      pauseReason: 'user',
    });
    // Every message's event name is its type.
    for (const m of s.messages) expect(JSON.parse(m.data)).toMatchObject({ type: m.event });
  });

  it('shares one poller between two tabs and stops it when both close', async () => {
    await startApp();
    const hub = app.get(ExperimentEventsHub);
    const w = await seedWorld(t.db);
    const { experiment } = await launch(t.db, w);
    const a = await stream(`/api/experiments/${experiment.id}/events`);
    const b = await stream(`/api/experiments/${experiment.id}/events`);
    await a.until((m) => m.length >= 2);
    await b.until((m) => m.length >= 2);
    expect(hub.watched).toBe(1);
    expect(hub.subscribers).toBe(2);

    a.close();
    await eventually(() => hub.subscribers === 1);
    b.close();
    await eventually(() => hub.watched === 0);
  });

  it('answers 404 before opening a stream for an unknown experiment', async () => {
    await startApp();
    const answer = await openSse(server, '/api/experiments/01NOPE/events');
    expect(isStream(answer)).toBe(false);
    expect(answer.status).toBe(404);
    if (!isStream(answer)) {
      expect(ApiErrorBodySchema.parse(JSON.parse(answer.body))).toMatchObject({ statusCode: 404 });
    }
  });

  it('answers 503 past the subscriber cap, and admits again once one closes', async () => {
    await startApp({ maxSubscribers: 1 });
    const hub = app.get(ExperimentEventsHub);
    const w = await seedWorld(t.db);
    const { experiment } = await launch(t.db, w);
    const first = await stream(`/api/experiments/${experiment.id}/events`);

    const refused = await openSse(server, `/api/experiments/${experiment.id}/events`);
    expect(isStream(refused)).toBe(false);
    expect(refused.status).toBe(503);
    if (!isStream(refused)) {
      expect(ApiErrorBodySchema.parse(JSON.parse(refused.body)).message).toContain(
        'Too many live connections (1)',
      );
    }

    first.close();
    await eventually(() => hub.subscribers === 0);
    const again = await stream(`/api/experiments/${experiment.id}/events`);
    await again.until((m) => m.length >= 2);
  });
});
