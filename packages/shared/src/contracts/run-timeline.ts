/**
 * The run inspector's timeline (plan section 8, UI_FLOWS 18): the events of
 * GET /runs/:id/events and the timeline GET /runs/:id starts with. Split
 * from ./run-detail.ts in Phase 8.
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { NETWORK_DECISIONS, NETWORK_EVENT_KINDS, type NetworkOrigin } from '../vocab.js';
import { countView } from './common.js';

/** A run_events sequence number; the first event of an attempt is 1. */
const seq = z.number().int().positive();

export const TIMELINE_EVENT_KINDS = [
  'tool',
  'text',
  'final',
  'network',
  'refused',
  'platform',
] as const;
export const TimelineEventKindSchema = z.enum(TIMELINE_EVENT_KINDS);
export type TimelineEventKind = z.infer<typeof TimelineEventKindSchema>;

/**
 * One entry of egress's connection log, as a timeline row shows it
 * (NetworkEventPayloadSchema in records.ts; Phase 2 question 4): a model
 * call, an MCP gateway call, a CONNECT tunnel or a plain-HTTP request.
 * Fields the log does not record for that kind are null: a CONNECT has no
 * URL or model, a refused connection no status, an MCP call no tokens.
 */
export const TimelineNetworkSchema = z.object({
  kind: z.enum(NETWORK_EVENT_KINDS),
  decision: z.enum(NETWORK_DECISIONS),
  /** `POST` for a model call; the MCP request's method; null for a CONNECT. */
  method: z.string().nullable(),
  /** The gateway URL the trial called (model, MCP); null for a CONNECT or a plain-HTTP target. */
  url: z.string().nullable(),
  /** Target host as the trial named it; the MCP server's host for `mcp`. */
  host: z.string().nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  /** MCP server name (the `/mcp/<name>` route), for `mcp`. */
  server: z.string().nullable(),
  /** HTTP status egress or the upstream answered; null when there was no answer. */
  status: z.number().int().min(100).max(599).nullable(),
  /** Why egress refused it, or its note on an allowed call. */
  reason: z.string().nullable(),
  /** Model the call named, for `model`. */
  model: z.string().nullable(),
  /** The call's own usage, for `model`, when the upstream reported it. */
  tokensIn: countView.nullable(),
  tokensOut: countView.nullable(),
  /** Where the model gateway sent it, e.g. `Nous Portal`, for `model`. */
  forwardedTo: z.string().nullable(),
});
export type TimelineNetwork = z.infer<typeof TimelineNetworkSchema>;

/** Row kinds drawn from egress's connection log; each carries `network`. */
const NETWORK_ROW_KINDS: readonly TimelineEventKind[] = ['network', 'refused'];

/**
 * Whose a timeline row is: the agent's, or Hermes's own background request
 * (drawn neutral, tagged "Hermes background"). The view's spelling of the
 * stored NETWORK_ORIGINS (vocab.ts), mapped by TIMELINE_ORIGIN_OF.
 */
export const TIMELINE_ORIGINS = ['agent', 'hermes-background'] as const;
export type TimelineOrigin = (typeof TIMELINE_ORIGINS)[number];

/** A network event's stored origin as a timeline row's origin. */
export const TIMELINE_ORIGIN_OF = {
  agent: 'agent',
  hermes_background: 'hermes-background',
} as const satisfies Record<NetworkOrigin, TimelineOrigin>;

/** One row of EventTimeline and one tick of TimelineScrubber. */
export const TimelineEventSchema = z
  .object({
    seq,
    kind: TimelineEventKindSchema,
    /** `hermes-background` for Hermes's own requests (drawn neutral, tagged). */
    origin: z.enum(TIMELINE_ORIGINS),
    /** Milliseconds since the attempt started; pages show "+00:04.2". */
    atMs: countView,
    title: z.string(),
    /** MCP server name when the tool comes from one (drawn with its prefix tag). */
    server: z.string().nullable(),
    summary: z.string(),
    durationMs: countView.nullable(),
    error: z.boolean(),
    /** Still running (live timeline). */
    running: z.boolean(),
    /** Tool input, verbatim JSON text. */
    input: z.string().nullable(),
    output: z.string().nullable(),
    outputChars: countView.nullable(),
    /**
     * Output cut at the timeline's window for the row
     * (timelineOutputLimit in ./run-output.ts: 20,000 characters for an MCP
     * tool's result, 5,000 for any other tool's), and marked so.
     */
    truncated: z.boolean(),
    /** Free text for text, final, network and platform rows. */
    text: z.string().nullable(),
    /**
     * The connection log entry behind a `network` or `refused` row, of any
     * kind; null on every other row. A refusal drawn as a sub-row of a tool
     * call is in `refusal`, not here.
     */
    network: TimelineNetworkSchema.nullable(),
    /** A connection the sandbox refused: its own row (background) or a sub-row on a tool call. */
    refusal: z
      .object({
        host: z.string(),
        port: z.number().int().min(1).max(65535),
        reason: z.string(),
      })
      .nullable(),
  })
  .superRefine((e, ctx) => {
    if (NETWORK_ROW_KINDS.includes(e.kind) !== (e.network !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['network'],
        message: 'network is set exactly on network and refused rows',
      });
    }
  });
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const TimelineViewSchema = z.object({
  events: z.array(TimelineEventSchema),
  /** True while the run executes: events append live. */
  live: z.boolean(),
  /** Events recorded in total (the list virtualises above 200). */
  totalEvents: countView,
});
export type TimelineView = z.infer<typeof TimelineViewSchema>;

/** Query of GET /runs/:id/events (`?after=`): events after a sequence number, from 0. */
export const RunEventsQuerySchema = z.object({
  after: z.coerce
    .number({ error: 'after is a sequence number' })
    .int('after is a whole number')
    .min(0, 'after is 0 or more')
    .default(0),
});
export type RunEventsQuery = z.infer<typeof RunEventsQuerySchema>;

/** GET /runs/:id/events?after=: the inspector polls it every 1 s while the run runs. */
export const RunEventsPageSchema = z.object({
  events: z.array(TimelineEventSchema),
  /**
   * Pass as `after` to fetch the next events; `after` itself when there are
   * none. A page holds the rows of at most a few thousand events: when more
   * follow, lastSeq is the last event of this page, so ask again with it.
   */
  lastSeq: countView,
  live: z.boolean(),
});
export type RunEventsPage = z.infer<typeof RunEventsPageSchema>;
