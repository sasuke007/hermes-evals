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
  ARTIFACT_SKIP_REASONS,
  RUN_EVENT_TYPES,
  type ArtifactOrigin,
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

/**
 * A file found in the workspace when the attempt ended. Content lives in the
 * blob store at DATA_DIR/blobs/<sha256>; identical files share one copy.
 * Files over 25 MB are listed with `skipped_reason` and no content.
 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: id(),
    attemptId: text('attempt_id')
      .notNull()
      .references(() => attempts.id),
    /** Relative to the workspace, e.g. `summary.csv` or `docs/policy.pdf`. */
    path: text('path').notNull(),
    origin: text('origin').$type<ArtifactOrigin>().notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256').references(() => blobs.sha256),
    skippedReason: text('skipped_reason').$type<ArtifactSkipReason>(),
  },
  (t) => [
    uniqueIndex('artifacts_attempt_path_uq').on(t.attemptId, t.path),
    check('artifacts_origin_ck', oneOf(t.origin, ARTIFACT_ORIGINS)),
    check('artifacts_skipped_reason_ck', nullOrOneOf(t.skippedReason, ARTIFACT_SKIP_REASONS)),
    check('artifacts_content_ck', sql`(${t.sha256} is null) = (${t.skippedReason} is not null)`),
    check('artifacts_sha256_ck', sql`${t.sha256} is null or ${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check('artifacts_size_ck', sql`${t.size} >= 0`),
    check('artifacts_path_ck', isRelativePath(t.path)),
  ],
);
