/**
 * Worker processes. Each process start inserts a new row and heartbeats it
 * every 10 s. A worker counts as connected when it has not stopped and its
 * heartbeat is under 60 s old (WORKER_TIMEOUT_MS in the web contract);
 * attempts of a worker silent for 2 minutes are recovered as `worker_lost`.
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { emptyTextArray, id, jsonValue, oneOf, tstz } from './_columns.js';
import { WORKER_SANDBOX_STATES, type WorkerSandbox } from './worker-sandbox.js';

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
    /**
     * How many trial slot networks this worker has (its TRIAL_SLOTS), the
     * total the System page shows as "2 of 4". Null on rows written before
     * workers reported it.
     */
    slots: integer('slots'),
    /**
     * Trials this worker is running now, each on one slot: the "2" of "2 of
     * 4". The execute-run handler (Phase 2) keeps it current; nothing runs a
     * trial on a slot before then (an MCP test has no network).
     */
    inFlight: integer('in_flight').notNull().default(0),
    hermesVersion: text('hermes_version').notNull(),
    /** Full git sha of the installed Hermes. */
    hermesRevision: text('hermes_revision').notNull(),
    /** Toolset names the installed Hermes offers, read at worker start. */
    toolsets: text('toolsets').array().notNull().default(emptyTextArray),
    /** Names of the variables in the worker environment. Never values. */
    envNames: text('env_names').array().notNull().default(emptyTextArray),
    /**
     * Names of the variables in the egress environment, which holds the
     * values of http MCP headers (plan 5.3). Asked for over the egress admin
     * socket at start and on each heartbeat. Never values.
     */
    egressEnvNames: text('egress_env_names').array().notNull().default(emptyTextArray),
    /** Last isolation self-test this worker ran; null until it has run one. */
    sandbox: jsonValue<WorkerSandbox>('sandbox'),
  },
  (t) => [
    index('workers_last_heartbeat_idx').on(t.lastHeartbeatAt),
    check('workers_concurrency_ck', sql`${t.concurrency} between 1 and 16`),
    check('workers_in_flight_ck', sql`${t.inFlight} >= 0`),
    check('workers_slots_ck', sql`${t.slots} is null or ${t.slots} between 1 and 64`),
    check('workers_hermes_revision_ck', sql`${t.hermesRevision} ~ '^[0-9a-f]{40}$'`),
    check(
      'workers_sandbox_ck',
      sql`${t.sandbox} is null or (jsonb_typeof(${t.sandbox}) = 'object' and ${oneOf(sql`(${t.sandbox} ->> 'state')`, WORKER_SANDBOX_STATES)})`,
    ),
  ],
);
