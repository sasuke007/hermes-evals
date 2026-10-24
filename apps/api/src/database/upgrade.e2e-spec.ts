/**
 * Migration 0002 through the production migrator on Postgres 17, the version
 * Compose runs, on a database that holds rows written before it: the same
 * upgrade the Compose database gets when the stack restarts on this build.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsUpTo, type PartialMigrations } from '../../test/support/database.js';
import { HERMES_REVISION, sha } from '../../test/support/seed.js';
import { migrationsInSync, readMigrations, runMigrations } from './migrator.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!SERVER_URL)('migration 0002 on Postgres 17 with existing rows', () => {
  const database = `hermes_evals_upgrade_e2e_${process.pid}`;
  let url: string;
  let partial: PartialMigrations;
  let client: pg.Client;

  const admin = async (statement: string) => {
    const connection = new pg.Client({ connectionString: SERVER_URL });
    await connection.connect();
    try {
      await connection.query(statement);
    } finally {
      await connection.end();
    }
  };

  beforeAll(async () => {
    await admin(`drop database if exists ${database}`);
    await admin(`create database ${database}`);
    const parsed = new URL(SERVER_URL!);
    parsed.pathname = `/${database}`;
    url = parsed.toString();
    partial = await migrationsUpTo('0001_integrity_triggers');
    client = new pg.Client({ connectionString: url });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await partial?.dispose();
    await admin(`drop database if exists ${database} with (force)`);
  });

  it('backfills version numbers, keeps the triggers on, and enforces the header rules', async () => {
    expect(migrationsInSync(await runMigrations(url, partial.folder))).toBe(true);
    await client.query(`
      insert into suites (id, source_path, name, version_label, content_hash, check_hash, task_count, valid_count, loaded_at)
      values ('S1', 'invoices', 'invoices', '1', '${sha('S1')}', '${sha('c1')}', 1, 0, '2026-10-01T10:00:00Z'),
             ('S2', 'invoices', 'invoices', '1', '${sha('S2')}', '${sha('c2')}', 1, 0, '2026-10-02T10:00:00Z');
      insert into tasks (id, suite_id, key, position, self_check, valid, invalid_reason, content_hash)
      values ('T1', 'S1', 'total_due', 0, '{"status":"skipped"}', false, 'x', '${sha('a')}'),
             ('T2', 'S2', 'total_due', 0, '{"status":"skipped"}', false, 'x', '${sha('b')}');
      insert into workers (id, hostname, concurrency, hermes_version, hermes_revision)
      values ('W1', 'worker-1', 3, '0.22.4', '${HERMES_REVISION}');
    `);

    const report = await runMigrations(url);
    expect(migrationsInSync(report)).toBe(true);
    expect(report.applied).toBe(readMigrations().length);

    const tasks = await client.query(
      'select t.id, s.version_number as suite_number, t.version_number, t.introduced_in_suite_id ' +
        'from tasks t join suites s on s.id = t.suite_id order by t.id',
    );
    expect(tasks.rows).toEqual([
      { id: 'T1', suite_number: 1, version_number: 1, introduced_in_suite_id: 'S1' },
      { id: 'T2', suite_number: 2, version_number: 2, introduced_in_suite_id: 'S2' },
    ]);
    await expect(
      client.query(`update tasks set task_yaml = 'x' where id = 'T1'`),
    ).rejects.toMatchObject({ code: '23001' });
    const workers = await client.query('select egress_env_names, sandbox from workers');
    expect(workers.rows).toEqual([{ egress_env_names: [], sandbox: null }]);

    const insertHttp = (headers: unknown) =>
      client.query(
        `begin;
         insert into mcp_servers (id, name) values ('M1', 'vendor');
         insert into mcp_server_versions (id, mcp_server_id, version, transport, url, headers, definition_hash)
         values ('MV1', 'M1', 1, 'http', 'https://mcp.example.com/', '${JSON.stringify(headers)}', '${sha('MV1')}');
         commit;`,
      );
    await expect(insertHttp([{ header: 'Authorization', env: 'Bearer sk-1' }])).rejects.toThrow(
      /mcp_server_versions_headers_ck/,
    );
    await client.query('rollback');
    await insertHttp([{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }]);
    const stored = await client.query('select headers from mcp_server_versions');
    expect(stored.rows).toEqual([
      { headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }] },
    ]);
  });
});
