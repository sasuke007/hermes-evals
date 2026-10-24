/**
 * Configuration saves under real concurrency, on Postgres 17 through
 * node-postgres: what PGlite, with its single connection, cannot show.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { HttpException } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../database/migrator.js';
import * as schema from '../database/schema/index.js';
import { ConfigurationWritesService } from './configuration-writes.service.js';
import { sha } from '../../test/support/seed.js';
import {
  configurationInput as input,
  freezeVersion,
  mcpFrozenAt,
  seedLibrary,
  versionRow,
  type Library,
} from './support-spec.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!SERVER_URL)('configuration saves on Postgres 17', () => {
  const database = `hermes_evals_cfg_e2e_${process.pid}`;
  let pool: pg.Pool;
  let db: NodePgDatabase<typeof schema>;
  let writes: ConfigurationWritesService;
  let lib: Library;

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
    writes = new ConfigurationWritesService(db);
    lib = await seedLibrary(db);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: SERVER_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
  });

  const versionsOf = (configurationId: string) =>
    db
      .select()
      .from(schema.configurationVersions)
      .where(eq(schema.configurationVersions.configurationId, configurationId))
      .orderBy(asc(schema.configurationVersions.version));

  it('serialises two edits of a frozen version: one makes v2, the other then edits v2', async () => {
    const saved = await writes.create(input({ name: 'concurrent' }));
    await freezeVersion(db, saved.versionId);
    // Hold the version's row lock so both edits are in flight at once before either proceeds.
    const blocker = await pool.connect();
    let results;
    try {
      await blocker.query('begin');
      await blocker.query('select 1 from configuration_versions where id = $1 for update', [
        saved.versionId,
      ]);
      const edits = Promise.all([
        writes.update(saved.configurationId, input({ name: 'concurrent', maxTurns: 30 })),
        writes.update(saved.configurationId, input({ name: 'concurrent', maxTurns: 40 })),
      ]);
      await waitForLockWaits(pool, 2);
      await blocker.query('commit');
      results = await edits;
    } finally {
      blocker.release();
    }
    // Without the configuration row lock, both would insert v2 and one would fail.
    expect(results.map((r) => r.version)).toEqual([2, 2]);
    expect(results.filter((r) => r.createdNewVersion)).toHaveLength(1);
    const versions = await versionsOf(saved.configurationId);
    expect(versions.map((v) => [v.version, v.maxTurns])).toEqual([
      [1, 20],
      [2, expect.any(Number)],
    ]);
  });

  it('lets exactly one of two creates with the same name win; the other is a 409', async () => {
    const outcomes = await Promise.allSettled([
      writes.create(input({ name: 'raced' })),
      writes.create(input({ name: 'raced', maxTurns: 99 })),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const [lost] = outcomes.filter((o) => o.status === 'rejected');
    const reason = (lost as PromiseRejectedResult).reason as HttpException;
    expect(reason).toBeInstanceOf(HttpException);
    expect(reason.getStatus()).toBe(409);
  });

  it('waits for a launch freezing the version, then saves the edit as the next version', async () => {
    const saved = await writes.create(input({ name: 'launching' }));
    const launch = await pool.connect();
    try {
      // A launch freezes the versions it tests inside its own transaction.
      await launch.query('begin');
      await launch.query('update configuration_versions set frozen_at = now() where id = $1', [
        saved.versionId,
      ]);
      const edit = writes.update(saved.configurationId, input({ name: 'launching', maxTurns: 50 }));
      // The edit reads the version FOR UPDATE, so it must be waiting on the launch's row lock.
      await waitForLockWaits(pool, 1);
      await launch.query('commit');
      const result = await edit;
      expect(result).toMatchObject({ version: 2, createdNewVersion: true });
    } finally {
      launch.release();
    }
    const versions = await versionsOf(saved.configurationId);
    expect(versions.map((v) => [v.version, v.maxTurns, v.frozenAt !== null])).toEqual([
      [1, 20, true],
      [2, 50, false],
    ]);
  });

  it('waits for an MCP edit in flight and hashes the definition that edit committed', async () => {
    expect(await mcpFrozenAt(db, lib.mcpV2)).toBeNull();
    const edited = sha('invoice-db v2, edited in place');
    const edit = await pool.connect();
    let saved;
    try {
      // McpServersService.update: the server row, then the version row, then the in-place write.
      await edit.query('begin');
      await edit.query('select 1 from mcp_servers where id = $1 for update', [lib.mcpServerId]);
      await edit.query(
        'update mcp_server_versions set timeout_s = timeout_s + 1, definition_hash = $2 where id = $1',
        [lib.mcpV2, edited],
      );
      const save = writes.create(
        input({ name: 'during-mcp-edit', mcpServerVersionIds: [lib.mcpV2] }),
      );
      await waitForLockWaits(pool, 1);
      await edit.query('commit');
      saved = await save;
    } finally {
      edit.release();
    }
    // The save froze the edited definition, and its hash is the one the same settings give now.
    const [mcp] = await db
      .select()
      .from(schema.mcpServerVersions)
      .where(eq(schema.mcpServerVersions.id, lib.mcpV2));
    expect(mcp).toMatchObject({ definitionHash: edited, frozenAt: expect.any(Date) });
    const again = await writes.create(
      input({ name: 'after-mcp-edit', mcpServerVersionIds: [lib.mcpV2] }),
    );
    expect((await versionRow(db, saved.versionId)).configHash).toBe(
      (await versionRow(db, again.versionId)).configHash,
    );
  });

  it('queues two saves that freeze the same MCP version instead of deadlocking', async () => {
    expect(await mcpFrozenAt(db, lib.httpMcpV1)).toBeNull();
    const blocker = await pool.connect();
    let outcomes;
    try {
      await blocker.query('begin');
      await blocker.query('select 1 from mcp_server_versions where id = $1 for update', [
        lib.httpMcpV1,
      ]);
      const saves = Promise.allSettled([
        writes.create(input({ name: 'shares-mcp-a', mcpServerVersionIds: [lib.httpMcpV1] })),
        writes.create(input({ name: 'shares-mcp-b', mcpServerVersionIds: [lib.httpMcpV1] })),
      ]);
      await waitForLockWaits(pool, 2);
      await blocker.query('commit');
      outcomes = await saves;
    } finally {
      blocker.release();
    }
    // Shared locks here would let both through and then deadlock on the freeze.
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await mcpFrozenAt(db, lib.httpMcpV1)).toBeInstanceOf(Date);
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
