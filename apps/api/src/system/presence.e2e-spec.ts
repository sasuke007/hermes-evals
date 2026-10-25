/**
 * Worker presence and the System endpoints' queries on a real Postgres 17
 * server through node-postgres, the driver production uses: the row a worker
 * start writes (jsonb report, text[] names), the counts' result types, and
 * the clock comparisons on the server's now().
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import type { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { HERMES_REVISION, SandboxStatusSchema, SystemSummarySchema } from '@hermes-evals/shared';
import type { PinoLogger } from 'nestjs-pino';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedExperiment } from '../../test/support/seed.js';
import type { Env } from '../config/env.js';
import { migrationsInSync, runMigrations } from '../database/migrator.js';
import * as schema from '../database/schema/index.js';
import type { SandboxService } from '../sandbox/sandbox.service.js';
import { WorkerPresenceService } from '../worker/presence/worker-presence.service.js';
import { SystemService } from './system.service.js';

vi.mock('../sandbox/toolsets.js', () => ({
  listToolsets: vi.fn(async () => ['web', 'terminal', 'file']),
}));
vi.mock('../worker/presence/trial-image.js', () => ({
  inspectTrialImage: vi.fn(async () => ({
    id: `sha256:${'7'.repeat(64)}`,
    revision: HERMES_REVISION,
  })),
}));

const SERVER_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!SERVER_URL)('presence and the System queries on Postgres 17', () => {
  const database = `hermes_evals_presence_e2e_${process.pid}`;
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

  it('shows a started worker as online and proven, and as last seen once it stops', async () => {
    const settings: Record<string, unknown> = {
      DATABASE_URL: 'postgres://unused',
      WORKER_CONCURRENCY: 3,
      DOCKER_SOCKET: '/run/guard/docker.sock',
    };
    const sandbox = {
      status: () => ({
        state: 'isolated',
        checks: [{ name: 'has no default route', ok: true, detail: 'no default route' }],
      }),
      egress: {
        envNames: async () => ['VENDOR_API_TOKEN'],
        healthReport: async () => ({ ok: true, attempts: 0 }),
      },
      image: 'hermes-evals/trial:v0.22.4-4d04303',
      slots: ['trial-0', 'trial-1', 'trial-2', 'trial-3'],
    } as unknown as SandboxService;
    const quiet = { setContext() {}, info() {}, warn() {}, debug() {}, error() {} };
    const presence = new WorkerPresenceService(
      db,
      { get: (key: string) => settings[key] } as unknown as ConfigService<Env, true>,
      sandbox,
      quiet as unknown as PinoLogger,
    );
    const system = new SystemService(db);

    await presence.start();
    const workers = await system.workers();
    expect(workers).toEqual([
      expect.objectContaining({
        id: presence.id,
        status: 'online',
        sandboxProven: true,
        concurrency: 3,
        slotsTotal: 4,
      }),
    ]);
    const status = SandboxStatusSchema.parse(await system.sandbox());
    expect(status).toMatchObject({
      proven: true,
      revision: 'hermes-agent v0.22.4 @ 4d04303',
      digest: `sha256:${'7'.repeat(64)}`,
    });
    expect(status.checks).toEqual([
      {
        id: 'no-default-route',
        name: 'has no default route',
        passed: true,
        detail: 'no default route',
      },
    ]);

    const s = await seedExperiment(db);
    const summary = SystemSummarySchema.parse(await system.summary());
    expect(summary.running).toEqual({
      count: 1,
      scored: 0,
      total: 4,
      experiments: [{ id: s.experiment.id, name: 'Skill vs no skill', scored: 0, total: 4 }],
    });
    expect(summary.queuedRuns).toBe(4);
    // The seeded worker started after this one.
    expect(summary.workers.map((w) => w.id)).toEqual([s.worker.id, presence.id]);

    await presence.stop();
    const after = await system.workers();
    expect(after.map((w) => w.id)).toEqual([s.worker.id]);
  });
});
