/**
 * The MCP, secrets and counts endpoints over HTTP, as AppModule mounts them
 * under /api: their modules with DatabaseModule, the DB token swapped for
 * PGlite. "Test start" goes through a pg-boss stand-in that runs the real
 * worker handler inline with a fake sandbox, so the whole path from request
 * to recorded result is exercised. Every body is checked against the shared
 * contract.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import {
  McpServerRowSchema,
  McpTestViewSchema,
  ResourceCountsSchema,
  SecretRowSchema,
} from '@hermes-evals/shared';
import { PinoLogger } from 'nestjs-pino';
import type { PgBoss } from 'pg-boss';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { DatabaseModule } from '../../database/database.module.js';
import { DB } from '../../database/db.provider.js';
import { mcpServerVersions } from '../../database/schema/index.js';
import { QueueModule } from '../../queue/queue.module.js';
import { QueueService } from '../../queue/queue.service.js';
import type { TestMcpServerJob } from '../../queue/queues.js';
import { handleTestMcpServerJob } from '../../worker/handlers/test-mcp-server.js';
import type { StdioTestRun } from '../../worker/handlers/mcp-test-container.js';
import { CountsModule } from '../counts/counts.module.js';
import { SecretsModule } from '../secrets/secrets.module.js';
import { McpModule } from './mcp.module.js';
import {
  INVOICE_DB,
  insertWorker,
  useInConfiguration,
  VENDOR_API,
} from './mcp-testing.support-spec.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const logger = {
  setContext: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

/** What AppModule's ConfigModule and LoggerModule provide. */
@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: {
        get: (key: string) => (key === 'MCP_TEST_TIMEOUT_S' ? config.mcpTestTimeoutS : undefined),
      },
    },
    { provide: PinoLogger, useValue: logger },
  ],
  exports: [ConfigService, PinoLogger],
})
class InfraModule {}

/** MCP_TEST_TIMEOUT_S as the stand-in ConfigService reads it; each test may change it. */
const config = { mcpTestTimeoutS: 5 };

const PASSED_RUN: StdioTestRun = {
  exitCode: 0,
  stopReason: 'exited',
  durationMs: 2000,
  stdout: readFileSync(
    join(
      import.meta.dirname,
      '../../worker/handlers/__fixtures__/hermes-mcp-test/invoice-db-passed.stdout.txt',
    ),
    'utf8',
  ),
  stderr: '',
  serverLog: '',
};

/** A passed last_test record, as a worker writes it. */
const PASSED_RECORD = {
  status: 'passed' as const,
  job_id: 'old-job',
  requested_at: '2026-10-23T09:00:00.000Z',
  finished_at: '2026-10-23T09:00:02.000Z',
  started_ms: 900,
  tools: [{ name: 'list_invoices', description: 'List invoices' }],
};

interface StoredJob {
  id: string;
  name: string;
  data: TestMcpServerJob;
  singletonKey: string;
  state: 'active' | 'completed' | 'failed';
  output: unknown;
}

/**
 * How the stand-in worker treats a job: run the handler, hold the job active
 * (a test that outlasts the wait), hold it after recording a passed result
 * with its id (the worker wrote it, the job has not completed yet), or crash
 * after recording `running`.
 */
type WorkerMode = 'run' | 'hold' | 'hold-recorded' | 'crash';

/**
 * The pg-boss calls sendAndWait makes, with the worker in the same process:
 * `send` runs the handler to the end before it returns the job id. As under
 * the exclusive policy, a send whose key an active job holds is refused (null).
 */
function inlineBoss(t: TestDatabase, env: NodeJS.ProcessEnv, mode: () => WorkerMode) {
  const jobs: StoredJob[] = [];
  const boss = {
    send: async (name: string, data: TestMcpServerJob, options: { singletonKey: string }) => {
      const held = (j: StoredJob) =>
        j.name === name && j.singletonKey === options.singletonKey && j.state === 'active';
      if (jobs.some(held)) return null;
      const job: StoredJob = {
        id: randomUUID(),
        name,
        data,
        singletonKey: options.singletonKey,
        state: 'active',
        output: null,
      };
      jobs.push(job);
      if (mode() === 'hold') return job.id;
      if (mode() === 'hold-recorded') {
        if (data.kind === 'saved') {
          await t.db
            .update(mcpServerVersions)
            .set({ lastTest: { ...PASSED_RECORD, job_id: job.id } })
            .where(eq(mcpServerVersions.id, data.mcpServerVersionId));
        }
        return job.id;
      }
      if (mode() === 'crash') {
        if (data.kind === 'saved') {
          await t.db
            .update(mcpServerVersions)
            .set({
              lastTest: {
                status: 'running',
                job_id: job.id,
                requested_at: new Date().toISOString(),
              },
            })
            .where(eq(mcpServerVersions.id, data.mcpServerVersionId));
        }
        job.state = 'failed';
        job.output = { name: 'Error', message: 'worker lost its database connection' };
        return job.id;
      }
      job.output = await handleTestMcpServerJob(
        { id: job.id, data, createdOn: new Date() },
        {
          db: t.db,
          env,
          sandbox: {
            isolated: () => true,
            runStdioTest: async () => PASSED_RUN,
            runHttpTest: async () => PASSED_RUN,
          },
        },
        logger as unknown as PinoLogger,
      );
      job.state = 'completed';
      return job.id;
    },
    findJobs: async (name: string, query: { id?: string; key?: string }) =>
      jobs.filter(
        (j) => j.name === name && (query.id ? j.id === query.id : j.singletonKey === query.key),
      ),
  };
  return { boss: boss as unknown as PgBoss, jobs };
}

describe('Resources endpoints: MCP servers, secrets, counts', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let jobs: StoredJob[];
  let queueState: 'ok' | 'unavailable';
  let mode: WorkerMode;

  beforeEach(async () => {
    t = await createTestDatabase();
    const inline = inlineBoss(t, { INVOICE_DB_URL: 'file:///data/invoices.csv' }, () => mode);
    jobs = inline.jobs;
    queueState = 'ok';
    mode = 'run';
    config.mcpTestTimeoutS = 5;
    const moduleRef = await Test.createTestingModule({
      imports: [InfraModule, DatabaseModule, QueueModule, McpModule, SecretsModule, CountsModule],
    })
      .overrideProvider(DB)
      .useValue(t.db)
      .overrideProvider(QueueService)
      .useValue({ ping: async () => queueState, instance: inline.boss })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    await t.close();
  });

  const http = () => request(app.getHttpServer());

  describe('/api/resources/mcp-servers', () => {
    it('creates, lists and edits a server', async () => {
      const created = McpServerRowSchema.parse(
        (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201)).body,
      );
      expect(created).toMatchObject({
        name: 'invoice-db',
        version: 1,
        lastTest: { status: 'untested' },
      });

      const list = McpServerRowSchema.array().parse(
        (await http().get('/api/resources/mcp-servers').expect(200)).body,
      );
      expect(list).toEqual([created]);

      // The form may send a whole row back: the extra fields are dropped.
      const edited = McpServerRowSchema.parse(
        (
          await http()
            .put(`/api/resources/mcp-servers/${created.id}`)
            .send({ ...created, timeoutS: 45 })
            .expect(200)
        ).body,
      );
      expect(edited).toMatchObject({ versionId: created.versionId, timeoutS: 45 });
    });

    it('turns a frozen definition into version 2', async () => {
      const created = (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201))
        .body as { id: string; versionId: string };
      await useInConfiguration(t.db, 'baseline', [created.versionId]);
      const res = await http()
        .put(`/api/resources/mcp-servers/${created.id}`)
        .send({ ...INVOICE_DB, exclude: [] })
        .expect(200);
      expect(McpServerRowSchema.parse(res.body)).toMatchObject({
        version: 2,
        frozen: false,
        usedBy: [{ name: 'baseline' }],
      });
    });

    it('answers invalid input with 400 and its issues, a taken name with 409, an unknown id with 404', async () => {
      const invalid = await http()
        .post('/api/resources/mcp-servers')
        .send({ ...INVOICE_DB, command: null, envNames: ['lower'] })
        .expect(400);
      expect(invalid.body).toMatchObject({
        statusCode: 400,
        message: 'Validation failed',
        issues: expect.arrayContaining([expect.objectContaining({ path: 'command' })]),
      });

      await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201);
      expect(
        (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(409)).body,
      ).toEqual({
        statusCode: 409,
        message: 'an MCP server named invoice-db already exists',
      });
      expect(
        (await http().put('/api/resources/mcp-servers/mcp_missing').send(INVOICE_DB).expect(404))
          .body,
      ).toEqual({
        statusCode: 404,
        message: 'no MCP server mcp_missing',
      });
    });

    it('refuses provider keys and platform variables as env names or header variables', async () => {
      const stdio = await http()
        .post('/api/resources/mcp-servers')
        .send({ ...INVOICE_DB, command: 'sh', envNames: ['OPENROUTER_API_KEY', 'DATABASE_URL'] })
        .expect(400);
      expect(stdio.body.issues).toEqual([
        {
          path: 'envNames',
          message:
            'OPENROUTER_API_KEY and DATABASE_URL are platform variables or credentials; they never enter a trial',
        },
      ]);
      const header = await http()
        .post('/api/resources/mcp-servers')
        .send({ ...VENDOR_API, headers: [{ header: 'Authorization', env: 'ANTHROPIC_API_KEY' }] })
        .expect(400);
      expect(header.body.issues).toEqual([
        expect.objectContaining({
          path: 'headers',
          message: expect.stringMatching(/^ANTHROPIC_API_KEY is/),
        }),
      ]);
      expect((await http().get('/api/resources/mcp-servers').expect(200)).body).toEqual([]);
    });

    it('refuses one name as both a stdio env name and an http header variable, either way round', async () => {
      await http().post('/api/resources/mcp-servers').send(VENDOR_API).expect(201);
      const stdio = await http()
        .post('/api/resources/mcp-servers')
        .send({ ...INVOICE_DB, envNames: ['VENDOR_API_TOKEN'] })
        .expect(400);
      expect(stdio.body).toEqual({
        statusCode: 400,
        message:
          'VENDOR_API_TOKEN is the header variable of http server vendor-api; egress holds its value and it never enters a trial',
        issues: [
          {
            path: 'envNames',
            message:
              'VENDOR_API_TOKEN is the header variable of http server vendor-api; egress holds its value and it never enters a trial',
          },
        ],
      });

      const created = (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201))
        .body as { id: string };
      const reverse = await http()
        .post('/api/resources/mcp-servers')
        .send({
          ...VENDOR_API,
          name: 'ledger-api',
          headers: [{ header: 'Authorization', env: 'INVOICE_DB_URL' }],
        })
        .expect(400);
      expect(reverse.body.issues).toEqual([
        {
          path: 'headers',
          message:
            'INVOICE_DB_URL is an env name of stdio server invoice-db, which sets its value in the trial; a header variable must be one no stdio server uses',
        },
      ]);
      // An in-place edit of the server itself is not a conflict with its own old definition.
      await http()
        .put(`/api/resources/mcp-servers/${created.id}`)
        .send({ ...INVOICE_DB, envNames: ['INVOICE_DB_URL', 'INVOICE_DB_REGION'] })
        .expect(200);
    });

    it('refuses a rename once a configuration has used the server, with 400', async () => {
      const created = (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201))
        .body as { id: string; versionId: string };
      await useInConfiguration(t.db, 'baseline', [created.versionId]);
      const res = await http()
        .put(`/api/resources/mcp-servers/${created.id}`)
        .send({ ...INVOICE_DB, name: 'invoices' })
        .expect(400);
      expect(res.body).toMatchObject({ statusCode: 400, issues: [{ path: 'name' }] });
    });
  });

  describe('Test start', () => {
    it('answers 503 with no live worker, and with no queue', async () => {
      const created = (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201))
        .body as { id: string };
      expect(
        (await http().post(`/api/resources/mcp-servers/${created.id}/test`).expect(503)).body,
      ).toEqual({
        statusCode: 503,
        message: 'no worker is connected; start the worker to test MCP servers',
      });
      queueState = 'unavailable';
      await insertWorker(t.db);
      await http().post('/api/resources/mcp-servers/test').send(INVOICE_DB).expect(503);
      expect(jobs).toEqual([]);
    });

    it('tests a saved server through the worker and records the result on its version', async () => {
      await insertWorker(t.db, { env: ['INVOICE_DB_URL'] });
      const created = (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201))
        .body as { id: string; versionId: string };
      const res = await http().post(`/api/resources/mcp-servers/${created.id}/test`).expect(200);
      const view = McpTestViewSchema.parse(res.body);
      expect(view).toMatchObject({ status: 'passed', startedMs: 1171 });
      const [stored] = await t.db
        .select({ hash: mcpServerVersions.definitionHash })
        .from(mcpServerVersions)
        .where(eq(mcpServerVersions.id, created.versionId));
      expect(jobs).toMatchObject([
        {
          data: {
            kind: 'saved',
            mcpServerVersionId: created.versionId,
            definitionHash: stored!.hash,
          },
          singletonKey: `${created.versionId}:${stored!.hash}`,
        },
      ]);

      const [row] = McpServerRowSchema.array().parse(
        (await http().get('/api/resources/mcp-servers').expect(200)).body,
      );
      expect(row!.lastTest).toEqual(view);
    });

    it('tests what the form holds without storing anything', async () => {
      await insertWorker(t.db);
      const res = await http().post('/api/resources/mcp-servers/test').send(VENDOR_API).expect(200);
      expect(McpTestViewSchema.parse(res.body)).toMatchObject({
        status: 'failed',
        error: 'VENDOR_API_TOKEN is not set in the egress environment.',
        missingSecretNames: ['VENDOR_API_TOKEN'],
      });
      expect(jobs[0]!.singletonKey).toMatch(/^unsaved:[0-9a-f]{64}$/);
      expect((await http().get('/api/resources/mcp-servers').expect(200)).body).toEqual([]);
    });

    it('names the hash of the definition it tested, the one a save of the form stores', async () => {
      await insertWorker(t.db, { env: ['INVOICE_DB_URL'] });
      const tested = McpTestViewSchema.parse(
        (await http().post('/api/resources/mcp-servers/test').send(INVOICE_DB).expect(200)).body,
      );
      expect(tested).toMatchObject({ status: 'passed', definitionHash: expect.any(String) });
      const created = McpServerRowSchema.parse(
        (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201)).body,
      );
      const [stored] = await t.db
        .select({ hash: mcpServerVersions.definitionHash })
        .from(mcpServerVersions)
        .where(eq(mcpServerVersions.id, created.versionId));
      expect(tested.status === 'passed' && tested.definitionHash).toBe(stored!.hash);
      // Saved right after a passing test, the row keeps that result (Phase 5 question 14).
      const { definitionHash: _hash, ...result } = tested as Extract<
        typeof tested,
        { status: 'passed' }
      >;
      expect(created.lastTest).toEqual(result);
      const [listed] = McpServerRowSchema.array().parse(
        (await http().get('/api/resources/mcp-servers').expect(200)).body,
      );
      expect(listed!.lastTest).toEqual(result);
    });

    it('keeps an unsaved test only for a save of that same definition', async () => {
      await insertWorker(t.db, { env: ['INVOICE_DB_URL'] });
      await http().post('/api/resources/mcp-servers/test').send(INVOICE_DB).expect(200);
      // Another definition (the timeout differs) is untested.
      const other = McpServerRowSchema.parse(
        (
          await http()
            .post('/api/resources/mcp-servers')
            .send({ ...INVOICE_DB, timeoutS: 45 })
            .expect(201)
        ).body,
      );
      expect(other.lastTest).toEqual({ status: 'untested' });
      // An in-place edit to the tested definition takes the result.
      const edited = McpServerRowSchema.parse(
        (await http().put(`/api/resources/mcp-servers/${other.id}`).send(INVOICE_DB).expect(200))
          .body,
      );
      expect(edited).toMatchObject({ version: 1, lastTest: { status: 'passed' } });
      // So does the next version of a frozen one, once its form has passed.
      await useInConfiguration(t.db, 'baseline', [edited.versionId]);
      const next = { ...INVOICE_DB, exclude: [] };
      const untestedNext = McpServerRowSchema.parse(
        (
          await http()
            .put(`/api/resources/mcp-servers/${other.id}`)
            .send({ ...next, timeoutS: 50 })
            .expect(200)
        ).body,
      );
      expect(untestedNext).toMatchObject({ version: 2, lastTest: { status: 'untested' } });
      await http().post('/api/resources/mcp-servers/test').send(next).expect(200);
      const kept = McpServerRowSchema.parse(
        (await http().put(`/api/resources/mcp-servers/${other.id}`).send(next).expect(200)).body,
      );
      expect(kept).toMatchObject({ version: 2, lastTest: { status: 'passed' } });
    });

    it('never keeps a failed unsaved test', async () => {
      await insertWorker(t.db);
      await http().post('/api/resources/mcp-servers/test').send(VENDOR_API).expect(200);
      const created = McpServerRowSchema.parse(
        (await http().post('/api/resources/mcp-servers').send(VENDOR_API).expect(201)).body,
      );
      expect(created.lastTest).toEqual({ status: 'untested' });
    });

    it('answers running when the test outlasts the wait; the job goes on', async () => {
      await insertWorker(t.db);
      config.mcpTestTimeoutS = 1;
      mode = 'hold';
      const created = (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201))
        .body as { id: string };
      const res = await http().post(`/api/resources/mcp-servers/${created.id}/test`).expect(200);
      expect(McpTestViewSchema.parse(res.body)).toEqual({
        status: 'running',
        requestedAt: expect.any(String),
      });
      expect(jobs).toMatchObject([{ state: 'active' }]);
    });

    it('on a timeout, never answers with an earlier test of the version', async () => {
      await insertWorker(t.db, { env: ['INVOICE_DB_URL'] });
      const created = (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201))
        .body as { id: string; versionId: string };
      // Yesterday's pass, by another job.
      await t.db
        .update(mcpServerVersions)
        .set({ lastTest: PASSED_RECORD })
        .where(eq(mcpServerVersions.id, created.versionId));
      config.mcpTestTimeoutS = 1;
      mode = 'hold';
      const res = await http().post(`/api/resources/mcp-servers/${created.id}/test`).expect(200);
      expect(McpTestViewSchema.parse(res.body)).toEqual({
        status: 'running',
        requestedAt: expect.any(String),
      });
    });

    it('on a timeout, answers with what this request’s own job recorded', async () => {
      await insertWorker(t.db, { env: ['INVOICE_DB_URL'] });
      const created = (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201))
        .body as { id: string };
      config.mcpTestTimeoutS = 1;
      mode = 'hold-recorded';
      const res = await http().post(`/api/resources/mcp-servers/${created.id}/test`).expect(200);
      expect(McpTestViewSchema.parse(res.body)).toMatchObject({
        status: 'passed',
        startedMs: 900,
      });
    });

    it('tests an in-place edit as its own job, while a test of the old definition is still running', async () => {
      await insertWorker(t.db, { env: ['INVOICE_DB_URL'] });
      const created = (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201))
        .body as { id: string; versionId: string };
      config.mcpTestTimeoutS = 1;
      mode = 'hold';
      await http().post(`/api/resources/mcp-servers/${created.id}/test`).expect(200);
      // The user fixes the definition in place (no configuration uses it) and tests again.
      await http()
        .put(`/api/resources/mcp-servers/${created.id}`)
        .send({ ...INVOICE_DB, exclude: [] })
        .expect(200);
      mode = 'run';
      const res = await http().post(`/api/resources/mcp-servers/${created.id}/test`).expect(200);
      const view = McpTestViewSchema.parse(res.body);
      // The new definition excludes nothing: delete_invoice is offered now.
      expect(view).toMatchObject({
        status: 'passed',
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'delete_invoice', included: true }),
        ]),
      });
      expect(jobs).toHaveLength(2);
      expect(jobs[1]!.singletonKey).not.toBe(jobs[0]!.singletonKey);
      expect(jobs.map((j) => j.state)).toEqual(['active', 'completed']);
      const [row] = McpServerRowSchema.array().parse(
        (await http().get('/api/resources/mcp-servers').expect(200)).body,
      );
      expect(row!.lastTest).toEqual(view);
    });

    it('marks the version failed when the job itself failed', async () => {
      await insertWorker(t.db);
      mode = 'crash';
      const created = (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201))
        .body as { id: string; versionId: string };
      const res = await http().post(`/api/resources/mcp-servers/${created.id}/test`).expect(200);
      expect(McpTestViewSchema.parse(res.body)).toMatchObject({
        status: 'failed',
        error: 'The test job failed: worker lost its database connection',
      });
      const [row] = (await http().get('/api/resources/mcp-servers').expect(200)).body as Array<{
        lastTest: unknown;
      }>;
      expect(row!.lastTest).toMatchObject({
        status: 'failed',
        error: 'The test job failed: worker lost its database connection',
      });
    });

    it('answers 404 for an unknown server', async () => {
      await insertWorker(t.db);
      await http().post('/api/resources/mcp-servers/mcp_missing/test').expect(404);
    });
  });

  describe('/api/resources/secrets and /api/resources/counts', () => {
    it('lists each referenced name with whether its service has it', async () => {
      await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201);
      await http().post('/api/resources/mcp-servers').send(VENDOR_API).expect(201);

      const before = SecretRowSchema.array().parse(
        (await http().get('/api/resources/secrets').expect(200)).body,
      );
      expect(before.map((r) => [r.name, r.source, r.set, r.checkedWhen])).toEqual([
        ['INVOICE_DB_URL', 'worker', false, 'no worker is connected'],
        ['VENDOR_API_TOKEN', 'egress', false, 'no worker is connected'],
      ]);

      await insertWorker(t.db, { env: ['INVOICE_DB_URL'], egress: ['VENDOR_API_TOKEN'] });
      const after = SecretRowSchema.array().parse(
        (await http().get('/api/resources/secrets').query({ refresh: 1 }).expect(200)).body,
      );
      expect(after.map((r) => [r.name, r.exposure, r.set, r.checkedWhen])).toEqual([
        ['INVOICE_DB_URL', 'readable_by_agent', true, 'at worker start'],
        ['VENDOR_API_TOKEN', 'egress_only', true, 'at worker start'],
      ]);
      expect(after[1]!.referencedBy).toEqual([
        expect.objectContaining({ name: 'vendor-api', via: 'header', header: 'Authorization' }),
      ]);
    });

    it('counts what each tab lists', async () => {
      expect(
        ResourceCountsSchema.parse((await http().get('/api/resources/counts').expect(200)).body),
      ).toEqual({
        skills: 0,
        documents: 0,
        mcpServers: 0,
        secrets: 0,
      });
      await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201);
      await http().post('/api/resources/mcp-servers').send(VENDOR_API).expect(201);
      expect((await http().get('/api/resources/counts').expect(200)).body).toEqual({
        skills: 0,
        documents: 0,
        mcpServers: 2,
        secrets: 2,
      });
    });

    it('keeps the names of a version a configuration still pins after the server moves on', async () => {
      const created = (await http().post('/api/resources/mcp-servers').send(INVOICE_DB).expect(201))
        .body as { id: string; versionId: string };
      await useInConfiguration(t.db, 'with-mcp', [created.versionId]);
      // v1 is frozen, so the edit creates v2; with-mcp stays on v1 and its next run needs v1's name.
      const v2 = McpServerRowSchema.parse(
        (
          await http()
            .put(`/api/resources/mcp-servers/${created.id}`)
            .send({ ...INVOICE_DB, envNames: ['INVOICE_DB_PATH'] })
            .expect(200)
        ).body,
      );
      expect(v2.version).toBe(2);
      const secrets = SecretRowSchema.array().parse(
        (await http().get('/api/resources/secrets').expect(200)).body,
      );
      expect(secrets.map((r) => [r.name, r.referencedBy.map((ref) => ref.name)])).toEqual([
        ['INVOICE_DB_PATH', ['invoice-db']],
        ['INVOICE_DB_URL', ['invoice-db']],
      ]);
      expect((await http().get('/api/resources/counts').expect(200)).body).toMatchObject({
        mcpServers: 1,
        secrets: 2,
      });
    });
  });
});
