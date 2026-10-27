/**
 * GET /api/system/setup (Phase 8 G2, G3) over HTTP, as AppModule mounts it:
 * the judge as the settings make it, the mock under Compose's defaults and
 * a real model once .env sets one, and this start's seed report. Every body
 * is checked against SystemSetupSchema.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SystemSetupSchema, type SystemSetup } from '@hermes-evals/shared';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { validateEnv } from '../config/env.js';
import { configOf } from '../resources/skills/testing.helper-spec.js';
import { SeedReporter } from './seed-report.js';
import { SetupController } from './setup.controller.js';

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** The controller over a validated environment `raw`, with `reporter`. */
async function setup(raw: Record<string, string>, reporter = new SeedReporter()) {
  @Global()
  @Module({
    providers: [{ provide: ConfigService, useValue: configOf(validateEnv(raw)) }],
    exports: [ConfigService],
  })
  class InfraModule {}
  const moduleRef = await Test.createTestingModule({
    imports: [InfraModule],
    controllers: [SetupController],
    providers: [{ provide: SeedReporter, useValue: reporter }],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
  const res = await request(app.getHttpServer()).get('/api/system/setup').expect(200);
  return SystemSetupSchema.parse(res.body) as SystemSetup;
}

/** What Compose gives the api with nothing set in the shell or .env. */
const COMPOSE_DEFAULTS = {
  JUDGE_PROVIDER: 'custom',
  JUDGE_MODEL: 'mock/scripted',
  JUDGE_BASE_URL: 'http://mock-model:8090/v1',
};

describe('GET /api/system/setup', () => {
  it("shows Compose's default judge as the mock model", async () => {
    const body = await setup(COMPOSE_DEFAULTS);
    expect(body.judge).toEqual({
      provider: 'custom',
      model: 'mock/scripted',
      mock: true,
      mockModelName: false,
    });
  });

  it('shows a real judge set in .env, the default base URL beside it ignored', async () => {
    const body = await setup({
      ...COMPOSE_DEFAULTS,
      JUDGE_PROVIDER: 'nous',
      JUDGE_MODEL: 'openai/gpt-6.1-sol',
    });
    expect(body.judge).toEqual({
      provider: 'nous',
      model: 'openai/gpt-6.1-sol',
      mock: false,
      mockModelName: false,
    });
    // Outside Compose, nothing set: nous with no default model.
    expect((await setup({})).judge).toEqual({
      provider: 'nous',
      model: null,
      mock: false,
      mockModelName: false,
    });
  });

  it('shows no model when .env sets only a real provider, and flags mock/scripted on a real custom URL', async () => {
    // JUDGE_PROVIDER=openrouter alone: the mock's name is read as unset (env.ts), as in Phase 7.
    expect((await setup({ ...COMPOSE_DEFAULTS, JUDGE_PROVIDER: 'openrouter' })).judge).toEqual({
      provider: 'openrouter',
      model: null,
      mock: false,
      mockModelName: false,
    });
    await app?.close();
    // custom with a real JUDGE_BASE_URL alone keeps the name, flagged.
    const real = await setup({
      ...COMPOSE_DEFAULTS,
      JUDGE_BASE_URL: 'https://judge.example.com/v1',
    });
    expect(real.judge).toEqual({
      provider: 'custom',
      model: 'mock/scripted',
      mock: false,
      mockModelName: true,
    });
  });

  it("carries the seed's report as it stands", async () => {
    const reporter = new SeedReporter();
    expect((await setup(COMPOSE_DEFAULTS, reporter)).seed).toEqual({
      state: 'off',
      startedAt: null,
      finishedAt: null,
      items: [],
      error: null,
    });
    await app!.close();
    reporter.start(new Date('2026-10-27T10:00:00Z'));
    reporter.add({ kind: 'mcp_server', name: 'invoice-db', outcome: 'created', detail: 'stdio' });
    reporter.finish(new Date('2026-10-27T10:00:02Z'));
    expect((await setup(COMPOSE_DEFAULTS, reporter)).seed).toEqual({
      state: 'done',
      startedAt: '2026-10-27T10:00:00.000Z',
      finishedAt: '2026-10-27T10:00:02.000Z',
      items: [{ kind: 'mcp_server', name: 'invoice-db', outcome: 'created', detail: 'stdio' }],
      error: null,
    });
  });
});
