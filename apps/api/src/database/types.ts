/**
 * Database client types that services depend on. Production runs Drizzle on
 * node-postgres and the tests run it on PGlite; both are PgDatabase over our
 * schema with a driver-specific result type. Typing services with AppDb and
 * AppTx (never NodePgDatabase or PgliteDatabase) lets one service run on
 * either, and db.provider.spec.ts proves both clients and their
 * transactions satisfy these types.
 *
 * What a query returns does not depend on the driver: select, insert and
 * update builders resolve to rows. Only `db.execute(sql)` differs, and its
 * result is typed loosely here; read `.rows` from it.
 */
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from 'drizzle-orm/pg-core';
import type * as schema from './schema/index.js';

export type AppSchema = typeof schema;

/** The Drizzle client the DB token provides. */
export type AppDb = PgDatabase<PgQueryResultHKT, AppSchema>;

/**
 * The `tx` of `db.transaction((tx) => ...)`. A transaction is also an AppDb,
 * so a helper that may run on its own or inside a caller's transaction takes
 * AppDb; one that needs the caller's transaction (row locks, a job sent with
 * the rows) takes AppTx.
 */
export type AppTx = PgTransaction<
  PgQueryResultHKT,
  AppSchema,
  ExtractTablesWithRelations<AppSchema>
>;
