/**
 * Live updates over server-sent events (plan section 11, UI_FLOWS 14 and 19
 * #9). Each event is small enough for the web to patch its store in place;
 * for anything an event does not carry the page refetches the view model.
 *
 * Wire format: one SSE message per event, `event: <type>` and
 * `data: <the whole event as JSON>`, so a client can listen by name or parse
 * every message with the union. The web's useSse validates each with these
 * schemas and reconnects with backoff 1, 2, 5, 10 s.
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { EXPERIMENT_STATUSES, RUN_STATUSES } from '../status.js';
import { countView, isoTimeView } from './common.js';
import {
  ExperimentFailureViewSchema,
  ExperimentSpendSchema,
  FeedEntrySchema,
  PauseReasonSchema,
  RunCountsSchema,
} from './experiments.js';
import { PrimaryScoreViewSchema } from './runs.js';
import { SystemSummarySchema } from './system.js';

// ---------------------------------------------------------------------------
// GET /system/events
// ---------------------------------------------------------------------------

/** The running summary and worker presence, sent on connect and every 5 s. */
export const SystemEventSchema = z.object({
  type: z.literal('summary'),
  /** When the API read it. */
  at: isoTimeView,
  summary: SystemSummarySchema,
});
export type SystemEvent = z.infer<typeof SystemEventSchema>;

// ---------------------------------------------------------------------------
// GET /experiments/:id/events
// ---------------------------------------------------------------------------

/**
 * A run changed status, attempt or score: patch the Runs tab row, the
 * comparison cell and the inspector header in place (rows never reorder while
 * live).
 */
export const RunStatusEventSchema = z.object({
  type: z.literal('run'),
  at: isoTimeView,
  runId: z.string(),
  status: z.enum(RUN_STATUSES),
  /** The run's attempt count (RunRow.attempts); 0 until the first attempt starts. */
  attempt: countView,
  /** The primary key's result once scored; null otherwise. */
  primaryScore: PrimaryScoreViewSchema.nullable(),
  finishedAt: isoTimeView.nullable(),
});
export type RunStatusEvent = z.infer<typeof RunStatusEventSchema>;

/** Run counts, the progress bar and spend changed: patch the header and the list row. */
export const CountsEventSchema = z.object({
  type: z.literal('counts'),
  at: isoTimeView,
  counts: RunCountsSchema,
  /** As ExperimentListRow.doneRuns. */
  doneRuns: countView,
  spend: ExperimentSpendSchema,
});
export type CountsEvent = z.infer<typeof CountsEventSchema>;

/**
 * The experiment changed status (paused, resumed, failed, completed). The page
 * refetches GET /experiments/:id for what changes with it (aggregates, times).
 */
export const ExperimentStatusEventSchema = z
  .object({
    type: z.literal('experiment'),
    at: isoTimeView,
    status: z.enum(EXPERIMENT_STATUSES),
    pauseReason: PauseReasonSchema.nullable(),
    failure: ExperimentFailureViewSchema.nullable(),
  })
  .superRefine((e, ctx) => {
    if ((e.status === 'paused') !== (e.pauseReason !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['pauseReason'],
        message: 'pauseReason is set exactly when the experiment is paused',
      });
    }
    if ((e.status === 'failed') !== (e.failure !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['failure'],
        message: 'failure is set exactly when the experiment failed',
      });
    }
  });
export type ExperimentStatusEvent = z.infer<typeof ExperimentStatusEventSchema>;

/** A run finished (scored or execution_error): prepend to "Latest completions". */
export const FeedEventSchema = z.object({
  type: z.literal('feed'),
  at: isoTimeView,
  entry: FeedEntrySchema,
});
export type FeedEvent = z.infer<typeof FeedEventSchema>;

/** One event of GET /experiments/:id/events (a shared poller per experiment reads Postgres every 1 s). */
export const ExperimentEventSchema = z.discriminatedUnion('type', [
  RunStatusEventSchema,
  CountsEventSchema,
  ExperimentStatusEventSchema,
  FeedEventSchema,
]);
export type ExperimentEvent = z.infer<typeof ExperimentEventSchema>;

export type ExperimentEventType = ExperimentEvent['type'];

/** The `event:` names of the experiment stream. */
export const EXPERIMENT_EVENT_TYPES = [
  'run',
  'counts',
  'experiment',
  'feed',
] as const satisfies readonly ExperimentEventType[];
