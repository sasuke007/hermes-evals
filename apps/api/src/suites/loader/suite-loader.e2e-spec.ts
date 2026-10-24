/**
 * The loader on a real Postgres 17 server, for what PGlite's single
 * connection cannot show: two loads at once. The advisory lock makes two
 * loads of one directory agree on one version, and the name index makes two
 * directories racing for one name end with one owner and one error.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SuiteReloadResultSchema } from '@hermes-evals/shared';
import { runMigrations } from '../../database/migrator.js';
import * as schema from '../../database/schema/index.js';
import { BlobStore } from '../../storage/blob-store.js';
import { SuiteLoader, type LoaderLogger } from './suite-loader.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const FIXTURES = join(import.meta.dirname, '../../../test/fixtures/suites');

describe.skipIf(!SERVER_URL)('suite loader on Postgres 17', () => {
  const database = `hermes_evals_loader_e2e_${process.pid}`;
  let pool: pg.Pool;
  let db: NodePgDatabase<typeof schema>;
  let root: string;
  let suitesDir: string;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as LoaderLogger;

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
    root = await mkdtemp(join(tmpdir(), 'hermes-evals-loader-e2e-'));
    suitesDir = join(root, 'suites');
    await cp(join(FIXTURES, 'complete'), join(suitesDir, 'complete'), { recursive: true });
    for (const dir of ['race-a', 'race-b']) {
      await cp(join(FIXTURES, 'complete'), join(suitesDir, dir), { recursive: true });
      const yaml = join(suitesDir, dir, 'suite.yaml');
      await writeFile(yaml, (await readFile(yaml, 'utf8')).replace('name: complete', 'name: race'));
    }
    // Same new files, tasks listed in opposite orders: blob rows in task order would deadlock.
    for (const [dir, order] of [
      ['shared-a', '[numeric, json_unordered, exact, summary_file, answer_verifier]'],
      ['shared-b', '[answer_verifier, summary_file, exact, json_unordered, numeric]'],
    ] as const) {
      await cp(join(FIXTURES, 'complete'), join(suitesDir, dir), { recursive: true });
      const yaml = join(suitesDir, dir, 'suite.yaml');
      const text = (await readFile(yaml, 'utf8'))
        .replace('name: complete', `name: ${dir}`)
        .replace(/^tasks: .*$/m, `tasks: ${order}`);
      await writeFile(yaml, text);
    }
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: SERVER_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const loader = () =>
    new SuiteLoader({ db, blobs: new BlobStore(join(root, 'data')), suitesDir, logger });

  it('agrees on one version when one directory is loaded twice at once', async () => {
    const [a, b] = await Promise.all([loader().loadOne('complete'), loader().loadOne('complete')]);
    const outcomes = [a, b].map((r) => SuiteReloadResultSchema.parse(r).suites[0]!);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['created', 'unchanged']);
    expect(outcomes[0]!.suiteId).toBe(outcomes[1]!.suiteId);
    const rows = await db.select().from(schema.suites);
    expect(rows).toHaveLength(1);
  }, 60_000);

  it('loads two directories sharing new files at once, whatever order their tasks are in', async () => {
    // A store of its own, so every file is new to both loads.
    const store = new BlobStore(join(root, 'shared-data'));
    const fresh = () => new SuiteLoader({ db, blobs: store, suitesDir, logger });
    const tasks = ['numeric', 'json_unordered', 'exact', 'summary_file', 'answer_verifier'];
    for (let round = 0; round < 3; round++) {
      // Each round, the same edit in both directories: five new files they share.
      for (const dir of ['shared-a', 'shared-b']) {
        for (const task of tasks) {
          const prompt = join(suitesDir, dir, task, 'prompt.md');
          await writeFile(prompt, `${await readFile(prompt, 'utf8')}\nRound ${round}.\n`);
        }
      }
      const [a, b] = await Promise.all([fresh().loadOne('shared-a'), fresh().loadOne('shared-b')]);
      const outcomes = [a, b].map((r) => SuiteReloadResultSchema.parse(r).suites[0]!);
      expect(
        outcomes.map((o) => [o.outcome, o.versionNumber]),
        `round ${round}: ${outcomes.map((o) => o.message).join(' / ')}`,
      ).toEqual([
        ['created', round + 1],
        ['created', round + 1],
      ]);
    }
  }, 120_000);

  it('leaves one owner when two directories race for one name', async () => {
    const [a, b] = await Promise.all([loader().loadOne('race-a'), loader().loadOne('race-b')]);
    const outcomes = [a, b].map((r) => SuiteReloadResultSchema.parse(r).suites[0]!);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['created', 'error']);
    const sources = await db.select().from(schema.suiteSources);
    const racers = sources.filter((s) => s.path.startsWith('race-'));
    expect(racers.filter((s) => s.name === 'race')).toHaveLength(1);
    const loser = racers.find((s) => s.lastOutcome === 'error')!;
    expect(loser).toMatchObject({ name: null, currentSuiteId: null });
    expect(loser.lastError?.message).toMatch(/^suite name race is already used by directory race-/);
    // The loser's version was rolled back with its transaction.
    const versions = await db.select().from(schema.suites);
    expect(versions.filter((v) => v.sourcePath === loser.path)).toEqual([]);
  }, 60_000);
});
