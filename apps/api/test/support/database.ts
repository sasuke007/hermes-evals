/**
 * In-process Postgres for tests. PGlite is real Postgres compiled to
 * WebAssembly, so the migrations, constraints and triggers under test are
 * the ones Compose applies. It runs Postgres 18 while Compose runs 17, so
 * migrations must stay within Postgres 17 features.
 */
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
