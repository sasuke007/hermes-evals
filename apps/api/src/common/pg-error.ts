/**
 * Reads the Postgres error under whatever wraps it. Drizzle 0.45 wraps driver
 * errors in DrizzleQueryError with the original as `cause`; node-postgres and
 * PGlite both put the SQLSTATE in `code` and the constraint name, when there
 * is one, in `constraint`. Services use this to answer the races their own
 * checks cannot see; the global DatabaseErrorFilter uses it for the rest.
 */

/** SQLSTATE codes the API reads: integrity violations it answers as client errors, and deadlocks. */
export const SQLSTATE = {
  /** Raised by the 0001 integrity triggers: a frozen or immutable row was changed. */
  restrictViolation: '23001',
  foreignKeyViolation: '23503',
  uniqueViolation: '23505',
  checkViolation: '23514',
  /** Postgres aborted one transaction of a lock cycle; running it again succeeds. */
  deadlockDetected: '40P01',
} as const;

export interface PgErrorFields {
  code: string;
  /** The constraint that refused the write; absent for a trigger's own RAISE. */
  constraint?: string;
  /** Postgres's message: a trigger's text, or "… violates … constraint …". */
  message: string;
  table?: string;
}

const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/;
/** Deep enough for Drizzle's wrapper around the driver error, with room to spare. */
const MAX_DEPTH = 5;

/** The Postgres error in `err` or its causes, or null when there is none. */
export function pgError(err: unknown): PgErrorFields | null {
  for (
    let e: unknown = err, depth = 0;
    e && typeof e === 'object' && depth < MAX_DEPTH;
    depth += 1
  ) {
    const { code, constraint, message, table, cause } = e as {
      code?: unknown;
      constraint?: unknown;
      message?: unknown;
      table?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string' && SQLSTATE_PATTERN.test(code)) {
      return {
        code,
        constraint: typeof constraint === 'string' ? constraint : undefined,
        message: typeof message === 'string' ? message : '',
        table: typeof table === 'string' ? table : undefined,
      };
    }
    e = cause;
  }
  return null;
}
