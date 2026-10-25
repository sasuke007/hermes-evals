/**
 * What the command e2e specs share on Postgres 17: a fresh database per
 * test with the command app on it (createCommandsApp over node-postgres and
 * the real pg-boss), a second pool for observers and lock holders, and the
 * helpers that stage a race: hold a row lock, line contenders up behind it,
 * then let go. Test-only (see commands-seed.support-spec.ts).
 */
import pg from 'pg';
import type request from 'supertest';
import { runMigrations } from '../../database/migrator.js';
import { createCommandsApp, type CommandsApp } from './commands-app.support-spec.js';

export const SERVER_URL = process.env.TEST_DATABASE_URL;

export interface E2eDatabase {
  c: CommandsApp;
  /** Connections of its own for observers and lock holders, apart from the app's pool. */
  pool: pg.Pool;
  close(): Promise<void>;
}

let created = 0;

/** A new, migrated database with the command app on it; `close` drops it. */
export async function createE2eDatabase(prefix: string): Promise<E2eDatabase> {
  const database = `hermes_evals_${prefix}_${process.pid}_${++created}`;
  const admin = new pg.Client({ connectionString: SERVER_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${database}`);
  await admin.query(`create database ${database}`);
  await admin.end();
  const parsed = new URL(SERVER_URL!);
  parsed.pathname = `/${database}`;
  await runMigrations(parsed.toString());
  const c = await createCommandsApp({ connectionString: parsed.toString() });
  const pool = new pg.Pool({ connectionString: parsed.toString(), max: 4 });
  return {
    c,
    pool,
    close: async () => {
      await c.close();
      await pool.end();
      const drop = new pg.Client({ connectionString: SERVER_URL });
      await drop.connect();
      await drop.query(`drop database if exists ${database} with (force)`);
      await drop.end();
    },
  };
}

/** The experiment row lock every command and the worker take first, as waitForLockWaits matches it. */
export const EXPERIMENT_ROW_LOCK = '%from "experiments"%for no key update%';

/**
 * Resolves once `n` client sessions of this database are waiting for a
 * lock, counting only those whose statement is like `queryLike` when it is
 * given (EXPERIMENT_ROW_LOCK for the controls). Autovacuum and other
 * background workers never count: a wait of theirs would let the next
 * contender start before this one is in line.
 */
export async function waitForLockWaits(pool: pg.Pool, n: number, queryLike = '%'): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and backend_type = 'client backend'
          and wait_event_type = 'Lock' and query ilike $1`,
      [queryLike],
    );
    if (rows[0]!.n >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${n} sessions waiting for a lock`);
}

/** An open transaction holding the locks its statements took. */
export interface HeldTransaction {
  query(text: string, params?: unknown[]): Promise<pg.QueryResult>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

/** Opens a transaction on its own connection and runs `statements` in it, holding their locks. */
export async function holdLocks(
  pool: pg.Pool,
  statements: ReadonlyArray<readonly [string, unknown[]?]>,
): Promise<HeldTransaction> {
  const client = await pool.connect();
  let open = true;
  const end = async (command: 'commit' | 'rollback') => {
    if (!open) return;
    open = false;
    try {
      await client.query(command);
    } finally {
      client.release();
    }
  };
  try {
    await client.query('begin');
    for (const [text, params] of statements) await client.query(text, params);
  } catch (err) {
    await end('rollback');
    throw err;
  }
  return {
    query: (text, params) => client.query(text, params),
    commit: () => end('commit'),
    rollback: () => end('rollback'),
  };
}

/** The experiment row lock every command and the worker take first. */
export const holdExperiment = (pool: pg.Pool, id: string) =>
  holdLocks(pool, [['select 1 from experiments where id = $1 for no key update', [id]]]);

/** Starts a supertest request now (it only runs once awaited) and resolves its response. */
export const started = (test: request.Test): Promise<request.Response> =>
  new Promise((resolve, reject) => {
    test.then(resolve, reject);
  });

/** Execute-run jobs of the given runs that a worker could still take. */
export async function waitingJobKeys(
  c: CommandsApp,
  runIds?: readonly string[],
): Promise<string[]> {
  const wanted = runIds ? new Set(runIds) : null;
  return (await c.jobs())
    .filter((j) => j.state === 'created' || j.state === 'retry')
    .filter((j) => wanted === null || wanted.has(j.data.runId))
    .map((j) => j.singletonKey ?? '')
    .sort();
}
