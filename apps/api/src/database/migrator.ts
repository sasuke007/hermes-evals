import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';

/**
 * Folder holding the SQL migrations drizzle-kit generates from ./src/database/schema.
 * Resolved from this file so the same code works from `apps/api` in development
 * (dist/database -> ../../drizzle) and from /app in the container.
 */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Session-level advisory lock key so only one process applies migrations at a time. */
const MIGRATION_LOCK_KEY = BigInt.asIntN(
  64,
  BigInt('0x' + createHash('sha256').update('hermes-evals:migrations').digest('hex').slice(0, 16)),
);

export interface MigrationFile {
  tag: string;
  hash: string;
}

export interface MigrationReport {
  /** Migrations shipped with this build, in order. */
  available: number;
  /** Migrations recorded in the database after the run. */
  applied: number;
  /** Tag of the first shipped migration whose recorded hash differs, if any. */
  mismatch: string | null;
}

/** Migrations shipped in `folder`, in journal order, with drizzle's hash of each. */
export function readMigrations(folder: string = MIGRATIONS_FOLDER): MigrationFile[] {
  const journal = JSON.parse(readFileSync(join(folder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const files = readMigrationFiles({ migrationsFolder: folder });
  return files.map((file, index) => ({
    tag: journal.entries[index]?.tag ?? `#${index}`,
    hash: file.hash,
  }));
}

/**
 * Compares shipped migrations with the hashes recorded in the database.
 * drizzle's migrator only applies files newer than the last recorded one and
 * never re-checks hashes, so an edited or reordered migration would otherwise
 * pass silently.
 */
export function compareMigrations(files: MigrationFile[], recorded: string[]): MigrationReport {
  const index = files.findIndex((file, i) => i < recorded.length && recorded[i] !== file.hash);
  return {
    available: files.length,
    applied: recorded.length,
    mismatch: index >= 0 ? (files[index]?.tag ?? null) : null,
  };
}

/** True when the database matches this build exactly. */
export const migrationsInSync = (report: MigrationReport): boolean =>
  report.applied === report.available && report.mismatch === null;

/**
 * Applies pending migrations and reports how the database compares with this build.
 *
 * Both the API and the worker call this at boot. Postgres's advisory lock makes
 * that safe: the first process to arrive applies the SQL while the second waits
 * on the lock, then finds nothing left to apply. The lock lives on a dedicated
 * connection because it is session-scoped, and the migrator runs on that same
 * connection so it is held for the whole run.
 */
export async function runMigrations(
  connectionString: string,
  folder: string = MIGRATIONS_FOLDER,
): Promise<MigrationReport> {
  const client = new pg.Client({ connectionString, application_name: 'hermes-evals-migrator' });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
    try {
      const db = drizzle(client);
      await migrate(db, { migrationsFolder: folder });
      const recorded = await db.execute<{ hash: string }>(
        sql`select hash from drizzle.__drizzle_migrations order by id`,
      );
      return compareMigrations(
        readMigrations(folder),
        recorded.rows.map((row) => row.hash),
      );
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
    }
  } finally {
    await client.end();
  }
}
