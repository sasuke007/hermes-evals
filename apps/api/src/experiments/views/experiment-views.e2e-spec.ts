/**
 * The experiment views and the live stream's reads on a real Postgres 17
 * server through node-postgres, the driver production uses. The PGlite specs
 * check the figures; this one checks that the same figures come back through
 * node-postgres's result types (count and sum as strings, numeric money,
 * bigint event times, a timestamptz aggregate) and the server's own clock.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { ExperimentDetailSchema, ExperimentListRowSchema } from '@hermes-evals/shared';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsInSync, runMigrations } from '../../database/migrator.js';
import * as schema from '../../database/schema/index.js';
import { diffEvents, initialEvents } from '../sse/experiment-diff.js';
import { DbLiveSource } from '../sse/live-source.js';
import { ExperimentViewsService } from './experiment-views.service.js';
import { at, pause, seedMatrix, seedWorld, T0 } from './seed.support-spec.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!SERVER_URL)('experiment views on Postgres 17', () => {
  const database = `hermes_evals_experiment_views_e2e_${process.pid}`;
  let pool: pg.Pool;
  let db: NodePgDatabase<typeof schema>;

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
    expect(migrationsInSync(await runMigrations(parsed.toString()))).toBe(true);
    pool = new pg.Pool({ connectionString: parsed.toString(), max: 5 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    await admin(`drop database if exists ${database} with (force)`);
  });

  it('gives the hand-checked figures through node-postgres, and the stream agrees', async () => {
    const w = await seedWorld(db);
    const { experiment } = await seedMatrix(db, w);
    const views = new ExperimentViewsService(db);

    const d = ExperimentDetailSchema.parse(await views.detail(experiment.id, at(100)));
    expect(d).toMatchObject({
      createdAt: T0.toISOString(),
      elapsedS: 100,
      remainingEstimateS: 40,
      lastEventAt: at(60).toISOString(),
      totalRuns: 8,
    });
    expect(d.spend).toEqual({
      spentUsd: 0.1,
      ceilingUsd: 5,
      projectedTotalUsd: 0.185,
      remainingEstimateUsd: 0.085,
      unpricedAttempts: 0,
    });
    expect(d.aggregates.map((a) => [a.passRate, a.meanTokens, a.costUsd])).toEqual([
      [0.333, 1500, 0.03],
      [0.5, 3500, 0.07],
    ]);
    // The worker's heartbeat is the server's now(): live on its clock.
    expect(d.worker.connected).toBe(true);
    expect(Number.isNaN(Date.parse(d.worker.lastHeartbeatAt ?? ''))).toBe(false);

    const [row] = ExperimentListRowSchema.array().parse(await views.list());
    expect(row).toMatchObject({ id: experiment.id, doneRuns: 4, costUsd: 0.1, totalRuns: 8 });
    expect(row!.counts).toEqual(d.counts);

    const source = new DbLiveSource(db);
    const before = await source.version(experiment.id);
    const live = await source.state(experiment.id);
    expect(live.counts).toEqual(d.counts);
    expect(live.spend).toEqual(d.spend);
    expect(initialEvents(live, at(100).toISOString())).toHaveLength(2);

    await pause(db, experiment.id, 'spend_ceiling', at(101));
    expect(await source.version(experiment.id)).not.toBe(before);
    const paused = await source.state(experiment.id);
    expect(diffEvents(live, paused, at(102).toISOString())).toEqual([
      expect.objectContaining({
        type: 'experiment',
        status: 'paused',
        pauseReason: 'spend_ceiling',
      }),
    ]);
    const [pausedRow] = ExperimentListRowSchema.array().parse(await views.list());
    expect(pausedRow!.statusReason).toBe('Paused at the $5.00 spend ceiling');
  });
});
