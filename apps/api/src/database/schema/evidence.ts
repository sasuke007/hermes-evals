/**
 * Evidence an attempt leaves behind: the event stream and the files in the
 * workspace. Both are append-only, and nothing can be added once the attempt
 * has finished (enforced by triggers).
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  ARTIFACT_ORIGINS,
  ARTIFACT_ROOTS,
  ARTIFACT_SKIP_REASONS,
  HOME_MEMORIES_DIR,
  RUN_EVENT_TYPES,
  type ArtifactOrigin,
  type ArtifactRoot,
  type ArtifactSkipReason,
  type RunEventPayload,
  type RunEventType,
} from '@hermes-evals/shared';
import { blobs } from './blobs.js';
import { attempts } from './experiments.js';
import { id, isRelativePath, jsonValue, nullOrOneOf, oneOf } from './_columns.js';

/**
 * Every line Hermes printed on stdout, in order, plus the worker's own
 * `platform` events (started, killed, cancelled, collected). The worker that
 * owns the attempt numbers events 1, 2, 3... with no gaps.
 */
export const runEvents = pgTable(
  'run_events',
  {
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id),
    seq: integer('seq').notNull(),
    /** Epoch milliseconds: the event's own timestamp, or receipt time for platform events. */
    ts: bigint('ts', { mode: 'number' }).notNull(),
    type: text('type').$type<RunEventType>().notNull(),
    payload: jsonValue<RunEventPayload>('payload').notNull(),
  },
  (t) => [
    primaryKey({ name: 'run_events_pk', columns: [t.attemptId, t.seq] }),
    check('run_events_seq_ck', sql`${t.seq} >= 1`),
    check('run_events_type_ck', oneOf(t.type, RUN_EVENT_TYPES)),
    check(
      'run_events_payload_type_ck',
      // IS NOT DISTINCT FROM: a payload with no string `type` must fail, not pass as NULL.
      sql`(${t.payload} ->> 'type') is not distinct from ${t.type}`,
    ),
  ],
);

/** Origins that only an artifact collected from the home can have (Phase 6 P2). */
const HOME_SEED_ORIGINS = ARTIFACT_ORIGINS.filter((o) => o.startsWith('home_seed_'));

/**
 * A file found in the workspace, or in the home's `memories/`, when the
 * attempt ended. Content lives in the blob store at DATA_DIR/blobs/<sha256>;
 * identical files share one copy. Files over 25 MB are listed with
 * `skipped_reason` and no content.
 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: id(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id),
    /**
     * The trial directory it was collected from (Phase 6 P2, migration 0008):
     * `workspace`, or `home`, of which only `memories/` is collected. Every
     * artifact stored before Phase 6 is a workspace file.
     */
    root: text('root').$type<ArtifactRoot>().notNull().default('workspace'),
    /**
     * Relative to its root, e.g. `summary.csv` or `docs/policy.pdf` in the
     * workspace, `memories/MEMORY.md` in the home.
     */
    path: text('path').notNull(),
    origin: text('origin').$type<ArtifactOrigin>().notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').references(() => blobs.sha256),
    skippedReason: text('skipped_reason').$type<ArtifactSkipReason>(),
  },
  (t) => [
    // One file per path and root: `memories/MEMORY.md` may exist in both.
    uniqueIndex('artifacts_attempt_root_path_uq').on(t.attemptId, t.root, t.path),
    check('artifacts_root_ck', oneOf(t.root, ARTIFACT_ROOTS)),
    check('artifacts_origin_ck', oneOf(t.origin, ARTIFACT_ORIGINS)),
    // Home seeds label home files, fixtures and documents workspace files; anything may be the agent's.
    check(
      'artifacts_origin_root_ck',
      sql`${t.origin} = 'agent' or (${t.root} = 'home') = (${oneOf(t.origin, HOME_SEED_ORIGINS)})`,
    ),
    // Only the home's memories/ is collected.
    check(
      'artifacts_home_path_ck',
      sql`${t.root} <> 'home' or ${t.path} like ${sql.raw(`'${HOME_MEMORIES_DIR}/%'`)}`,
    ),
    check('artifacts_skipped_reason_ck', nullOrOneOf(t.skippedReason, ARTIFACT_SKIP_REASONS)),
    check('artifacts_content_ck', sql`(${t.sha256} is null) = (${t.skippedReason} is not null)`),
    check('artifacts_sha256_ck', sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('artifacts_size_ck', sql`${t.size} >= 0`),
    check('artifacts_path_ck', isRelativePath(t.path)),
  ],
);
