/**
 * Worker processes. Each process start inserts a new row and heartbeats it
 * every 10 s. A worker counts as connected when it has not stopped and its
 * heartbeat is under 30 s old; attempts of a worker silent for 2 minutes are
 * recovered as `worker_lost`.
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { emptyTextArray, id, tstz } from './_columns.js';

export const workers = pgTable(
  'workers',
  {
    id: id(),
    /** For display only; not unique across restarts. */
    hostname: text('hostname').notNull(),
    startedAt: tstz('started_at').notNull().defaultNow(),
    lastHeartbeatAt: tstz('last_heartbeat_at').notNull().defaultNow(),
    /** Set on graceful shutdown. */
    stoppedAt: tstz('stopped_at'),
    /** WORKER_CONCURRENCY: how many Hermes processes this worker runs at once. */
    concurrency: integer('concurrency').notNull(),
    inFlight: integer('in_flight').notNull().default(0),
    hermesVersion: text('hermes_version').notNull(),
    /** Full git sha of the installed Hermes. */
    hermesRevision: text('hermes_revision').notNull(),
    /** Toolset names the installed Hermes offers, read at worker start. */
    toolsets: text('toolsets').array().notNull().default(emptyTextArray),
    /** Names of the variables in the worker environment. Never values. */
    envNames: text('env_names').array().notNull().default(emptyTextArray),
  },
  (t) => [
    index('workers_last_heartbeat_idx').on(t.lastHeartbeatAt),
    check('workers_concurrency_ck', sql`${t.concurrency} between 1 and 16`),
    check('workers_in_flight_ck', sql`${t.inFlight} >= 0`),
    check('workers_hermes_revision_ck', sql`${t.hermesRevision} ~ '^[0-9a-f]{40}$'`),
  ],
);
