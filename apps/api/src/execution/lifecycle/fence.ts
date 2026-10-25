/**
 * Lease fencing (plan 1 invariant 9, plan 8.1). Every write the worker makes
 * to a running attempt carries `WHERE id = $a AND lease_token = $t AND
 * status = 'running' AND lease_revoked_at IS NULL`; zero rows means the
 * lease is gone (recovery revoked it, or the attempt already finished) and
 * the writer stops with LeaseLostError. The 0001/0004 insert triggers on
 * run_events and artifacts refuse the same cases with SQLSTATE 23001, which
 * covers a revoke that commits between the check and the insert.
 */
import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { pgError, SQLSTATE } from '../../common/pg-error.js';
import { storable } from '../../database/schema/_columns.js';
import { attempts } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { LeaseLostError, type AttemptEventInput } from '../contracts.js';

/** What identifies the owner of an attempt. */
export interface AttemptLease {
  attemptId: string;
  leaseToken: string;
}

/** The fence as a Drizzle condition on `attempts`. */
export const leaseHeld = (lease: AttemptLease): SQL =>
  and(
    eq(attempts.id, lease.attemptId),
    eq(attempts.leaseToken, lease.leaseToken),
    eq(attempts.status, 'running'),
    isNull(attempts.leaseRevokedAt),
  )!;

/** Rows of a raw `execute`, whose result shape differs by driver but always has `rows`. */
export const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;

/**
 * Runs a fenced write and turns a trigger refusal (the attempt finished or
 * was revoked in between) into LeaseLostError. Other errors pass through.
 */
export async function fencedWrite<T>(lease: AttemptLease, write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (pgError(err)?.code === SQLSTATE.restrictViolation) {
      throw new LeaseLostError(
        lease.attemptId,
        `attempt ${lease.attemptId} lost its lease: ${pgError(err)?.message}`,
      );
    }
    throw err;
  }
}

/**
 * JSON text for a jsonb parameter, made storable the way jsonValue columns
 * are (_columns.ts): strings and keys lose the characters Postgres refuses.
 */
export const storableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'string') return storable(item);
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).map(([k, v]) => [storable(k), v]));
    }
    return item;
  });

/**
 * Inserts events numbered firstSeq, firstSeq + 1, ... in one statement that
 * runs only while the lease is held. Throws LeaseLostError when it is not.
 * An empty list only checks the lease.
 */
export async function insertFencedEvents(
  db: AppDb,
  lease: AttemptLease,
  firstSeq: number,
  events: readonly AttemptEventInput[],
): Promise<void> {
  const guard = sql`exists (select 1 from attempts a where a.id = ${lease.attemptId}
    and a.lease_token = ${lease.leaseToken} and a.status = 'running' and a.lease_revoked_at is null)`;
  if (events.length === 0) {
    const [held] = rowsOf<{ held: boolean }>(await db.execute(sql`select ${guard} as held`));
    if (!held?.held) throw new LeaseLostError(lease.attemptId);
    return;
  }
  const values = events.map(
    (event, index) =>
      sql`(${firstSeq + index}::int, ${Math.trunc(event.ts)}::bigint, ${event.type}::text, ${storableJson(event.payload)}::jsonb)`,
  );
  const inserted = await fencedWrite(lease, () =>
    db.execute(sql`insert into run_events (attempt_id, seq, ts, type, payload)
      select ${lease.attemptId}, v.seq, v.ts, v.type, v.payload
        from (values ${sql.join(values, sql`, `)}) as v(seq, ts, type, payload)
       where ${guard}
      returning seq`),
  );
  if (rowsOf<{ seq: number }>(inserted).length !== events.length) {
    throw new LeaseLostError(lease.attemptId);
  }
}
