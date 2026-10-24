import { ServiceUnavailableException, type FactoryProvider } from '@nestjs/common';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { DatabaseService } from './database.service.js';
import type { AppDb } from './types.js';

/**
 * Injection token for the Drizzle client: `@Inject(DB) private readonly db: AppDb`.
 * Services take the client through this token rather than DatabaseService, so
 * a test can provide a PGlite database in its place (see db.provider.spec.ts).
 */
export const DB = Symbol('DB');

/** Members of a Drizzle client that are not on PgDatabase.prototype. */
const CLIENT_FIELDS = new Set<PropertyKey>(['query', 'session', 'dialect', '_', '$client']);

/**
 * Stands in for the client when DATABASE_URL is not set, so the API still
 * boots and reports the database as not configured. Using any Drizzle member
 * answers 503. Anything else behaves as a plain empty object, which is what
 * Nest sees when it probes a provider (its constructor, lifecycle hooks, a
 * `then`).
 */
export function unconfiguredDb(): AppDb {
  return new Proxy({} as AppDb, {
    get(target, prop) {
      if (prop in Object.prototype) return Reflect.get(target, prop);
      if (CLIENT_FIELDS.has(prop) || prop in PgDatabase.prototype) {
        throw new ServiceUnavailableException({
          statusCode: 503,
          message: 'database is not configured: DATABASE_URL is not set',
        });
      }
      return undefined;
    },
  });
}

/**
 * Provides DatabaseService's client. Building it opens no connection (the
 * pool connects on the first query), so an unreachable Postgres still lets
 * every module start; queries then fail until it is back.
 */
export const dbProvider: FactoryProvider<AppDb> = {
  provide: DB,
  inject: [DatabaseService],
  useFactory: (database: DatabaseService): AppDb =>
    database.isConfigured ? database.db : unconfiguredDb(),
};
