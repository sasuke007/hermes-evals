/**
 * In-process Postgres for tests. PGlite is real Postgres compiled to
 * WebAssembly, so the migrations, constraints and triggers under test are
 * the ones Compose applies. It runs Postgres 18 while Compose runs 17, so
 * migrations must stay within Postgres 17 features.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../../src/database/schema/index.js';
import { MIGRATIONS_FOLDER } from '../../src/database/migrator.js';

export type TestDb = PgliteDatabase<typeof schema>;

export interface TestDatabase {
  pg: PGlite;
  db: TestDb;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { pg, db, close: () => pg.close() };
}

export interface PartialTestDatabase extends TestDatabase {
  /** Applies every migration after the ones already applied, as a boot of the newer build would. */
  migrateRest(): Promise<void>;
}

/** A copy of the migrations folder whose journal stops at migration `tag`. */
export interface PartialMigrations {
  folder: string;
  dispose(): Promise<void>;
}

/**
 * Copies the migrations up to and including `tag`, so a test can migrate a
 * database the way an older build did, insert rows the way it stored them,
 * and then check that the next migrations upgrade them. drizzle's migrator
 * then applies the rest from the real folder.
 */
export async function migrationsUpTo(tag: string): Promise<PartialMigrations> {
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: { tag: string }[] };
  const last = journal.entries.findIndex((entry) => entry.tag === tag);
  if (last < 0) throw new Error(`no migration ${tag}`);
  const entries = journal.entries.slice(0, last + 1);
  const folder = await mkdtemp(join(tmpdir(), 'hermes-evals-migrations-'));
  await mkdir(join(folder, 'meta'));
  await writeFile(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return { folder, dispose: () => rm(folder, { recursive: true, force: true }) };
}

/** A PGlite database migrated only up to and including migration `tag` (see migrationsUpTo). */
export async function createTestDatabaseUpTo(tag: string): Promise<PartialTestDatabase> {
  const partial = await migrationsUpTo(tag);
  const pg = new PGlite();
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: partial.folder });
  return {
    pg,
    db,
    migrateRest: () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    close: async () => {
      await pg.close();
      await partial.dispose();
    },
  };
}

export interface PostgresError {
  code: string | undefined;
  message: string;
}

/** Awaits a statement that must fail and returns the Postgres error under Drizzle's wrapper. */
export async function rejection(statement: PromiseLike<unknown>): Promise<PostgresError> {
  try {
    await statement;
  } catch (err) {
    const cause = (err as { cause?: unknown }).cause ?? err;
    const { code, message } = cause as { code?: string; message?: string };
    return { code, message: String(message) };
  }
  throw new Error('expected the database to reject the statement');
}

/** SQLSTATE codes the tests assert on. */
export const SQLSTATE = {
  restrictViolation: '23001',
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  checkViolation: '23514',
} as const;
