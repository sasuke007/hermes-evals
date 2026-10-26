/**
 * How many Postgres 17 e2e files run at once (vitest.config.e2e.ts), from
 * the throwaway server's own `max_connections`.
 *
 * Each full-application spec boots the api and one or more workers, each
 * with an app pool and a pg-boss pool of up to 10 connections, plus its own
 * pool. Measured on 26 Oct 2026 (Phase 7, pg_stat_activity sampled every
 * 0.5 s), the heaviest peak at: phase2 36, phase3 29, phase5b 28, phase6 27,
 * phase4 26. Four at a time reached 105 sampled on the default 100-connection
 * server, and the specs then failed on "sorry, too many clients already"
 * (SQLSTATE 53300) as a 500 from whichever request lost: the Phase 5b
 * question 22 failures, on the committed Phase 5b tree as on this one. So a
 * file is given about 45 connections: 2 at a time on the default server, 4
 * on one started with `-c max_connections=200`.
 */
import pg from 'pg';

/** Connections one file may hold at its peak, with room for pool bursts between samples. */
export const CONNECTIONS_PER_FILE = 45;
/** The most files at once, whatever the server allows. */
export const MAX_E2E_WORKERS = 4;
/** When the server cannot be asked: what the default 100-connection server takes. */
const DEFAULT_MAX_CONNECTIONS = 100;

/** Files at once for a server allowing `maxConnections` (null: not known). */
export function e2eWorkers(maxConnections: number | null): number {
  const allowed = maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  return Math.max(1, Math.min(MAX_E2E_WORKERS, Math.floor(allowed / CONNECTIONS_PER_FILE)));
}

/**
 * The server's `max_connections`, or null when TEST_DATABASE_URL is missing,
 * unreadable or names port 5432 (the Compose database, never asked; the
 * globalSetup in ./require-database.ts refuses those runs with the reason).
 */
export async function serverMaxConnections(url: string | undefined): Promise<number | null> {
  if (!url) return null;
  let port: string;
  try {
    port = new URL(url).port || '5432';
  } catch {
    return null;
  }
  if (port === '5432') return null;
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3_000 });
  try {
    await client.connect();
    const result = await client.query<{ max_connections: string }>('show max_connections');
    const value = Number(result.rows[0]?.max_connections);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  } finally {
    await client.end().catch(() => undefined);
  }
}
