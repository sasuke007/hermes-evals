/**
 * The Phase 2 full-application e2e's harness: a fresh Postgres 17 database,
 * the real AppModule listening on a loopback port, and real WorkerModule
 * instances whose only stand-in is the sandbox (fake-trials.ts). Every HTTP
 * answer is parsed with its shared schema by the helpers here.
 *
 * Workers share one fake Docker daemon (engine and egress), as workers on one
 * machine share the real one, so a worker started after another one stopped
 * can confirm and recover what the first left behind.
 *
 * WorldOptions let a later phase's e2e reuse the harness with its own suite,
 * prices, trial scripts, settings and judge model (test/phase3.e2e-spec.ts).
 */
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { asc, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import request from 'supertest';
import { expect } from 'vitest';
import type { ZodType } from 'zod';
import {
  ApiErrorBodySchema,
  ConfigurationSaveResultSchema,
  ExperimentDetailSchema,
  LaunchExperimentResultSchema,
  NewExperimentOptionsSchema,
  type ApiErrorBody,
  type ConfigurationInput,
  type ExperimentDetail,
  type LaunchExperimentInput,
} from '@hermes-evals/shared';
import type { Env } from '../../src/config/env.js';
import * as schema from '../../src/database/schema/index.js';
import { SandboxService } from '../../src/sandbox/sandbox.service.js';
import { FakeNousLogin } from '../../src/providers/fake-nous-login.support-spec.js';
import type {
  FakeContainerInfo,
  FakeEgress,
  FakeEngine,
  FakeJudgeModel,
  FakeTrialScript,
} from './fake-engine.js';
import { fakeDaemon, fakeSandbox, TrialScripts } from './fake-trials.js';

export const IMAGE = 'hermes-evals/trial:v0.22.4-4d04303';
export const VOLUME = 'hermes-evals-e2e-trials';
export const SLOTS = ['hermes-evals-trial-0', 'hermes-evals-trial-1'];
export const SUITE_NAME = 'phase2';
/** The e2e suite: one task per Phase 2 answer scorer, copied from the `complete` fixture. */
export const TASKS = ['numeric', 'json_unordered', 'summary_file'] as const;
/** The stdio MCP value the candidate's trials get; it must never be stored. */
export const DB_SECRET = 'file:///opt/mcp/invoice-db/e2e-secret-4242.csv';
export const MOCK_BASE_URL = 'http://mock-model:8090/v1';
const COMPLETE = join(import.meta.dirname, '..', 'fixtures', 'suites', 'complete');

/** USD per 1M tokens: a trial of mock/priced costs 3300 × 1000 / 1e6 = $3.30. */
const PRICES = `models:
  mock/scripted:
    input_per_1m: 0
    output_per_1m: 0
    checked_at: '2026-10-24'
  mock/priced:
    input_per_1m: 1000
    output_per_1m: 0
    checked_at: '2026-10-24'
`;

export type Db = NodePgDatabase<typeof schema>;

/** What a world built for another phase changes; everything absent is Phase 2's. */
export interface WorldOptions {
  /** A suite directory (its suite.yaml and task folders), loaded as `name`, launched on `tasks`. */
  suite?: { name: string; dir: string; tasks: readonly string[] };
  /** prices.yaml's text. */
  prices?: string;
  /** Decides what each trial container does, instead of the world's TrialScripts. */
  script?: (container: FakeContainerInfo) => FakeTrialScript;
  /** The model behind egress's judge path. */
  judge?: FakeJudgeModel;
  /** More settings for the API and the workers, set before the modules are imported. */
  env?: Partial<Record<keyof Env, string>>;
}

export interface ConfigRef {
  name: string;
  configurationId: string;
  versionId: string;
}

const admin = async (serverUrl: string, statement: string) => {
  const client = new pg.Client({ connectionString: serverUrl });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
};

/** Resolves once `check` returns a value other than undefined; fails with `what` after `ms`. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined>,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const { attempts, runs } = schema;

export class Phase2World {
  readonly database: string;
  readonly scripts = new TrialScripts();
  readonly nous = new FakeNousLogin();
  api!: INestApplication;
  db!: Db;
  pool!: pg.Pool;
  engine!: FakeEngine;
  egress!: FakeEgress;
  url = '';
  dataDir = '';
  suitesDir = '';
  trialsDir = '';
  /** Every worker started, open or closed, in order. */
  readonly workers: TestingModule[] = [];

  /** The suite the launch helpers name, and the tasks they select. */
  readonly suiteName: string;
  readonly taskKeys: readonly string[];

  /** `name` keeps the database of each spec file apart. */
  constructor(
    private readonly serverUrl: string,
    name: string,
    private readonly options: WorldOptions = {},
  ) {
    this.database = `hermes_evals_${name}_${process.pid}`;
    this.suiteName = options.suite?.name ?? SUITE_NAME;
    this.taskKeys = options.suite?.tasks ?? TASKS;
  }

  async start(): Promise<void> {
    await admin(this.serverUrl, `drop database if exists ${this.database} with (force)`);
    await admin(this.serverUrl, `create database ${this.database}`);
    const parsed = new URL(this.serverUrl);
    parsed.pathname = `/${this.database}`;
    this.url = parsed.toString();
    this.dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-phase2-data-'));
    this.suitesDir = await mkdtemp(join(tmpdir(), 'hermes-evals-phase2-suites-'));
    this.trialsDir = await mkdtemp(join(tmpdir(), 'hermes-evals-phase2-trials-'));
    const suite = join(this.suitesDir, this.suiteName);
    if (this.options.suite) {
      await cp(this.options.suite.dir, suite, { recursive: true });
    } else {
      for (const task of TASKS)
        await cp(join(COMPLETE, task), join(suite, task), { recursive: true });
      await writeFile(
        join(suite, 'suite.yaml'),
        `name: ${SUITE_NAME}\nversion_label: '2.0'\ndescription: Phase 2 e2e.\ntasks: [${TASKS.join(', ')}]\n`,
      );
    }
    await writeFile(join(this.dataDir, 'prices.yaml'), this.options.prices ?? PRICES);
    await this.nous.listen();

    // ConfigModule.forRoot reads the environment when the modules are
    // imported, so it is set first and the modules are imported after.
    Object.assign(process.env, {
      NODE_ENV: 'production',
      // E2E_LOG_LEVEL=info shows the API's and the workers' logs when a test fails.
      LOG_LEVEL: process.env['E2E_LOG_LEVEL'] ?? 'fatal',
      DATABASE_URL: this.url,
      DATA_DIR: this.dataDir,
      SUITES_DIR: this.suitesDir,
      TRIALS_DIR: this.trialsDir,
      TRIAL_IMAGE: IMAGE,
      TRIAL_VOLUME: VOLUME,
      TRIAL_SLOTS: SLOTS.join(','),
      DOCKER_SOCKET: join(this.dataDir, 'no-guard.sock'),
      EGRESS_ADMIN_SOCKET: join(this.dataDir, 'no-egress.sock'),
      PRICES_FILE: join(this.dataDir, 'prices.yaml'),
      NOUS_LOGIN_URL: this.nous.url,
      WORKER_CONCURRENCY: '2',
      MAX_CONSECUTIVE_EXECUTION_ERRORS: '3',
      RECOVERY_INTERVAL_MS: '2000',
      LEASE_SECONDS: '30',
      SUITE_RELOAD_TIMEOUT_S: '60',
    } satisfies Partial<Record<keyof Env, string>>);
    // Only the values given: Node stores an assigned undefined as the text "undefined".
    for (const [key, value] of Object.entries(this.options.env ?? {})) {
      if (value !== undefined) process.env[key] = value;
    }
    process.env['INVOICE_DB_URL'] = DB_SECRET;

    const daemon = fakeDaemon({
      trialsDir: this.trialsDir,
      guard: { trialImage: IMAGE, trialVolume: VOLUME, trialNetworks: SLOTS },
      scripts: this.scripts,
      ...(this.options.script ? { script: this.options.script } : {}),
      ...(this.options.judge ? { judge: this.options.judge } : {}),
    });
    this.engine = daemon.engine;
    this.egress = daemon.egress;

    const { AppModule } = await import('../../src/app.module.js');
    const { configureApi } = await import('../../src/app.setup.js');
    this.api = await NestFactory.create(AppModule, { logger: false });
    configureApi(this.api);
    // Listening, so the SSE client can connect; supertest uses the same server.
    await this.api.listen(0, '127.0.0.1');
    this.pool = new pg.Pool({ connectionString: this.url, max: 4 });
    this.db = drizzle(this.pool, { schema });
  }

  /**
   * A worker process: the real WorkerModule with the fake sandbox, on the
   * same fake daemon as every other worker. `isolated: false` gives one whose
   * isolation self-test failed.
   */
  async startWorker(options: { isolated?: boolean } = {}): Promise<TestingModule> {
    const { WorkerModule } = await import('../../src/worker/worker.module.js');
    const worker = await Test.createTestingModule({ imports: [WorkerModule] })
      .overrideProvider(SandboxService)
      .useValue(
        fakeSandbox(
          {
            engine: this.engine,
            egress: this.egress,
            trialsDir: this.trialsDir,
            image: IMAGE,
            volume: VOLUME,
            slots: SLOTS,
          },
          { isolated: options.isolated ?? true },
        ),
      )
      .compile();
    worker.useLogger(false);
    await worker.init();
    this.workers.push(worker);
    // The start-up suite load runs in the background; the tests launch on its suite.
    const { WorkerService } = await import('../../src/worker/worker.service.js');
    await worker.get(WorkerService).startupLoadSettled();
    return worker;
  }

  async stop(): Promise<void> {
    for (const worker of this.workers) await worker.close().catch(() => {});
    await this.api?.close();
    await this.pool?.end();
    await this.nous.close().catch(() => {});
    await admin(this.serverUrl, `drop database if exists ${this.database} with (force)`);
    for (const dir of [this.dataDir, this.suitesDir, this.trialsDir]) {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }

  private http() {
    return request(this.api.getHttpServer());
  }

  /** A GET whose 200 body must parse with `schema`. */
  async read<T>(path: string, schema: ZodType<T>): Promise<T> {
    const res = await this.http().get(`/api${path}`);
    expect(res.status, `GET ${path}: ${JSON.stringify(res.body)}`).toBe(200);
    return schema.parse(res.body);
  }

  /** A state-changing JSON call as the web sends it; the body must parse with `schema`. */
  async send<T>(
    method: 'post' | 'put' | 'delete',
    path: string,
    body: unknown,
    status: number,
    schema: ZodType<T>,
  ): Promise<T> {
    const res = await this.http()
      [method](`/api${path}`)
      .set('X-Requested-With', 'hermes-evals')
      .send(body as object);
    expect(res.status, `${method.toUpperCase()} ${path}: ${JSON.stringify(res.body)}`).toBe(status);
    return schema.parse(res.body);
  }

  /** A call that must be refused with `status` and the shared error body. */
  refused(method: 'post' | 'put', path: string, body: unknown, status: number) {
    return this.send(method, path, body, status, ApiErrorBodySchema) as Promise<ApiErrorBody>;
  }

  /** A configuration on provider `custom` against the mock model's address. */
  async configuration(
    name: string,
    model: string,
    extra: Partial<ConfigurationInput> = {},
  ): Promise<ConfigRef> {
    const input: ConfigurationInput = {
      name,
      model,
      provider: 'custom',
      baseUrl: MOCK_BASE_URL,
      toolsets: ['file', 'terminal'],
      memoryEnabled: false,
      skillIds: [],
      documentIds: [],
      mcpServerVersionIds: [],
      maxTurns: 20,
      timeBudgetS: 300,
      duplicatedFromVersionId: null,
      ...extra,
    };
    const saved = await this.send(
      'post',
      '/configurations',
      input,
      201,
      ConfigurationSaveResultSchema,
    );
    return { name, configurationId: saved.configurationId, versionId: saved.versionId };
  }

  /**
   * The launch body the New experiment page builds from its options: the
   * suite's current version and the hashes the form opened with.
   */
  async launchBody(
    name: string,
    baseline: ConfigRef,
    candidates: ConfigRef[],
    extra: Partial<LaunchExperimentInput> = {},
  ): Promise<LaunchExperimentInput> {
    const options = await this.read('/experiments/new-options', NewExperimentOptionsSchema);
    const suite = options.suites.find((s) => s.name === this.suiteName)!;
    const hashes = Object.fromEntries(
      [baseline, ...candidates].map((c) => {
        const option = options.configurations.find((o) => o.versionId === c.versionId);
        return [c.versionId, option?.configHash ?? '0'.repeat(64)];
      }),
    );
    return {
      name,
      description: '',
      suiteId: suite.suiteId,
      taskKeys: [...this.taskKeys],
      baselineVersionId: baseline.versionId,
      candidateVersionIds: candidates.map((c) => c.versionId),
      repetitions: 1,
      concurrency: 2,
      spendCeilingUsd: null,
      timeBudgetOverrideS: null,
      expectedConfigHashes: hashes,
      ...extra,
    };
  }

  async launch(
    name: string,
    baseline: ConfigRef,
    candidates: ConfigRef[],
    extra: Partial<LaunchExperimentInput> = {},
  ): Promise<string> {
    const body = await this.launchBody(name, baseline, candidates, extra);
    return (await this.send('post', '/experiments', body, 201, LaunchExperimentResultSchema)).id;
  }

  detail(id: string): Promise<ExperimentDetail> {
    return this.read(`/experiments/${id}`, ExperimentDetailSchema);
  }

  /** The experiment once `done` holds for its detail. */
  until(
    id: string,
    what: string,
    done: (d: ExperimentDetail) => boolean,
    ms = 60_000,
  ): Promise<ExperimentDetail> {
    return waitFor(
      `experiment ${what}`,
      async () => {
        const d = await this.detail(id);
        return done(d) ? d : undefined;
      },
      ms,
    );
  }

  /** The experiment once it is completed. */
  completed(id: string, ms?: number): Promise<ExperimentDetail> {
    return this.until(id, 'completed', (d) => d.status === 'completed', ms);
  }

  runsOf(experimentId: string) {
    return this.db
      .select()
      .from(runs)
      .where(eq(runs.experimentId, experimentId))
      .orderBy(asc(runs.id));
  }

  attemptsOf(experimentId: string) {
    return this.db
      .select({ attempt: attempts, runId: runs.id })
      .from(attempts)
      .innerJoin(runs, eq(runs.id, attempts.runId))
      .where(eq(runs.experimentId, experimentId))
      .orderBy(asc(attempts.id));
  }

  /** Runs of the experiment in `status`, once there are `n` of them. */
  runsIn(experimentId: string, status: string, n: number) {
    return waitFor(`${n} runs ${status}`, async () => {
      const rows = (await this.runsOf(experimentId)).filter((r) => r.status === status);
      return rows.length >= n ? rows : undefined;
    });
  }

  /**
   * Runs of the experiment whose trial container is up, once there are `n`:
   * a run is `running` from its claim, a little before its container exists.
   */
  trialsUp(experimentId: string, n: number) {
    return waitFor(`${n} trial containers up`, async () => {
      const running = (await this.runsOf(experimentId)).filter((r) => r.status === 'running');
      const live = new Set(this.engine.live().map((c) => c.info.labels['hermes-evals.run']));
      const up = running.filter((r) => live.has(r.id));
      return up.length >= n ? up : undefined;
    });
  }
}
