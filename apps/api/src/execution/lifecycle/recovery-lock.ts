/**
 * The cluster-wide lock that keeps recovery to one pass at a time across
 * every worker (plan 8.6). It is a Postgres session advisory lock, taken with
 * pg_try_advisory_lock so a worker that finds it held skips its pass instead
 * of queueing behind it: the holder is doing the same work.
 *
 * Correctness does not rest on the lock. Every step of a pass is guarded in
 * the rows it changes (revocation filters on status and revoked_at,
 * finalising locks the attempt and re-checks it, jobs are sent under
 * exclusive keys), so two passes that did overlap would only repeat work.
 * The lock saves that work and keeps two workers from stopping the same
 * container at once.
 *
 * A session lock belongs to one connection, so it must be taken and released
 * on the same one: poolRecoveryLock checks a client out of the pool for the
 * whole pass. If that connection dies the server releases the lock with it.
 */
import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { AppDb } from '../../database/types.js';
import { rowsOf } from './fence.js';

/** The advisory lock key: an arbitrary constant no other part of the platform uses. */
export const RECOVERY_LOCK_KEY = 4_851_002_026;

export type LockedRun<T> = { ran: true; value: T } | { ran: false };

export interface RecoveryLock {
  /** Runs `fn` while holding the lock; resolves `{ ran: false }` without running it when another pass holds it. */
  tryRun<T>(fn: () => Promise<T>): Promise<LockedRun<T>>;
}

/** The lock on a dedicated client from a node-postgres pool: production and the Postgres e2e tests. */
export function poolRecoveryLock(pool: Pick<pg.Pool, 'connect'>): RecoveryLock {
  return {
    async tryRun<T>(fn: () => Promise<T>): Promise<LockedRun<T>> {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        const locked = await client.query<{ locked: boolean }>(
          'select pg_try_advisory_lock($1::bigint) as locked',
          [RECOVERY_LOCK_KEY],
        );
        if (!locked.rows[0]?.locked) return { ran: false };
        try {
          return { ran: true, value: await fn() };
        } finally {
          await client
            .query('select pg_advisory_unlock($1::bigint)', [RECOVERY_LOCK_KEY])
            .catch((err: Error) => {
              // A connection that cannot unlock is discarded, which releases the lock.
              broken = err;
            });
        }
      } finally {
        client.release(broken);
      }
    },
  };
}

/**
 * The lock on the pool behind the worker's Drizzle client: drizzle(pool)
 * keeps the node-postgres pool as `$client` (DatabaseService.db). Throws for
 * any other client, PGlite included: pass sessionRecoveryLock there.
 */
export function drizzlePoolRecoveryLock(db: AppDb): RecoveryLock {
  const client: unknown = Reflect.get(db, '$client');
  if (!(client instanceof pg.Pool)) {
    throw new Error(
      'the database client is not a node-postgres pool; pass a RecoveryLock explicitly',
    );
  }
  return poolRecoveryLock(client);
}

/**
 * The lock through a client with a single connection (PGlite in the unit
 * tests), where every statement runs in the same session. Never use it on a
 * pool: lock and unlock could land on different connections.
 */
export function sessionRecoveryLock(db: AppDb): RecoveryLock {
  return {
    async tryRun<T>(fn: () => Promise<T>): Promise<LockedRun<T>> {
      const [row] = rowsOf<{ locked: boolean }>(
        await db.execute(
          sql`select pg_try_advisory_lock(${sql.raw(String(RECOVERY_LOCK_KEY))}::bigint) as locked`,
        ),
      );
      if (!row?.locked) return { ran: false };
      try {
        return { ran: true, value: await fn() };
      } finally {
        await db.execute(
          sql`select pg_advisory_unlock(${sql.raw(String(RECOVERY_LOCK_KEY))}::bigint)`,
        );
      }
    },
  };
}
