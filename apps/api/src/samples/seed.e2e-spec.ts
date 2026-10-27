/**
 * The samples seed end to end (Phase 8 G3): the real AppModule on a fresh
 * Postgres 17 database with SAMPLES_DIR at the repository's samples/, booted
 * the way main.ts boots it, twice. The first start answers at once while the
 * seed runs, then reports every sample created and serves them on the
 * pages' endpoints; the second start finds everything and skips it. No
 * worker, no model: the seed only stores definitions.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigurationListRowSchema,
  McpServerRowSchema,
  ResourceCountsSchema,
  SAMPLE_EXPERIMENT,
  SystemSetupSchema,
  seedCounts,
  type SystemSetup,
} from '@hermes-evals/shared';
import type { Env } from '../config/env.js';
import { SampleSeedService } from './seed.service.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const SAMPLES = fileURLToPath(new URL('../../../../samples', import.meta.url));

describe.skipIf(!SERVER_URL)('the samples seed on Postgres 17', () => {
  const database = `hermes_evals_seed_e2e_${process.pid}`;
  let dataDir: string;

  const admin = async (statement: string) => {
    const client = new pg.Client({ connectionString: SERVER_URL });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };

  /** The real API, as main.ts starts it (listening is not needed for supertest). */
  async function startApi(): Promise<NestExpressApplication> {
    const { AppModule } = await import('../app.module.js');
    const { configureApi } = await import('../app.setup.js');
    const api = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    configureApi(api);
    await api.init();
    return api;
  }

  const setupOf = async (api: NestExpressApplication): Promise<SystemSetup> =>
    SystemSetupSchema.parse(
      (await request(api.getHttpServer()).get('/api/system/setup').expect(200)).body,
    );

  beforeAll(async () => {
    await admin(`drop database if exists ${database} with (force)`);
    await admin(`create database ${database}`);
    const parsed = new URL(SERVER_URL!);
    parsed.pathname = `/${database}`;
    dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-seed-e2e-'));
    // ConfigModule reads the environment when AppModule is imported, so it is
    // set first. Values set here win over the repository's .env.
    Object.assign(process.env, {
      NODE_ENV: 'production',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: parsed.toString(),
      DATA_DIR: dataDir,
      SUITES_DIR: join(dataDir, 'suites'),
      SAMPLES_DIR: SAMPLES,
      SEED_SAMPLES: 'true',
      PRICES_FILE: join(dataDir, 'no-prices.yaml'),
      EGRESS_ADMIN_SOCKET: join(dataDir, 'no-egress.sock'),
      DOCKER_SOCKET: join(dataDir, 'no-guard.sock'),
      // Compose's defaults: the mock judge.
      JUDGE_PROVIDER: 'custom',
      JUDGE_MODEL: 'mock/scripted',
      JUDGE_BASE_URL: 'http://mock-model:8090/v1',
    } satisfies Partial<Record<keyof Env, string>>);
  }, 60_000);

  afterAll(async () => {
    await admin(`drop database if exists ${database} with (force)`);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  }, 60_000);

  it('seeds every sample at the first start, and skips them all at the next', async () => {
    const first = await startApi();
    try {
      // The start does not wait for the seed.
      expect(['running', 'done']).toContain((await setupOf(first)).seed.state);
      await first.get(SampleSeedService).settled();
      const setup = await setupOf(first);
      expect(setup.judge).toEqual({
        provider: 'custom',
        model: 'mock/scripted',
        mock: true,
        mockModelName: false,
      });
      expect(setup.seed.state).toBe('done');
      expect(seedCounts(setup.seed)).toEqual({ created: 40, skipped: 0, failed: 0 });

      const http = request(first.getHttpServer());
      const configurations = ConfigurationListRowSchema.array().parse(
        (await http.get('/api/configurations').expect(200)).body,
      );
      expect(configurations).toHaveLength(26);
      const names = configurations.map((c) => c.name);
      expect(names).toEqual(
        expect.arrayContaining([SAMPLE_EXPERIMENT.baseline, SAMPLE_EXPERIMENT.candidate]),
      );
      const servers = McpServerRowSchema.array().parse(
        (await http.get('/api/resources/mcp-servers').expect(200)).body,
      );
      // Frozen: the two with-mcp configurations use them.
      expect(servers.map((s) => [s.name, s.frozen, s.usedBy.length])).toEqual([
        ['invoice-db', true, 2],
        ['vendor-directory', true, 2],
      ]);
      const counts = ResourceCountsSchema.parse(
        (await http.get('/api/resources/counts').expect(200)).body,
      );
      expect(counts).toMatchObject({ skills: 4, documents: 8, mcpServers: 2 });
    } finally {
      await first.close();
    }

    const second = await startApi();
    try {
      await second.get(SampleSeedService).settled();
      const setup = await setupOf(second);
      expect(setup.seed.state).toBe('done');
      expect(seedCounts(setup.seed)).toEqual({ created: 0, skipped: 40, failed: 0 });
    } finally {
      await second.close();
    }
  });
});
