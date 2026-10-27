/**
 * MCP server saves under real concurrency, on Postgres 17 through
 * node-postgres: what PGlite, with its single connection, cannot show.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { ConflictException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../database/migrator.js';
import * as schema from '../../database/schema/index.js';
import { McpServersService } from './mcp-servers.service.js';
import { INVOICE_DB, useInConfiguration, VENDOR_API } from './mcp-testing.support-spec.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!SERVER_URL)('MCP server saves on Postgres 17', () => {
  const database = `hermes_evals_mcp_e2e_${process.pid}`;
  let pool: pg.Pool;
  let db: NodePgDatabase<typeof schema>;
  let servers: McpServersService;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: SERVER_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${database}`);
    await admin.query(`create database ${database}`);
    await admin.end();
    const parsed = new URL(SERVER_URL!);
    parsed.pathname = `/${database}`;
    await runMigrations(parsed.toString());
    pool = new pg.Pool({ connectionString: parsed.toString(), max: 6 });
    db = drizzle(pool, { schema });
    servers = new McpServersService(db);
  }, 60_000);

  afterAll(async () => {
    // pool.end() resolves before its clients' sockets close; the forced drop
    // below can end one mid-close, which the pool reports as an error of an
    // idle client (test/support/phase2-app.ts handles it the same way).
    pool?.on('error', () => {});
    await pool?.end();
    const admin = new pg.Client({ connectionString: SERVER_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  const versionsOf = (serverId: string) =>
    db
      .select()
      .from(schema.mcpServerVersions)
      .where(eq(schema.mcpServerVersions.mcpServerId, serverId))
      .orderBy(asc(schema.mcpServerVersions.version));

  it('serialises two edits of a frozen definition: one makes v2, the other then edits v2', async () => {
    const saved = await servers.create({ ...INVOICE_DB, name: 'concurrent' });
    await useInConfiguration(db, 'uses-concurrent', [saved.versionId]);
    // Hold the server row so both edits are in flight before either proceeds.
    const blocker = await pool.connect();
    let results;
    try {
      await blocker.query('begin');
      await blocker.query('select 1 from mcp_servers where id = $1 for update', [saved.id]);
      const edits = Promise.all([
        servers.update(saved.id, { ...INVOICE_DB, name: 'concurrent', timeoutS: 40 }),
        servers.update(saved.id, { ...INVOICE_DB, name: 'concurrent', timeoutS: 50 }),
      ]);
      await waitForLockWaits(pool, 2);
      await blocker.query('commit');
      results = await edits;
    } finally {
      blocker.release();
    }
    // Without the server row lock, both would insert version 2 and one would fail.
    expect(results.map((r) => r.version)).toEqual([2, 2]);
    expect(results[0]!.versionId).toBe(results[1]!.versionId);
    const versions = await versionsOf(saved.id);
    expect(versions.map((v) => [v.version, v.frozenAt !== null])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(versions[0]!.timeoutS).toBe(INVOICE_DB.timeoutS);
    expect([40, 50]).toContain(versions[1]!.timeoutS);
  });

  it('answers 409 to the loser of two creates with one name, and keeps one server', async () => {
    const results = await Promise.allSettled([
      servers.create({ ...VENDOR_API, name: 'same-name' }),
      servers.create({ ...INVOICE_DB, name: 'same-name' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r) => r.status === 'rejected')!;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect((rejected.reason as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      message: 'an MCP server named same-name already exists',
    });
    const named = await db
      .select()
      .from(schema.mcpServers)
      .where(eq(schema.mcpServers.name, 'same-name'));
    expect(named).toHaveLength(1);
  });

  it('decides under the lock: a definition frozen while an edit waited becomes version 2', async () => {
    const saved = await servers.create({ ...INVOICE_DB, name: 'freeze-race' });
    const blocker = await pool.connect();
    let row;
    try {
      await blocker.query('begin');
      await blocker.query('select 1 from mcp_servers where id = $1 for update', [saved.id]);
      // The edit read nothing yet: it waits for the server row.
      const edit = servers.update(saved.id, { ...INVOICE_DB, name: 'freeze-race', timeoutS: 77 });
      await waitForLockWaits(pool, 1);
      // Meanwhile a configuration save freezes version 1.
      await useInConfiguration(db, 'freezes-race', [saved.versionId]);
      await blocker.query('commit');
      row = await edit;
    } finally {
      blocker.release();
    }
    expect(row).toMatchObject({ version: 2, timeoutS: 77, usedBy: [{ name: 'freezes-race' }] });
    const versions = await versionsOf(saved.id);
    expect(versions.map((v) => [v.version, v.timeoutS, v.frozenAt !== null])).toEqual([
      [1, INVOICE_DB.timeoutS, true],
      [2, 77, false],
    ]);
  });
});

/** Resolves once `n` backends are waiting for a lock; fails after 5 s. */
async function waitForLockWaits(pool: pg.Pool, n: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
    );
    if (rows[0]!.n >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`expected ${n} sessions waiting for a lock`);
}
