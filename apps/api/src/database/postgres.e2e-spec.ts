/**
 * Runs against a real Postgres 17 server, the version Compose uses, to cover
 * what PGlite cannot: two processes migrating at once under the advisory
 * lock, node-postgres result types, and concurrent job claiming.
 *
 *   docker run -d --name hermes-evals-pg-test -e POSTGRES_PASSWORD=test -p 55433:5432 postgres:17-alpine
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { fromDrizzle, PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { finishAttempt, seedExperiment, startAttempt } from '../../test/support/seed.js';
import { ensureQueues } from '../queue/queue.service.js';
import { executeRunKey, QUEUES, type ExecuteRunJob } from '../queue/queues.js';
import { migrationsInSync, readMigrations, runMigrations } from './migrator.js';
import * as schema from './schema/index.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!SERVER_URL)('on Postgres 17', () => {
  const database = `hermes_evals_e2e_${process.pid}`;
  let url: string;
  let pool: pg.Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: SERVER_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${database}`);
    await admin.query(`create database ${database}`);
    await admin.end();
    const parsed = new URL(SERVER_URL!);
    parsed.pathname = `/${database}`;
    url = parsed.toString();
    pool = new pg.Pool({ connectionString: url, max: 5 });
    db = drizzle(pool, { schema });
  });

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: SERVER_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  it('applies migrations once when the API and the worker boot together', async () => {
    const [api, worker] = await Promise.all([runMigrations(url), runMigrations(url)]);
    expect(migrationsInSync(api)).toBe(true);
    expect(migrationsInSync(worker)).toBe(true);
    const recorded = await pool.query(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(recorded.rows[0].n).toBe(readMigrations().length);
    const version = await pool.query<{ server_version_num: string }>('show server_version_num');
    expect(Number(version.rows[0]!.server_version_num)).toBeGreaterThanOrEqual(170000);
  });

  it('returns the column types the code expects through node-postgres', async () => {
    const seed = await seedExperiment(db);
    const attemptId = await startAttempt(db, seed.runs[0]!.id, seed.worker.id);
    await db.insert(schema.runEvents).values({
      attemptId,
      seq: 1,
      ts: 1_792_774_882_086,
      type: 'platform',
      payload: { type: 'platform', subtype: 'started' },
    });
    await finishAttempt(db, seed.runs[0]!.id, attemptId);

    const [task] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, seed.task.id));
    expect(task!.reference).toBe('1042');
    const [attempt] = await db
      .select()
      .from(schema.attempts)
      .where(eq(schema.attempts.id, attemptId));
    expect(attempt!.costUsd).toBe(0.0045);
    expect(attempt!.startedAt).toBeInstanceOf(Date);
    const [event] = await db.select().from(schema.runEvents);
    expect(event!.ts).toBe(1_792_774_882_086);
    const [file] = await db.select().from(schema.taskFiles);
    expect(file!.size).toBe(2048);
    const [experiment] = await db.select().from(schema.experiments);
    expect(experiment!.spendCeilingUsd).toBe(5);
  });

  describe('pg-boss', () => {
    let a: PgBoss;
    let b: PgBoss;

    beforeAll(async () => {
      a = new PgBoss({
        connectionString: url,
        schema: 'pgboss',
        supervise: false,
        schedule: false,
      });
      b = new PgBoss({
        connectionString: url,
        schema: 'pgboss',
        supervise: false,
        schedule: false,
      });
      for (const boss of [a, b]) boss.on('error', () => {});
      await Promise.all([a.start(), b.start()]);
      // Both processes apply the queue settings at boot.
      await Promise.all([ensureQueues(a), ensureQueues(b)]);
    });

    afterAll(async () => {
      await Promise.all([a?.stop({ graceful: false }), b?.stop({ graceful: false })]);
    });

    it('commits a job with the transaction that sends it', async () => {
      let committed: string | null = null;
      await db.transaction(async (tx) => {
        committed = await a.send(
          QUEUES.executeRun,
          { runId: 'tx_ok', attempt: 1, trigger: 'initial' },
          { singletonKey: executeRunKey('tx_ok', 1), db: fromDrizzle(tx, sql) },
        );
      });
      let rolledBack: string | null = null;
      await expect(
        db.transaction(async (tx) => {
          rolledBack = await a.send(
            QUEUES.executeRun,
            { runId: 'tx_no', attempt: 1, trigger: 'initial' },
            { singletonKey: executeRunKey('tx_no', 1), db: fromDrizzle(tx, sql) },
          );
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(await a.getJobById(QUEUES.executeRun, committed!)).not.toBeNull();
      expect(await a.getJobById(QUEUES.executeRun, rolledBack!)).toBeNull();
      await a.deleteJob(QUEUES.executeRun, committed!);
    });

    it('never hands one job to two workers claiming at the same time', async () => {
      const total = 40;
      for (let i = 0; i < total; i++) {
        await a.send(
          QUEUES.executeRun,
          { runId: `claim_${i}`, attempt: 1, trigger: 'initial' },
          { singletonKey: executeRunKey(`claim_${i}`, 1) },
        );
      }
      const claims = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? a : b).fetch<ExecuteRunJob>(QUEUES.executeRun, { batchSize: 10 }),
        ),
      );
      const claimed = claims.flat().map((job) => job.data.runId);
      expect(new Set(claimed).size).toBe(claimed.length);
      expect(claimed.length).toBe(total);
    });
  });
});
