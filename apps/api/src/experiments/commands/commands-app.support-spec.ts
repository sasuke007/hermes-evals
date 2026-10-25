/**
 * The experiment and run command modules over HTTP, as AppModule mounts
 * them under /api: RequestedWithGuard and DatabaseErrorFilter as in
 * AppModule, the DB token on PGlite (or, for the e2e, on a Postgres 17
 * database through node-postgres), and a real pg-boss on the same database,
 * so jobs are sent in the commands' own transactions exactly as in
 * production. nous-login is a stand-in whose status each test sets.
 * Test-only (see commands-seed.support-spec.ts).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { LaunchExperimentResultSchema, type NousStatus } from '@hermes-evals/shared';
import { PinoLogger } from 'nestjs-pino';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { fromPglite, PgBoss, type JobWithMetadata } from 'pg-boss';
import request from 'supertest';
import { createTestDatabase } from '../../../test/support/database.js';
import { DatabaseErrorFilter } from '../../common/database-error.filter.js';
import { RequestedWithGuard } from '../../common/requested-with.guard.js';
import { DB } from '../../database/db.provider.js';
import * as schema from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { ensureQueues, QueueService } from '../../queue/queue.service.js';
import { QUEUES, type ExecuteRunJob } from '../../queue/queues.js';
import { RunCommandsModule } from '../../runs/commands/run-commands.module.js';
import {
  seedConfiguration,
  seedSuite,
  seedWorker,
  type ConfigSeed,
  type SeededConfiguration,
  type SeededSuite,
} from './commands-seed.support-spec.js';
import { ExperimentCommandsModule } from './experiment-commands.module.js';
import { PROVIDER_READINESS_DEPS } from './provider-gate.js';

/** The price table the tests launch with: the mock model free, one priced model, nothing else. */
export const PRICES_YAML = `models:
  mock/scripted:
    input_per_1m: 0
    output_per_1m: 0
    checked_at: '2026-10-24'
  test/priced:
    input_per_1m: 1
    output_per_1m: 10
    checked_at: '2026-10-24'
`;

export interface CommandsApp {
  /** The database the app runs on; `t.db` reads like the PGlite specs elsewhere. */
  t: { db: AppDb };
  boss: PgBoss;
  app: INestApplication;
  /** nous-login's status as the stand-in reports it; tests change it. */
  nous: { status: NousStatus };
  pricesFile: string;
  /** A state-changing request with the headers the web sends. */
  post(path: string, body?: object): request.Test;
  get(path: string): request.Test;
  /** Every execute-run job, oldest first. */
  jobs(): Promise<JobWithMetadata<ExecuteRunJob>[]>;
  close(): Promise<void>;
}

/** The database and pg-boss an app runs on, and how to release them. */
interface Backend {
  db: AppDb;
  boss: PgBoss;
  close(): Promise<void>;
}

async function pgliteBackend(): Promise<Backend> {
  const t = await createTestDatabase();
  const boss = new PgBoss({
    db: fromPglite(t.pg),
    backend: 'pglite',
    schema: 'pgboss',
    supervise: false,
    schedule: false,
  });
  return { db: t.db, boss, close: () => t.close() };
}

/** A migrated Postgres database: a pool for the app (several connections, so races are real). */
function postgresBackend(connectionString: string): Backend {
  const pool = new pg.Pool({ connectionString, max: 8 });
  const boss = new PgBoss({
    connectionString,
    schema: 'pgboss',
    supervise: false,
    schedule: false,
  });
  return { db: drizzle(pool, { schema }), boss, close: () => pool.end() };
}

/**
 * The command modules on a fresh PGlite database, or with `connectionString`
 * on that already migrated Postgres database.
 */
export async function createCommandsApp(
  options: { connectionString?: string } = {},
): Promise<CommandsApp> {
  const backend = options.connectionString
    ? postgresBackend(options.connectionString)
    : await pgliteBackend();
  const { db, boss } = backend;
  boss.on('error', () => {});
  await boss.start();
  await ensureQueues(boss);

  const dir = await mkdtemp(join(tmpdir(), 'hermes-evals-commands-'));
  const pricesFile = join(dir, 'prices.yaml');
  await writeFile(pricesFile, PRICES_YAML);
  const nous = { status: 'connected' as NousStatus };
  const env: Record<string, string> = { PRICES_FILE: pricesFile };

  /** What AppModule's ConfigModule, LoggerModule, DatabaseModule, QueueModule and NousLoginModule provide. */
  @Global()
  @Module({
    providers: [
      { provide: DB, useValue: db },
      { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
      {
        provide: PinoLogger,
        useValue: { setContext: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      },
      { provide: QueueService, useValue: { instance: boss, ping: async () => 'ok' } },
      { provide: PROVIDER_READINESS_DEPS, useValue: { nousStatus: async () => nous.status } },
    ],
    exports: [DB, ConfigService, PinoLogger, QueueService, PROVIDER_READINESS_DEPS],
  })
  class InfraModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [InfraModule, ExperimentCommandsModule, RunCommandsModule],
    providers: [
      { provide: APP_GUARD, useClass: RequestedWithGuard },
      { provide: APP_FILTER, useClass: DatabaseErrorFilter },
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();

  return {
    t: { db },
    boss,
    app,
    nous,
    pricesFile,
    post: (path, body = {}) =>
      request(app.getHttpServer())
        .post(`/api${path}`)
        .set('x-requested-with', 'hermes-evals')
        .set('content-type', 'application/json')
        .send(body),
    get: (path) => request(app.getHttpServer()).get(`/api${path}`),
    jobs: () => boss.findJobs<ExecuteRunJob>(QUEUES.executeRun, { limit: 100_000 }),
    close: async () => {
      await app.close();
      await boss.stop({ graceful: false, timeout: 1000 });
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** The live (created, retry or active) execute-run jobs, by singleton key. */
export async function liveJobKeys(c: CommandsApp): Promise<string[]> {
  const jobs = await c.jobs();
  return jobs
    .filter((j) => j.state === 'created' || j.state === 'retry' || j.state === 'active')
    .map((j) => j.singletonKey ?? '')
    .sort();
}

/** What `launched` sets up: a suite of `taskKeys`, two custom configurations, a proven worker. */
export interface Launched {
  id: string;
  workerId: string;
  baseline: SeededConfiguration;
  candidate: SeededConfiguration;
  suite: SeededSuite;
}

/** Seeds a suite, two configurations and a proven worker, and launches through the API. */
export async function launched(
  c: CommandsApp,
  options: {
    taskKeys?: string[];
    repetitions?: number;
    spendCeilingUsd?: number | null;
    baseline?: ConfigSeed;
  } = {},
): Promise<Launched> {
  const taskKeys = options.taskKeys ?? ['alpha', 'bravo'];
  const suite = await seedSuite(c.t.db, { tasks: taskKeys.map((key) => ({ key })) });
  const baseline = await seedConfiguration(c.t.db, 'baseline', options.baseline);
  const candidate = await seedConfiguration(c.t.db, 'with-skill');
  const workerId = await seedWorker(c.t.db);
  const res = await c
    .post('/experiments', {
      name: 'Skill vs no skill',
      description: 'Does the skill help?',
      suiteId: suite.id,
      taskKeys,
      baselineVersionId: baseline.versionId,
      candidateVersionIds: [candidate.versionId],
      repetitions: options.repetitions ?? 1,
      concurrency: 2,
      spendCeilingUsd: options.spendCeilingUsd ?? null,
      timeBudgetOverrideS: null,
      expectedConfigHashes: {
        [baseline.versionId]: baseline.configHash,
        [candidate.versionId]: candidate.configHash,
      },
    })
    .expect(201);
  return {
    id: LaunchExperimentResultSchema.parse(res.body).id,
    workerId,
    baseline,
    candidate,
    suite,
  };
}
