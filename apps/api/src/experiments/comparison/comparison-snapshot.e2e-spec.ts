/**
 * The comparison's snapshot on a real Postgres 17 server (plan 10.3): an
 * answer is read in one REPEATABLE READ READ ONLY transaction whose first
 * statement reads the experiment row, so a run that changes while the
 * answer is being read shows in the next answer, never in part of this
 * one, and this one is cached under the revision it was read at.
 *
 * The app's connections are wrapped so the test can stop the comparison's
 * read right after the experiment row, look at the transaction's settings
 * on that same connection, and commit a change from another one meanwhile.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { ComparisonView } from '@hermes-evals/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsInSync, runMigrations } from '../../database/migrator.js';
import * as schema from '../../database/schema/index.js';
import { experiments } from '../../database/schema/index.js';
import { at, launch, scored, seedWorld } from '../views/seed.support-spec.js';
import { ComparisonService } from './comparison.service.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

type Query = (config: string | pg.QueryConfig, values?: unknown[]) => Promise<pg.QueryResult>;

/** The comparison's first statement (results.ts experimentHead): the experiment row, unlocked. */
const isHeadRead = (text: string): boolean =>
  text.startsWith('select ') && text.includes(' from "experiments" ') && !text.includes(' for ');

/** Runs once, on the reading connection, right after its next experiment-row read. */
let afterHeadRead: ((query: Query) => Promise<void>) | null = null;

/** Wraps a new connection's query so afterHeadRead can step in. */
function watch(client: pg.PoolClient): void {
  const original = client.query.bind(client) as unknown as (...args: unknown[]) => unknown;
  const query: Query = (config, values) => original(config, values) as Promise<pg.QueryResult>;
  const watched = (...args: unknown[]): unknown => {
    // The pool's own queries (db.select outside a transaction) pass a callback.
    if (args.some((arg) => typeof arg === 'function')) return original(...args);
    const [config, values] = args as Parameters<Query>;
    return (async () => {
      const result = await query(config, values);
      const step = afterHeadRead;
      if (step && isHeadRead(typeof config === 'string' ? config : config.text)) {
        afterHeadRead = null;
        await step(query);
      }
      return result;
    })();
  };
  Object.assign(client, { query: watched });
}

let created = 0;
let close: (() => Promise<void>) | null = null;

async function admin(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: SERVER_URL });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

async function createDatabase(): Promise<NodePgDatabase<typeof schema>> {
  const database = `hermes_evals_snapshot_e2e_${process.pid}_${++created}`;
  await admin(`drop database if exists ${database}`);
  await admin(`create database ${database}`);
  const parsed = new URL(SERVER_URL!);
  parsed.pathname = `/${database}`;
  expect(migrationsInSync(await runMigrations(parsed.toString()))).toBe(true);
  const pool = new pg.Pool({ connectionString: parsed.toString(), max: 4 });
  pool.on('connect', watch);
  close = async () => {
    await pool.end();
    await admin(`drop database if exists ${database} with (force)`);
  };
  return drizzle(pool, { schema });
}

afterEach(async () => {
  afterHeadRead = null;
  await close?.();
  close = null;
});

const cellOf = (view: ComparisonView, runId: string) =>
  view.rows.flatMap((r) => [...r.baseline, ...r.candidate]).find((c) => c.runId === runId);

describe.skipIf(!SERVER_URL)('the comparison snapshot on Postgres 17', () => {
  it('reads at the experiment row’s revision: REPEATABLE READ, READ ONLY, nothing committed later', async () => {
    const db = await createDatabase();
    const w = await seedWorld(db);
    const { experiment, run } = await launch(db, w);
    const service = new ComparisonService(db);
    const revision = async () => {
      const [row] = await db
        .select({ revision: experiments.resultsRevision })
        .from(experiments)
        .where(eq(experiments.id, experiment.id));
      return row!.revision;
    };
    const r0 = await revision();

    let settings: unknown = null;
    afterHeadRead = async (query) => {
      const { rows } = await query(
        `select current_setting('transaction_isolation') as isolation,
                current_setting('transaction_read_only') as read_only`,
      );
      settings = rows[0];
      // Another connection scores a run and commits while the answer is being read.
      await scored(db, w, run('a/base/1'), { startedAt: at(0), durationS: 5, status: 'passed' });
    };
    const view = await service.comparison(experiment.id, {});

    expect(afterHeadRead).toBeNull();
    expect(settings).toEqual({ isolation: 'repeatable read', read_only: 'on' });
    expect(await revision()).toBeGreaterThan(r0);
    // Every part of the answer is the row's revision: the run scored after it is in none.
    expect(cellOf(view, run('a/base/1'))).toMatchObject({ runStatus: 'queued', scoreStatus: null });
    expect(view.progress).toEqual({ scored: 0, total: 8 });
    expect(view.passCounts.baseline).toEqual({ passed: 0, counted: 0 });
    expect(view.statisticsUnavailable?.reason).toBe('nothing_scored');

    // The next answer reads the new revision, and the run is in all of it.
    const next = await service.comparison(experiment.id, {});
    expect(next).not.toBe(view);
    expect(cellOf(next, run('a/base/1'))).toMatchObject({
      runStatus: 'scored',
      scoreStatus: 'passed',
    });
    expect(next.progress).toEqual({ scored: 1, total: 8 });
    expect(next.passCounts.baseline).toEqual({ passed: 1, counted: 1 });
    expect(await service.comparison(experiment.id, {})).toBe(next);
  });
});
