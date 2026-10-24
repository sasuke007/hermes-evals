/**
 * Migration 0002 on a database that already holds rows, as the Compose
 * database may: suites and tasks are immutable, so their new columns are
 * backfilled with the trigger briefly disabled, and the triggers must be back
 * on afterwards.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabaseUpTo,
  rejection,
  SQLSTATE,
  type PartialTestDatabase,
} from '../../test/support/database.js';
import { HERMES_REVISION, sha } from '../../test/support/seed.js';
import { mcpServerVersions } from './schema/index.js';

let t: PartialTestDatabase;

beforeEach(async () => {
  t = await createTestDatabaseUpTo('0001_integrity_triggers');
});

afterEach(async () => {
  await t.close();
});

/** The rest of the migrations run inside the test, which is slow under a parallel run. */
const MIGRATING = { timeout: 30_000 };

const suite = (id: string, path: string, loadedAt: string) =>
  `insert into suites (id, source_path, name, version_label, content_hash, check_hash, task_count, valid_count, loaded_at)
   values ('${id}', '${path}', '${path}', '1', '${sha(id)}', '${sha(`check ${id}`)}', 2, 0, '${loadedAt}');`;

const task = (id: string, suiteId: string, key: string, position: number, content: string) =>
  `insert into tasks (id, suite_id, key, position, self_check, valid, invalid_reason, content_hash)
   values ('${id}', '${suiteId}', '${key}', ${position}, '{"status":"skipped"}', false, 'not checked', '${sha(content)}');`;

describe('migration 0002 on existing rows', () => {
  it(
    'numbers suite and task versions, then restores the immutability triggers',
    MIGRATING,
    async () => {
      // invoices: v1 has x and y; v2 keeps x and edits y. other: v1 has the same x content.
      await t.pg.exec(`
      ${suite('S_INV_1', 'invoices', '2026-10-01T10:00:00Z')}
      ${suite('S_INV_2', 'invoices', '2026-10-02T10:00:00Z')}
      ${suite('S_OTHER_1', 'other', '2026-10-01T09:00:00Z')}
      ${task('T_INV_1_X', 'S_INV_1', 'x', 0, 'x content')}
      ${task('T_INV_1_Y', 'S_INV_1', 'y', 1, 'y content')}
      ${task('T_INV_2_X', 'S_INV_2', 'x', 0, 'x content')}
      ${task('T_INV_2_Y', 'S_INV_2', 'y', 1, 'y edited')}
      ${task('T_OTHER_1_X', 'S_OTHER_1', 'x', 0, 'x content')}
      begin;
      insert into mcp_servers (id, name) values ('M1', 'invoice-db');
      insert into mcp_server_versions (id, mcp_server_id, version, transport, command, definition_hash)
        values ('MV1', 'M1', 1, 'stdio', 'python3', '${sha('MV1')}');
      insert into configurations (id, name) values ('C1', 'baseline');
      insert into configuration_versions (id, configuration_id, version, model, provider, max_turns,
          time_budget_s, config_hash, mcp_server_version_ids, frozen_at)
        values ('CV1', 'C1', 1, 'openai/gpt-6.1-sol', 'nous', 20, 300, '${sha('CV1')}', '{MV1}', now());
      commit;
      insert into workers (id, hostname, concurrency, hermes_version, hermes_revision)
        values ('W1', 'worker-1', 3, '0.22.4', '${HERMES_REVISION}');
    `);

      await t.migrateRest();

      const suites = await t.pg.query<{ id: string; version_number: number }>(
        'select id, version_number from suites order by id',
      );
      expect(suites.rows).toEqual([
        { id: 'S_INV_1', version_number: 1 },
        { id: 'S_INV_2', version_number: 2 },
        { id: 'S_OTHER_1', version_number: 1 },
      ]);
      const tasks = await t.pg.query<{
        id: string;
        version_number: number;
        introduced_in_suite_id: string;
        task_yaml: string | null;
      }>('select id, version_number, introduced_in_suite_id, task_yaml from tasks order by id');
      expect(tasks.rows).toEqual([
        { id: 'T_INV_1_X', version_number: 1, introduced_in_suite_id: 'S_INV_1', task_yaml: null },
        { id: 'T_INV_1_Y', version_number: 1, introduced_in_suite_id: 'S_INV_1', task_yaml: null },
        // Unchanged in v2: keeps its number and points back at v1.
        { id: 'T_INV_2_X', version_number: 1, introduced_in_suite_id: 'S_INV_1', task_yaml: null },
        { id: 'T_INV_2_Y', version_number: 2, introduced_in_suite_id: 'S_INV_2', task_yaml: null },
        // Same content in another directory is that directory's own v1.
        {
          id: 'T_OTHER_1_X',
          version_number: 1,
          introduced_in_suite_id: 'S_OTHER_1',
          task_yaml: null,
        },
      ]);

      // The triggers disabled for the backfill are enabled again.
      for (const statement of [
        "update suites set name = 'renamed' where id = 'S_INV_1'",
        "update tasks set version_number = 9 where id = 'T_INV_1_X'",
      ]) {
        expect((await rejection(t.pg.query(statement))).code).toBe(SQLSTATE.restrictViolation);
      }
      const disabled = await t.pg.query<{ tgname: string }>(
        `select tgname from pg_trigger where not tgisinternal and tgenabled = 'D'`,
      );
      expect(disabled.rows).toEqual([]);

      // The frozen MCP definition gained empty headers, and its guard covers the new column.
      const [definition] = await t.db
        .select()
        .from(mcpServerVersions)
        .where(eq(mcpServerVersions.id, 'MV1'));
      expect(definition!.headers).toEqual([]);
      expect(definition!.frozenAt).toBeInstanceOf(Date);
      const edit = await rejection(
        t.db
          .update(mcpServerVersions)
          .set({ headers: [{ header: 'Authorization', env: 'VENDOR_TOKEN' }] })
          .where(eq(mcpServerVersions.id, 'MV1')),
      );
      expect(edit.code).toBe(SQLSTATE.restrictViolation);
      await t.db
        .update(mcpServerVersions)
        .set({
          lastTest: { status: 'running', job_id: 'j1', requested_at: '2026-10-24T10:00:00Z' },
        })
        .where(eq(mcpServerVersions.id, 'MV1'));

      const columns = await t.pg.query<{ column_name: string }>(
        `select column_name from information_schema.columns
        where table_name = 'mcp_server_versions' and column_name like 'header%' order by 1`,
      );
      expect(columns.rows.map((r) => r.column_name)).toEqual(['headers']);
      const version = await t.pg.query(
        'select duplicated_from_version_id from configuration_versions',
      );
      expect(version.rows).toEqual([{ duplicated_from_version_id: null }]);
      const worker = await t.pg.query('select egress_env_names, sandbox from workers');
      expect(worker.rows).toEqual([{ egress_env_names: [], sandbox: null }]);
    },
  );

  it(
    'refuses to drop header names it cannot turn into header pairs, and changes nothing',
    MIGRATING,
    async () => {
      await t.pg.exec(`
      begin;
      insert into mcp_servers (id, name) values ('M1', 'vendor');
      insert into mcp_server_versions (id, mcp_server_id, version, transport, url, header_names, definition_hash)
        values ('MV1', 'M1', 1, 'http', 'https://mcp.example.com/', '{VENDOR_TOKEN}', '${sha('MV1')}');
      commit;
    `);
      const refused = await rejection(t.migrateRest());
      expect(refused.message).toMatch(/cannot become \{header, env\} pairs/);
      const recorded = await t.pg.query<{ n: number }>(
        'select count(*)::int as n from drizzle.__drizzle_migrations',
      );
      expect(recorded.rows[0]!.n).toBe(2);
      const names = await t.pg.query('select header_names from mcp_server_versions');
      expect(names.rows).toEqual([{ header_names: ['VENDOR_TOKEN'] }]);
    },
  );
});
