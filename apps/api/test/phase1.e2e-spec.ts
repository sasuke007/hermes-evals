/**
 * Phase 1 end to end: the real AppModule and WorkerModule, booted the way
 * main.ts and worker.ts boot them, on a fresh Postgres 17 database, talking
 * through pg-boss in one process. The worker loads suites from a temporary
 * SUITES_DIR; both share a temporary DATA_DIR, as the evaldata volume. Every
 * response is parsed with its shared zod schema.
 *
 * The worker's sandbox is unavailable here (no docker-guard socket), which is
 * itself part of the contract: suites still load and an MCP test answers
 * "failed" with the reason.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z, type ZodType } from 'zod';
import {
  ApiErrorBodySchema,
  ConfigDiffSchema,
  ConfigurationDetailSchema,
  ConfigurationDraftSchema,
  ConfigurationFormOptionsSchema,
  ConfigurationListRowSchema,
  ConfigurationSaveResultSchema,
  DocumentRowSchema,
  HERMES_REVISION,
  HERMES_TOOLSETS,
  McpServerRowSchema,
  McpTestViewSchema,
  ResourceCountsSchema,
  SandboxStatusSchema,
  SecretRowSchema,
  SkillDetailSchema,
  SkillFileContentSchema,
  SkillRowSchema,
  SkillUploadValidationSchema,
  SuiteDetailSchema,
  SuiteHistoryEntrySchema,
  SuiteListRowSchema,
  SuiteReloadResultSchema,
  SystemSummarySchema,
  TablePreviewSchema,
  TaskDetailSchema,
  TaskDiffSchema,
  TaskVersionEntrySchema,
  WorkerSchema,
  type ConfigurationInput,
  type SuiteReloadEntry,
} from '@hermes-evals/shared';
import type { Env } from '../src/config/env.js';
import * as schema from '../src/database/schema/index.js';
import { INVOICE_DB, VENDOR_API } from '../src/resources/mcp/mcp-testing.support-spec.js';
import { binaryBody, invoiceMethodZip } from '../src/resources/skills/testing.helper-spec.js';
import { workerSandboxReport } from '../src/worker/presence/presence-report.js';
import type { WorkerService } from '../src/worker/worker.service.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const FIXTURE_SUITE = join(import.meta.dirname, 'fixtures', 'suites', 'complete');

describe.skipIf(!SERVER_URL)('Phase 1 on Postgres 17: API and worker', () => {
  const database = `hermes_evals_phase1_e2e_${process.pid}`;
  let url: string;
  let dataDir: string;
  let suitesDir: string;
  let pool: pg.Pool;
  let db: NodePgDatabase<typeof schema>;
  let api: NestExpressApplication;
  let worker: INestApplicationContext;

  const admin = async (statement: string) => {
    const client = new pg.Client({ connectionString: SERVER_URL });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };

  /** A GET whose 200 body must parse with `schema`. */
  async function read<T>(path: string, schema: ZodType<T>): Promise<T> {
    const res = await request(api.getHttpServer()).get(`/api${path}`);
    expect(res.status, `GET ${path}: ${JSON.stringify(res.body)}`).toBe(200);
    return schema.parse(res.body);
  }

  /** A state-changing JSON call as the web's liveSend sends it; the body must parse with `schema`. */
  async function send<T>(
    method: 'post' | 'put',
    path: string,
    body: unknown,
    status: number,
    schema: ZodType<T>,
  ): Promise<T> {
    const res = await request(api.getHttpServer())
      [method](`/api${path}`)
      .set('X-Requested-With', 'hermes-evals')
      .send(body as object);
    expect(res.status, `${method.toUpperCase()} ${path}: ${JSON.stringify(res.body)}`).toBe(status);
    return schema.parse(res.body);
  }

  const reload = async (path?: string): Promise<SuiteReloadEntry[]> =>
    (await send('post', '/suites/reload', path ? { path } : {}, 200, SuiteReloadResultSchema))
      .suites;

  beforeAll(async () => {
    await admin(`drop database if exists ${database} with (force)`);
    await admin(`create database ${database}`);
    const parsed = new URL(SERVER_URL!);
    parsed.pathname = `/${database}`;
    url = parsed.toString();
    dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-phase1-data-'));
    suitesDir = await mkdtemp(join(tmpdir(), 'hermes-evals-phase1-suites-'));

    // ConfigModule.forRoot reads the environment when the modules are
    // imported, so it is set first and the modules are imported after.
    // Values set here win over the repository's .env, which is also read.
    Object.assign(process.env, {
      NODE_ENV: 'production',
      LOG_LEVEL: 'fatal',
      DATABASE_URL: url,
      DATA_DIR: dataDir,
      SUITES_DIR: suitesDir,
      DOCKER_SOCKET: join(dataDir, 'no-guard.sock'),
      EGRESS_ADMIN_SOCKET: join(dataDir, 'no-egress.sock'),
      PRICES_FILE: join(dataDir, 'no-prices.yaml'),
      WORKER_CONCURRENCY: '2',
      SUITE_RELOAD_TIMEOUT_S: '60',
      MCP_TEST_TIMEOUT_S: '30',
      // The samples seed (Phase 8) would add skills, documents, MCP servers and
      // configurations this spec counts; phase8.e2e-spec.ts covers it.
      SEED_SAMPLES: 'false',
    } satisfies Partial<Record<keyof Env, string>>);
    // The MCP test below proves a missing value is reported by name.
    delete process.env['INVOICE_DB_URL'];

    const { AppModule } = await import('../src/app.module.js');
    const { configureApi } = await import('../src/app.setup.js');
    const { WorkerModule } = await import('../src/worker/worker.module.js');
    const { WorkerService } = await import('../src/worker/worker.service.js');
    const { useVerifierRunner } = await import('../src/scoring/verifier-runner.js');

    // Compose order: the API (which migrates) first, then the worker.
    api = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    configureApi(api);
    await api.init();
    // Never the Compose database: the guard against a .env winning.
    expect(api.get(ConfigService<Env, true>).get('DATABASE_URL', { infer: true })).toBe(url);

    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: false });
    // No docker-guard here: verifiers run as subprocesses, which only tests may choose (R7).
    useVerifierRunner(null);
    await worker.init();
    // The start-up load ran on an empty SUITES_DIR; the suite is added after it.
    expect(await worker.get<WorkerService>(WorkerService).startupLoadSettled()).toEqual({
      at: expect.any(String),
      suites: [],
    });

    pool = new pg.Pool({ connectionString: url, max: 3 });
    db = drizzle(pool, { schema });
  }, 120_000);

  afterAll(async () => {
    await worker?.close();
    await api?.close();
    await pool?.end();
    await admin(`drop database if exists ${database} with (force)`);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    if (suitesDir) await rm(suitesDir, { recursive: true, force: true });
  }, 60_000);

  it('registered the worker: its own row, sandbox unavailable', async () => {
    const workers = await read('/system/workers', z.array(WorkerSchema));
    expect(workers).toEqual([
      // Concurrency 2, and the four slot networks of the default TRIAL_SLOTS.
      expect.objectContaining({
        status: 'online',
        concurrency: 2,
        slotsTotal: 4,
        slotsInUse: 0,
        sandboxProven: false,
      }),
    ]);
  });

  it('answers only the names it is reached by, and writes only from allowed origins', async () => {
    const http = () => request(api.getHttpServer());
    // DNS rebinding: the attacker's page, same-origin on its own name.
    for (const call of [
      () => http().get('/api/suites').set('Host', 'rebind.attacker.example:8080'),
      () => http().get('/api/docs').set('Host', 'rebind.attacker.example'),
      () =>
        http()
          .post('/api/suites/reload')
          .set('Host', 'rebind.attacker.example:8080')
          .set('X-Requested-With', 'x')
          .send({}),
    ]) {
      expect((await call().expect(403)).body).toEqual({
        statusCode: 403,
        message: 'host not allowed',
      });
    }
    const foreign = await http()
      .post('/api/configurations')
      .set('X-Requested-With', 'x')
      .set('Origin', 'http://rebind.attacker.example:8080')
      .send({})
      .expect(403);
    expect(foreign.body).toEqual({ statusCode: 403, message: 'origin not allowed' });
    for (const host of ['localhost:8080', '127.0.0.1:8080', 'api:3000']) {
      await http().get('/api/health').set('Host', host).expect(200);
    }
    // nginx, and the Vite proxy (which keeps the page's Origin), reach the validation.
    for (const origin of ['http://localhost:8080', 'http://localhost:5173']) {
      await http()
        .post('/api/configurations')
        .set('X-Requested-With', 'x')
        .set('Origin', origin)
        .send({})
        .expect(400);
    }
  });

  it('refuses state-changing calls without X-Requested-With, before any work', async () => {
    const http = request(api.getHttpServer());
    const refused = await http.post('/api/suites/reload').send({}).expect(403);
    expect(ApiErrorBodySchema.parse(refused.body)).toEqual({
      statusCode: 403,
      message: 'missing X-Requested-With header',
    });
    await http
      .post('/api/resources/documents')
      .attach('file', Buffer.from('# Notes\n'), 'notes.md')
      .expect(403);
    await http
      .post('/api/configurations')
      .set('X-Requested-With', 'x')
      .set('content-type', 'text/plain')
      .send('{}')
      .expect(403);
    expect(await read('/resources/documents', z.array(DocumentRowSchema))).toEqual([]);
  });

  describe('suites, loaded by the worker', () => {
    let v1: string;
    let v2: string;
    const prompt = () => join(suitesDir, 'complete', 'numeric', 'prompt.md');
    let originalPrompt: string;

    it('reload → list → detail → task', async () => {
      await cp(FIXTURE_SUITE, join(suitesDir, 'complete'), { recursive: true });
      originalPrompt = await readFile(prompt(), 'utf8');

      const [entry] = await reload();
      expect(entry).toMatchObject({
        sourcePath: './suites/complete',
        name: 'complete',
        outcome: 'created',
        versionNumber: 1,
        error: null,
      });
      expect(entry!.changes.added).toHaveLength(5);
      v1 = entry!.suiteId!;

      const list = await read('/suites', z.array(SuiteListRowSchema));
      expect(list).toEqual([
        expect.objectContaining({ suiteId: v1, name: 'complete', taskCount: 5, validCount: 5 }),
      ]);
      // The page matches reload entries to list rows by path.
      expect(entry!.sourcePath).toBe(list[0]!.path);

      const detail = await read(`/suites/${v1}`, SuiteDetailSchema);
      expect(detail.tasks.map((t) => [t.key, t.valid])).toEqual([
        ['numeric', true],
        ['json_unordered', true],
        ['exact', true],
        ['summary_file', true],
        ['answer_verifier', true],
      ]);

      const task = await read(`/suites/${v1}/tasks/numeric`, TaskDetailSchema);
      expect(task).toMatchObject({ key: 'numeric', version: 1, valid: true });

      const download = await request(api.getHttpServer())
        .get(`/api/suites/${v1}/tasks/numeric/fixtures/amounts.csv`)
        .buffer(true)
        .parse(binaryBody)
        .expect(200);
      expect(download.headers['content-disposition']).toMatch(/^attachment/);
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect((download.body as Buffer).toString('utf8')).toBe(
        await readFile(join(FIXTURE_SUITE, 'numeric', 'fixtures', 'amounts.csv'), 'utf8'),
      );
      const preview = await read(
        `/suites/${v1}/tasks/numeric/fixtures/amounts.csv/preview`,
        TablePreviewSchema,
      );
      expect(preview.columns.length).toBeGreaterThan(0);
    }, 120_000);

    it('edit a file → reload → v2 → history → diff', async () => {
      await writeFile(prompt(), `${originalPrompt}\nRound to the cent.\n`);
      const [entry] = await reload('./suites/complete');
      expect(entry).toMatchObject({ outcome: 'created', versionNumber: 2 });
      expect(entry!.changes.changed).toEqual(['numeric']);
      v2 = entry!.suiteId!;

      const history = await read(`/suites/${v2}/history`, z.array(SuiteHistoryEntrySchema));
      expect(history.map((h) => [h.versionNumber, h.outcome, h.current])).toEqual([
        [2, 'created', true],
        [1, 'created', false],
      ]);

      const versions = await read(
        `/suites/${v2}/tasks/numeric/history`,
        z.array(TaskVersionEntrySchema),
      );
      expect(versions.length).toBe(2);
      // An unchanged task keeps its version and its introducing suite.
      expect(await read(`/suites/${v2}/tasks/exact`, TaskDetailSchema)).toMatchObject({
        version: 1,
      });

      const diff = await read(`/suites/${v2}/tasks/numeric/diff?against=${v1}`, TaskDiffSchema);
      expect(diff.from).toMatchObject({ suiteId: v1, suiteVersion: 1, taskVersion: 1 });
      expect(diff.to).toMatchObject({ suiteId: v2, suiteVersion: 2, taskVersion: 2 });
      expect(diff.prompt).toContainEqual(
        expect.objectContaining({ kind: 'added', text: 'Round to the cent.' }),
      );
      // Root files are recorded (task_root_files), so the diff lists the edited prompt.
      expect(diff.files.filter((f) => f.change !== 'unchanged')).toEqual([
        expect.objectContaining({ path: 'prompt.md', change: 'changed' }),
      ]);
    }, 120_000);

    it('revert → reverted', async () => {
      await writeFile(prompt(), originalPrompt);
      const [entry] = await reload('complete');
      expect(entry).toMatchObject({ outcome: 'reverted', suiteId: v1, versionNumber: 1 });
      expect(entry!.message).toBe('Reverted to v1');

      const detail = await read(`/suites/${v1}`, SuiteDetailSchema);
      expect(detail.current).toBe(true);
      expect(detail.versions[0]).toMatchObject({ suiteId: v1, current: true, reverted: true });
      const history = await read(`/suites/${v1}/history`, z.array(SuiteHistoryEntrySchema));
      expect(history[0]).toMatchObject({ outcome: 'reverted', versionNumber: 1, current: true });
      expect(await read('/suites', z.array(SuiteListRowSchema))).toEqual([
        expect.objectContaining({ suiteId: v1, versionNumber: 1 }),
      ]);
    }, 120_000);
  });

  describe('resources and configurations', () => {
    let skillId: string;
    let documentId: string;
    let invoiceDb: z.infer<typeof McpServerRowSchema>;
    let configurationId: string;
    let configV1: string;

    it('skill: validate → confirm → file → zip', async () => {
      const zip = await invoiceMethodZip();
      const validated = await request(api.getHttpServer())
        .post('/api/resources/skills/validate')
        .set('X-Requested-With', 'hermes-evals')
        .attach('file', zip, 'invoice-method.zip')
        .expect(200);
      const validation = SkillUploadValidationSchema.parse(validated.body);
      expect(validation).toMatchObject({ outcome: 'valid', name: 'invoice-method' });

      const skill = await send(
        'post',
        '/resources/skills',
        { token: validation.token },
        201,
        SkillRowSchema,
      );
      skillId = skill.id;
      expect(skill).toMatchObject({ name: 'invoice-method', version: '1.0.0', usedBy: [] });

      const detail = await read(`/resources/skills/${skillId}`, SkillDetailSchema);
      expect(detail.files.map((f) => f.path)).toContain('examples/reconcile.py');
      const file = await read(
        `/resources/skills/${skillId}/files/${encodeURIComponent('examples/reconcile.py')}`,
        SkillFileContentSchema,
      );
      expect(file.content).toBe('print("reconcile")\n');

      const download = await request(api.getHttpServer())
        .get(`/api/resources/skills/${skillId}/zip`)
        .buffer(true)
        .parse(binaryBody)
        .expect(200);
      expect(download.headers['content-type']).toBe('application/zip');
      expect((download.body as Buffer).subarray(0, 2).toString('latin1')).toBe('PK');
    });

    it('document: upload → download', async () => {
      const content = '# Vendor policy\n\nPay within 30 days.\n';
      const uploaded = await request(api.getHttpServer())
        .post('/api/resources/documents')
        .set('X-Requested-With', 'hermes-evals')
        .attach('file', Buffer.from(content), 'policy.md')
        .expect(201);
      const document = DocumentRowSchema.parse(uploaded.body);
      documentId = document.id;
      expect(document).toMatchObject({ filename: 'policy.md', sizeBytes: content.length });

      const download = await request(api.getHttpServer())
        .get(`/api/resources/documents/${documentId}/content`)
        .buffer(true)
        .parse(binaryBody)
        .expect(200);
      expect((download.body as Buffer).toString('utf8')).toBe(content);
      expect(download.headers['x-content-type-options']).toBe('nosniff');
    });

    it('MCP: create → edit in place → test in the worker', async () => {
      invoiceDb = await send('post', '/resources/mcp-servers', INVOICE_DB, 201, McpServerRowSchema);
      expect(invoiceDb).toMatchObject({
        version: 1,
        frozen: false,
        lastTest: { status: 'untested' },
      });
      await send('post', '/resources/mcp-servers', VENDOR_API, 201, McpServerRowSchema);

      const edited = await send(
        'put',
        `/resources/mcp-servers/${invoiceDb.id}`,
        { ...invoiceDb, timeoutS: 45 },
        200,
        McpServerRowSchema,
      );
      expect(edited).toMatchObject({ versionId: invoiceDb.versionId, version: 1, timeoutS: 45 });
      invoiceDb = edited;

      // The worker refuses before any container: the value is missing from its environment.
      const stdio = await send(
        'post',
        `/resources/mcp-servers/${invoiceDb.id}/test`,
        {},
        200,
        McpTestViewSchema,
      );
      expect(stdio).toMatchObject({ status: 'failed', missingSecretNames: ['INVOICE_DB_URL'] });
      const listed = await read('/resources/mcp-servers', z.array(McpServerRowSchema));
      expect(listed.find((s) => s.id === invoiceDb.id)?.lastTest.status).toBe('failed');

      const http = await send(
        'post',
        '/resources/mcp-servers/test',
        VENDOR_API,
        200,
        McpTestViewSchema,
      );
      expect(http).toMatchObject({
        status: 'failed',
        error: 'VENDOR_API_TOKEN is not set in the egress environment.',
        missingSecretNames: ['VENDOR_API_TOKEN'],
      });
    }, 120_000);

    it('secrets: presence comes from the newest live worker', async () => {
      await db.insert(schema.workers).values({
        hostname: 'worker-seeded',
        concurrency: 3,
        hermesVersion: '0.22.4',
        hermesRevision: HERMES_REVISION,
        toolsets: [...HERMES_TOOLSETS],
        envNames: ['INVOICE_DB_URL'],
        egressEnvNames: ['VENDOR_API_TOKEN'],
        sandbox: workerSandboxReport({
          state: 'isolated',
          checks: [{ name: 'trial runs as an unprivileged user', ok: true, detail: 'uid 10000' }],
          checkedAt: new Date(),
          image: 'hermes-evals/trial:v0.22.4-4d04303',
          imageDigest: `sha256:${'a'.repeat(64)}`,
          revision: HERMES_REVISION,
        }),
      });
      const secrets = await read('/resources/secrets', z.array(SecretRowSchema));
      expect(secrets.map((s) => [s.name, s.source, s.exposure, s.set])).toEqual([
        ['INVOICE_DB_URL', 'worker', 'readable_by_agent', true],
        ['VENDOR_API_TOKEN', 'egress', 'egress_only', true],
      ]);
    });

    it('configurations: create → edit → freeze → v2 → duplicate → diff → form options', async () => {
      const input: ConfigurationInput = {
        name: 'baseline',
        model: 'openai/gpt-6.1-sol',
        provider: 'nous',
        baseUrl: null,
        toolsets: ['file', 'terminal'],
        memoryEnabled: false,
        skillIds: [skillId],
        skillLoading: 'preload',
        documentIds: [documentId],
        mcpServerVersionIds: [invoiceDb.versionId],
        maxTurns: 20,
        timeBudgetS: 300,
        duplicatedFromVersionId: null,
      };
      const created = await send(
        'post',
        '/configurations',
        input,
        201,
        ConfigurationSaveResultSchema,
      );
      expect(created).toMatchObject({ version: 1, createdNewVersion: true });
      configurationId = created.configurationId;
      configV1 = created.versionId;

      // Unfrozen: edited in place.
      const inPlace = await send(
        'put',
        `/configurations/${configurationId}`,
        { ...input, maxTurns: 25 },
        200,
        ConfigurationSaveResultSchema,
      );
      expect(inPlace).toEqual({ ...created, createdNewVersion: false });

      // Launch freezes a version (Phase 2); here the column is set directly.
      await db
        .update(schema.configurationVersions)
        .set({ frozenAt: new Date() })
        .where(eq(schema.configurationVersions.id, configV1));
      const next = await send(
        'put',
        `/configurations/${configurationId}`,
        { ...input, maxTurns: 30 },
        200,
        ConfigurationSaveResultSchema,
      );
      expect(next).toMatchObject({ version: 2, createdNewVersion: true });

      const detail = await read(`/configurations/${configurationId}`, ConfigurationDetailSchema);
      expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);
      expect(
        await read(`/configurations/${configurationId}/versions/1`, ConfigurationDetailSchema),
      ).toMatchObject({ shown: expect.objectContaining({ version: 1, maxTurns: 25 }) });
      expect(await read('/configurations', z.array(ConfigurationListRowSchema))).toHaveLength(1);

      const draft = await send(
        'post',
        `/configurations/${configurationId}/duplicate`,
        {},
        200,
        ConfigurationDraftSchema,
      );
      expect(draft).toMatchObject({ mode: 'duplicate' });
      expect(draft.values).toMatchObject({
        name: 'baseline-copy',
        duplicatedFromVersionId: next.versionId,
      });
      expect(
        await read(`/configurations/${configurationId}/draft`, ConfigurationDraftSchema),
      ).toMatchObject({
        mode: 'edit',
        createsNewVersion: false,
      });

      const diff = await read(
        `/configurations/diff?versions=${configV1},${next.versionId}`,
        ConfigDiffSchema,
      );
      expect(diff.differing).toEqual(['max_turns']);

      const options = await read('/configurations/form-options', ConfigurationFormOptionsSchema);
      expect(options.toolsets.map((t) => t.name)).toEqual(
        expect.arrayContaining(['file', 'terminal']),
      );
      expect(options.skills.map((s) => s.skillId)).toEqual([skillId]);
    });

    it('MCP: a configuration froze v1, so the next edit is v2', async () => {
      const [frozen] = await read('/resources/mcp-servers', z.array(McpServerRowSchema)).then(
        (rows) => rows.filter((r) => r.id === invoiceDb.id),
      );
      expect(frozen).toMatchObject({
        version: 1,
        frozen: true,
        usedBy: [{ configurationId, name: 'baseline' }],
      });
      const v2 = await send(
        'put',
        `/resources/mcp-servers/${invoiceDb.id}`,
        { ...invoiceDb, exclude: [] },
        200,
        McpServerRowSchema,
      );
      expect(v2).toMatchObject({ version: 2, frozen: false, lastTest: { status: 'untested' } });
      expect(v2.versionId).not.toBe(invoiceDb.versionId);

      const counts = await read('/resources/counts', ResourceCountsSchema);
      expect(counts).toEqual({ skills: 1, documents: 1, mcpServers: 2, secrets: 2 });
    });

    it('system: summary, workers and the sandbox proof of the newest live worker', async () => {
      const summary = await read('/system/summary', SystemSummarySchema);
      expect(summary.running).toMatchObject({ count: 0 });
      expect(summary.workers).toHaveLength(2);
      expect(summary.workers.every((w) => w.status === 'online')).toBe(true);
      expect(await read('/system/workers', z.array(WorkerSchema))).toHaveLength(2);
      const sandbox = await read('/system/sandbox', SandboxStatusSchema);
      expect(sandbox.checks).toEqual([expect.objectContaining({ passed: true })]);
    });
  });

  it('serves the docs, whose "Try it out" sends X-Requested-With', async () => {
    const docs = await request(api.getHttpServer()).get('/api/docs-json').expect(200);
    expect(Object.keys(docs.body.paths as object)).toContain('/api/suites/reload');
    expect(docs.body.components.schemas.SuiteReloadResult).toBeTruthy();
    const init = await request(api.getHttpServer()).get('/api/docs/swagger-ui-init.js').expect(200);
    expect(init.text).toContain('requestInterceptor');
    expect(init.text).toContain('X-Requested-With');
  });
});
