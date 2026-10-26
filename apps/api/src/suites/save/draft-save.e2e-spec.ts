/**
 * The draft routes that need the worker, on Postgres 17 through
 * node-postgres: the API's DraftSaveModule with the real QueueService, and a
 * separate pg-boss client running the worker's own draft job handlers on a
 * temporary SUITES_DIR, as the worker process does. What PGlite cannot
 * show: two saves of the same folder at once (one wins, one 409s), a reload
 * of the folder waiting on the save's advisory lock, and the self-check,
 * the conflict, the rebase and the saves that do not save (422, 503) over
 * HTTP with real jobs.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PinoLogger } from 'nestjs-pino';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  DraftConflictBodySchema,
  DraftSaveFailureBodySchema,
  DraftSaveResultSchema,
  DraftSelfCheckViewSchema,
  SuiteDraftViewSchema,
} from '@hermes-evals/shared';
import { HERMES_REVISION } from '../../../test/support/seed.js';
import type { Env } from '../../config/env.js';
import { DB } from '../../database/db.provider.js';
import { runMigrations } from '../../database/migrator.js';
import * as schema from '../../database/schema/index.js';
import { QueueService } from '../../queue/queue.service.js';
import {
  subprocessVerifierRunner,
  useVerifierRunner,
  VerifierUnavailable,
} from '../../scoring/verifier-runner.js';
import { BlobStore } from '../../storage/blob-store.js';
import { StorageService } from '../../storage/storage.service.js';
import { registerDraftJobHandlers } from '../../worker/handlers/draft-jobs.js';
import type { DraftRow } from '../drafts/draft-store.js';
import { DraftWriter } from '../drafts/draft-writer.js';
import { SuiteLoader } from '../loader/suite-loader.js';
import { DraftSaveModule } from './draft-save.module.js';
import { saveSuiteDraft } from './save-draft.js';
import { folderSnapshot, openDraft, quietLogger } from './save-world.support-spec.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const FIXTURES = join(import.meta.dirname, '../../../test/fixtures/suites');

const logger = { ...quietLogger, setContext: () => {} } as unknown as PinoLogger;

describe.skipIf(!SERVER_URL)('suite draft jobs on Postgres 17', () => {
  const database = `hermes_evals_draft_save_e2e_${process.pid}`;
  let pool: pg.Pool;
  let db: NodePgDatabase<typeof schema>;
  let root: string;
  let suitesDir: string;
  let store: BlobStore;
  let loader: SuiteLoader;
  let queue: QueueService;
  let worker: PgBoss;
  let app: INestApplication;

  const admin = async (statement: string) => {
    const client = new pg.Client({ connectionString: SERVER_URL });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    await admin(`drop database if exists ${database}`);
    await admin(`create database ${database}`);
    const parsed = new URL(SERVER_URL!);
    parsed.pathname = `/${database}`;
    const url = parsed.toString();
    await runMigrations(url);
    pool = new pg.Pool({ connectionString: url, max: 8 });
    db = drizzle(pool, { schema });
    root = await mkdtemp(join(tmpdir(), 'hermes-evals-draft-save-e2e-'));
    suitesDir = join(root, 'suites');
    await cp(FIXTURES, suitesDir, { recursive: true });
    store = new BlobStore(join(root, 'data'));
    loader = new SuiteLoader({ db, blobs: store, suitesDir, logger: quietLogger });
    expect((await loader.loadOne('complete')).suites[0]!.outcome).toBe('created');

    const env: Partial<Env> = { DATABASE_URL: url, SUITE_RELOAD_TIMEOUT_S: 60 };
    const config = { get: (name: keyof Env) => env[name] } as unknown as ConfigService<Env, true>;
    queue = new QueueService(config, logger);
    await queue.onModuleInit();
    // The worker side: a separate pg-boss client with the worker's own handlers.
    worker = new PgBoss({
      connectionString: url,
      schema: 'pgboss',
      supervise: false,
      schedule: false,
    });
    worker.on('error', () => {});
    await worker.start();
    await registerDraftJobHandlers(worker, { db, blobs: store, suitesDir, logger: quietLogger });
    await db.insert(schema.workers).values({
      hostname: 'worker-1',
      concurrency: 3,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
    });

    @Global()
    @Module({
      providers: [
        { provide: DB, useValue: db },
        { provide: QueueService, useValue: queue },
        { provide: ConfigService, useValue: config },
        { provide: PinoLogger, useValue: logger },
      ],
      exports: [DB, QueueService, ConfigService, PinoLogger],
    })
    class InfraModule {}

    const moduleRef = await Test.createTestingModule({ imports: [InfraModule, DraftSaveModule] })
      .overrideProvider(StorageService)
      .useValue(store)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await worker?.stop({ graceful: false, timeout: 1000 });
    await queue?.onModuleDestroy();
    await pool?.end();
    await admin(`drop database if exists ${database} with (force)`);
    if (root) await rm(root, { recursive: true, force: true });
  }, 30_000);

  const http = () => request(app.getHttpServer());
  const post = (path: string, body: object = {}) =>
    http().post(`/api${path}`).set('X-Requested-With', 'hermes-evals').send(body);

  async function editPrompt(folder: string, key: string, extra: string): Promise<void> {
    await new DraftWriter(db, store).write(folder, undefined, async (ctx) => {
      const task = ctx.task(key);
      await ctx.change(task, { prompt: `${task.prompt ?? ''}${extra}` });
    });
  }

  it('self-checks a draft task in the worker and records it on the task', async () => {
    await openDraft(db, store, 'complete');
    const res = await post('/suites/complete/draft/tasks/summary_file/self-check').expect(200);
    const view = DraftSelfCheckViewSchema.parse(res.body);
    expect(view).toMatchObject({ status: 'passed', current: true });
    // The verifier and the file check, each on the expected workspace, then as negative controls.
    expect(view.results.map((r) => [r.key, r.mode, r.expect, r.status])).toEqual([
      ['summary_csv', 'workspace', 'pass', 'passed'],
      ['summary_csv', 'workspace', 'fail', 'failed'],
      ['totals', 'workspace', 'pass', 'passed'],
      ['totals', 'workspace', 'fail', 'failed'],
    ]);
    expect(view.results.some((r) => r.transcript?.startsWith('$ '))).toBe(true);
    const missing = await post('/suites/complete/draft/tasks/nope/self-check').expect(404);
    expect(ApiErrorBodySchema.parse(missing.body).statusCode).toBe(404);
  }, 60_000);

  it('saves once when two saves of the same folder race: one wins, one 409s', async () => {
    await editPrompt('complete', 'numeric', '\nShow cents.\n');
    const [a, b] = await Promise.all([
      post('/suites/complete/draft/save').then((r) => r),
      post('/suites/complete/draft/save').then((r) => r),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);
    const won = a.status === 200 ? a : b;
    const lost = a.status === 200 ? b : a;
    expect(DraftSaveResultSchema.parse(won.body)).toMatchObject({
      outcome: 'created',
      suite: { versionNumber: 2 },
      changes: { changed: ['numeric'] },
    });
    expect(ApiErrorBodySchema.parse(lost.body).message).toBe(
      'A save of ./suites/complete is already running.',
    );
    const drafts = await db.select().from(schema.suiteDrafts);
    expect(drafts).toEqual([]);
  }, 120_000);

  it('answers 409 with the conflict when the folder moved, and combines onto the new version', async () => {
    await openDraft(db, store, 'complete');
    await editPrompt('complete', 'exact', '\nMine.\n');
    await writeFile(
      join(suitesDir, 'complete', 'numeric', 'prompt.md'),
      'Edited on disk. ```json\n',
    );
    expect((await loader.loadOne('complete')).suites[0]!.versionNumber).toBe(3);

    const refused = await post('/suites/complete/draft/save').expect(409);
    const body = DraftConflictBodySchema.parse(refused.body);
    expect(body.conflict).toMatchObject({
      cause: 'version_moved',
      baseVersion: 2,
      current: { versionNumber: 3 },
      overlap: [],
    });
    expect(body.message).toBe(
      './suites/complete changed on disk after this draft began. A reload created v3. Your draft is based on v2.',
    );
    const moved = await post('/suites/complete/draft/rebase', { onto: 2, choices: [] }).expect(409);
    expect(DraftConflictBodySchema.parse(moved.body).conflict.current.versionNumber).toBe(3);

    const rebased = SuiteDraftViewSchema.parse(
      (await post('/suites/complete/draft/rebase', { onto: 3, choices: [] }).expect(200)).body,
    );
    expect(rebased.base?.versionNumber).toBe(3);
    expect(rebased.conflict).toBeNull();
    expect(rebased.tasks.filter((t) => t.state !== 'unchanged').map((t) => t.key)).toEqual([
      'exact',
    ]);

    const saved = DraftSaveResultSchema.parse(
      (await post('/suites/complete/draft/save').expect(200)).body,
    );
    expect(saved).toMatchObject({ outcome: 'created', suite: { versionNumber: 4 } });
    expect(saved.changes.changed).toEqual(['exact']);
  }, 120_000);

  /** The draft of `complete`, opened on its current version unless one is open already. */
  async function draftOfComplete(): Promise<DraftRow> {
    const find = () =>
      db.select().from(schema.suiteDrafts).where(eq(schema.suiteDrafts.sourcePath, 'complete'));
    if ((await find()).length === 0) await openDraft(db, store, 'complete');
    return (await find())[0]!;
  }

  const snapshot = () => folderSnapshot(join(suitesDir, 'complete'));

  it('answers 422 with the loader message, file and line for a task.yaml that does not parse', async () => {
    await draftOfComplete();
    await new DraftWriter(db, store).write('complete', undefined, async (ctx) => {
      await ctx.change(ctx.task('numeric'), { taskYaml: 'summary: [unclosed\n' });
    });
    const before = await snapshot();
    const res = await post('/suites/complete/draft/save').expect(422);
    const body = DraftSaveFailureBodySchema.parse(res.body);
    expect(body).toMatchObject({
      statusCode: 422,
      step: 'loading',
      error: { file: 'numeric/task.yaml', line: expect.any(Number) },
    });
    expect(body.message).toMatch(/^Not saved\. numeric\/task\.yaml line \d+: /);
    expect(body.message.endsWith('Nothing on disk changed. Your draft is kept.')).toBe(true);
    expect(await snapshot()).toEqual(before);
    const kept = await draftOfComplete();
    expect(kept.saveStartedAt).toBeNull();
    await db.delete(schema.suiteDrafts).where(eq(schema.suiteDrafts.id, kept.id));
  }, 120_000);

  it('answers 503 when a verifier cannot run at all, keeping the draft', async () => {
    await draftOfComplete();
    await editPrompt('complete', 'numeric', '\nShow cents.\n');
    const before = await snapshot();
    useVerifierRunner({
      run: () => Promise.reject(new VerifierUnavailable('could not start the verifier container')),
    });
    try {
      const res = await post('/suites/complete/draft/save').expect(503);
      expect(ApiErrorBodySchema.parse(res.body)).toEqual({
        statusCode: 503,
        message:
          'could not start the verifier container. Nothing on disk changed. Your draft is kept.',
      });
    } finally {
      useVerifierRunner(null);
    }
    expect(await snapshot()).toEqual(before);
    const kept = await draftOfComplete();
    expect(kept.saveStartedAt).toBeNull();
    await db.delete(schema.suiteDrafts).where(eq(schema.suiteDrafts.id, kept.id));
  }, 120_000);

  it("holds a reload of the folder until the save, under the folder's lock, has moved it", async () => {
    const draft = await draftOfComplete();
    await editPrompt('complete', 'numeric', '\nRound to cents.\n');
    const [source] = await db
      .select()
      .from(schema.suiteSources)
      .where(eq(schema.suiteSources.path, 'complete'));
    const [current] = await db
      .select()
      .from(schema.suites)
      .where(eq(schema.suites.id, source!.currentSuiteId!));
    // The save waits in its self-checks, inside its transaction, until released;
    // verifiers that start later (the reload's) run at once.
    let reached!: () => void;
    let release!: () => void;
    const inSelfChecks = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let holding = true;
    useVerifierRunner({
      run: async (options) => {
        if (holding) {
          reached();
          await released;
        }
        return subprocessVerifierRunner.run(options);
      },
    });
    try {
      const claim = new Date();
      await db
        .update(schema.suiteDrafts)
        .set({ saveStartedAt: claim })
        .where(eq(schema.suiteDrafts.id, draft.id));
      const saving = saveSuiteDraft(
        { draftId: draft.id, claim: claim.toISOString() },
        { db, blobs: store, suitesDir, logger: quietLogger },
      );
      await inSelfChecks;
      holding = false;
      let settled = false;
      const reload = loader.loadOne('complete').finally(() => (settled = true));
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(settled).toBe(false);
      expect(existsSync(join(suitesDir, 'complete', 'numeric', 'task.yaml'))).toBe(true);

      release();
      const output = await saving;
      if (output.kind !== 'saved') throw new Error(JSON.stringify(output));
      expect(output.result).toMatchObject({
        outcome: 'created',
        suite: { versionNumber: current!.versionNumber + 1 },
        changes: { changed: ['numeric'] },
      });
      const loaded = (await reload).suites[0]!;
      expect(loaded).toMatchObject({
        outcome: 'unchanged',
        versionNumber: current!.versionNumber + 1,
      });
    } finally {
      release();
      useVerifierRunner(null);
    }
  }, 120_000);

  it('answers 503 at once without a live worker, keeping the draft', async () => {
    await openDraft(db, store, 'complete');
    await db.update(schema.workers).set({ stoppedAt: new Date() });
    try {
      const res = await post('/suites/complete/draft/save').expect(503);
      expect(res.body).toEqual({
        statusCode: 503,
        message: 'No worker is running. Saving needs the worker. Your draft is kept.',
      });
      const [draft] = await db
        .select()
        .from(schema.suiteDrafts)
        .where(eq(schema.suiteDrafts.sourcePath, 'complete'));
      expect(draft!.saveStartedAt).toBeNull();
    } finally {
      await db.update(schema.workers).set({ stoppedAt: null });
    }
  });
});
