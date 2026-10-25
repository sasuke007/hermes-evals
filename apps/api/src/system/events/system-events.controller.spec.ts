/**
 * GET /api/system/events over HTTP: a Nest application with
 * SystemEventsModule and DatabaseModule on PGlite, polling every 50 ms. The
 * first `summary` arrives on connect and parses with SystemEventSchema; the
 * next ones follow what the database says; 503 past the cap answers as JSON.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { ApiErrorBodySchema, SystemEventSchema } from '@hermes-evals/shared';
import type { Server } from 'node:http';
import { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { seedExperiment } from '../../../test/support/seed.js';
import { DatabaseModule } from '../../database/database.module.js';
import { DB } from '../../database/db.provider.js';
import {
  eventually,
  isStream,
  openSse,
  type SseStream,
} from '../../experiments/sse/sse-client.support-spec.js';
import { SystemEventsModule } from './system-events.module.js';
import {
  SYSTEM_EVENTS_OPTIONS,
  SystemEventsHub,
  type SystemEventsOptions,
} from './system-events.hub.js';

const quiet = () => {};

function infra(options: Partial<SystemEventsOptions>) {
  @Global()
  @Module({
    providers: [
      { provide: ConfigService, useValue: { get: () => undefined } },
      {
        provide: PinoLogger,
        useValue: { setContext: quiet, info: quiet, warn: quiet, error: quiet },
      },
      { provide: SYSTEM_EVENTS_OPTIONS, useValue: options },
    ],
    exports: [ConfigService, PinoLogger, SYSTEM_EVENTS_OPTIONS],
  })
  class InfraModule {}
  return InfraModule;
}

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: INestApplication;
let server: Server;
const streams: SseStream[] = [];

async function startApp(options: Partial<SystemEventsOptions> = {}): Promise<void> {
  const moduleRef = await Test.createTestingModule({
    imports: [infra({ pollMs: 50, ...options }), DatabaseModule, SystemEventsModule],
  })
    .overrideProvider(DB)
    .useValue(t.db)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0, '127.0.0.1');
  server = app.getHttpServer() as Server;
}

async function stream(): Promise<SseStream> {
  const answer = await openSse(server, '/api/system/events');
  if (!isStream(answer)) throw new Error(`no stream: ${answer.status} ${answer.body}`);
  streams.push(answer);
  return answer;
}

beforeEach(async () => {
  t = await createTestDatabase();
});

afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await app?.close();
  await t.close();
});

describe('GET /api/system/events', () => {
  it('sends the summary on connect and on every tick after', async () => {
    await startApp();
    const s = await stream();
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    await s.until((m) => m.length >= 1);
    const first = SystemEventSchema.parse(JSON.parse(s.messages[0]!.data));
    expect(s.messages[0]!.event).toBe('summary');
    expect(first.summary).toMatchObject({ running: { count: 0 }, queuedRuns: 0, workers: [] });

    await seedExperiment(t.db);
    await s.until((m) =>
      m.some((x) => SystemEventSchema.parse(JSON.parse(x.data)).summary.queuedRuns === 4),
    );
    const last = SystemEventSchema.parse(JSON.parse(s.messages.at(-1)!.data));
    expect(last.summary.running).toMatchObject({ count: 1, total: 4 });
  });

  it('answers 503 past the cap and stops polling when every tab closes', async () => {
    await startApp({ maxSubscribers: 1 });
    const hub = app.get(SystemEventsHub);
    const s = await stream();
    await s.until((m) => m.length >= 1);

    const refused = await openSse(server, '/api/system/events');
    expect(refused.status).toBe(503);
    if (!isStream(refused)) {
      expect(ApiErrorBodySchema.parse(JSON.parse(refused.body)).statusCode).toBe(503);
    }

    s.close();
    await eventually(() => hub.subscribers === 0 && !hub.polling);
  });
});
