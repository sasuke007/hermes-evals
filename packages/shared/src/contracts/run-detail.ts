/**
 * View models for the run inspector (plan sections 8 and 9, UI_FLOWS 18):
 * GET /runs/:id and GET /runs/:id/events. Secret values never appear: the
 * launch record shows the run token as ‹run token, revoked› and MCP secret
 * values as `<from env NAME>`.
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { JsonMatchEvidenceSchema, JsonValueSchema, TextMatchEvidenceSchema } from '../records.js';
import {
  ATTEMPT_STATUSES,
  ATTEMPT_TRIGGERS,
  EXECUTION_ERROR_CATEGORIES,
  RUN_STATUSES,
  SCORE_STATUSES,
} from '../status.js';
import {
  ARTIFACT_ORIGINS,
  ARTIFACT_SKIP_REASONS,
  MCP_TRANSPORTS,
  NETWORK_DECISIONS,
  NETWORK_EVENT_KINDS,
  SCORER_TYPES,
  TRAJECTORY_MODES,
} from '../vocab.js';
import { countView, isoTimeView, rateView, secondsView, sha256View, usdView } from './common.js';
import { ExperimentConfigRefSchema } from './experiments.js';
import { RunEvaluationViewSchema, RunModelNeedsSchema, TokenCountsSchema } from './runs.js';
import { SuiteVersionRefSchema, TablePreviewSchema } from './suites.js';

const executionErrorCategory = z.enum(EXECUTION_ERROR_CATEGORIES);

/** A run_events sequence number; the first event of an attempt is 1. */
const seq = z.number().int().positive();

/** A half-open UTF-16 range [start, end) of a text. */
export const TextSpanSchema = z
  .object({ start: countView, end: countView })
  .refine((s) => s.end >= s.start, { message: 'end is before start', path: ['end'] });
export type TextSpan = z.infer<typeof TextSpanSchema>;

// ---------------------------------------------------------------------------
// Attempts and outcome
// ---------------------------------------------------------------------------

export const AttemptViewSchema = z.object({
  number: z.number().int().positive(),
  trigger: z.enum(ATTEMPT_TRIGGERS),
  /** Attempt outcome, or `scored` for the attempt whose scores are shown. */
  status: z.enum([...ATTEMPT_STATUSES, 'scored']),
  category: executionErrorCategory.nullable(),
  startedAt: isoTimeView,
  durationS: secondsView.nullable(),
  exitCode: z.number().int().nullable(),
  /** False for a provider lapse retried after resume: no attempt counted against the run. */
  countsAgainstRun: z.boolean(),
});
export type AttemptView = z.infer<typeof AttemptViewSchema>;

/** The ErrorBanner that replaces Outcome when execution failed. */
export const ExecutionErrorViewSchema = z.object({
  category: executionErrorCategory,
  /** One-line reason, e.g. "No final response within the 300 s time budget." */
  reason: z.string(),
  /** Detail under the reason, e.g. "stopped at 310 s". */
  meta: z.string().nullable(),
  /** Longer explanation of what the agent was doing and what to try. */
  explanation: z.string().nullable(),
  /** The last lines of stderr (at most 40), and how many lines the full log has. */
  stderrTail: z.object({ lines: z.array(z.string()).max(40), totalLines: countView }),
  exitCode: z.number().int().nullable(),
});
export type ExecutionErrorView = z.infer<typeof ExecutionErrorViewSchema>;

const summaryDetail = z.object({ summary: z.string(), detail: z.string().nullable() });

/**
 * The LLM judge's call behind an llm_judge score (JudgeEvidenceSchema in
 * records.ts, Phase 3 question 5): its model and its grading cost, which is
 * apart from the run's execution cost and never counted by the spend guard.
 */
export const JudgeEvidenceViewSchema = z.object({
  /** A PROVIDERS value, from the check or JUDGE_PROVIDER. */
  provider: z.string(),
  /** A `custom` judge's base URL; null for the providers egress routes by name. */
  baseUrl: z.string().nullable(),
  model: z.string(),
  /** 1, or 2 when the first call failed in transport or with a 5xx and was retried. */
  calls: z.number().int().positive(),
  /** Summed over the calls, as egress metered them. */
  tokens: TokenCountsSchema,
  /** Null when the judge model has no price in the experiment's frozen table. */
  costUsd: usdView.nullable(),
  latencyMs: countView,
  /** The provider's finish reason of the graded answer, e.g. `stop`; null when not reported. */
  finishReason: z.string().nullable(),
  /**
   * Each call in order (Phase 3 question 9): the HTTP status that ended it,
   * null when it failed in transport, and how long it took. Empty for rows
   * stored before calls were logged.
   */
  callLog: z.array(
    z.object({ status: z.number().int().min(100).max(599).nullable(), latencyMs: countView }),
  ),
});
export type JudgeEvidenceView = z.infer<typeof JudgeEvidenceViewSchema>;

/**
 * What trajectory_match counted (TrajectoryEvidenceSchema in records.ts):
 * calls of `tool`, and of those the ones whose arguments matched, by their
 * tool_use sequence numbers. With `mode`, openevals compared the whole
 * trajectory and `calls` is the number of tool calls in it.
 */
export const TrajectoryEvidenceViewSchema = z.object({
  tool: z.string(),
  calls: countView,
  matchedSeqs: z.array(seq),
  mode: z.enum(TRAJECTORY_MODES).nullable(),
});
export type TrajectoryEvidenceView = z.infer<typeof TrajectoryEvidenceViewSchema>;

/**
 * Pointers from a score to the evidence behind it, and the scorer's own
 * detail for the Outcome section: null when the key's type does not write
 * it, or the stored row predates it. `text` and `jsonMatch` are the stored
 * shapes as they are (records.ts).
 */
export const ScoreEvidenceViewSchema = z.object({
  eventSeqs: z.array(seq),
  artifactIds: z.array(z.string()),
  /** llm_judge. */
  judge: JudgeEvidenceViewSchema.nullable(),
  /** trajectory_match: "invoice-db.list_invoices called 3 times". */
  trajectory: TrajectoryEvidenceViewSchema.nullable(),
  /** text_match: "Found 1 of 2: `1.5%` ✓ `30 days` ✗". */
  text: TextMatchEvidenceSchema.nullable(),
  /** json_match: "4 of 5 keys match", with each mismatch's path. */
  jsonMatch: JsonMatchEvidenceSchema.nullable(),
});
export type ScoreEvidenceView = z.infer<typeof ScoreEvidenceViewSchema>;

/** One score row in Outcome. */
export const ScoreRowViewSchema = z.object({
  key: z.string(),
  type: z.enum(SCORER_TYPES),
  primary: z.boolean(),
  /** VerificationSentence in compact form, e.g. "json_match on duplicates, unordered". */
  sentence: z.string(),
  status: z.enum(SCORE_STATUSES),
  score: rateView.nullable(),
  /** Short summary and optional detail lines, e.g. "2 pairs" / "[INV-1042, INV-1107]". */
  expected: summaryDetail.nullable(),
  observed: summaryDetail.nullable(),
  comment: z.string(),
  /** Set when status is `error`: what failed, with the request in mono. */
  error: z.object({ message: z.string(), detail: z.string().nullable() }).nullable(),
  evidence: ScoreEvidenceViewSchema,
});
export type ScoreRowView = z.infer<typeof ScoreRowViewSchema>;

/** The banner above the score rows for ungradable or scorer-error results. */
export const OutcomeNoticeSchema = z.object({
  kind: z.enum(['ungradable', 'error']),
  title: z.string(),
  detail: z.string(),
  /** Failed request, shown in mono (score error). */
  request: z.string().nullable(),
  key: z.string(),
});
export type OutcomeNotice = z.infer<typeof OutcomeNoticeSchema>;

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

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

/** One row of EventTimeline and one tick of TimelineScrubber. */
export const TimelineEventSchema = z
  .object({
    seq,
    kind: TimelineEventKindSchema,
    /** `hermes-background` for Hermes's own requests (drawn neutral, tagged). */
    origin: z.enum(['agent', 'hermes-background']),
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
    /** Output cut by the runtime at 5,000 characters. */
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

// ---------------------------------------------------------------------------
// Final response, artifacts and launch record
// ---------------------------------------------------------------------------

export const FinalResponseViewSchema = z.object({
  /** The final text Hermes recorded, verbatim. Never rebuilt from streamed pieces. */
  text: z.string(),
  /** Range of the JSON body the scorer parsed, as the API stores it; null when no block was found. */
  extracted: TextSpanSchema.nullable(),
  /** Range of the whole fenced block, fences included: what JsonBlock highlights. */
  fence: TextSpanSchema.nullable(),
  extraction: z.enum(['found', 'missing', 'invalid']),
  parsed: JsonValueSchema.nullable(),
  parseError: z.object({ message: z.string(), position: countView.nullable() }).nullable(),
  /** The task's reference answer (inspector only, labelled hidden from the agent). */
  reference: JsonValueSchema,
  /** One-line explanation under the reference, when the design gives one. */
  referenceNote: z.string().nullable(),
});
export type FinalResponseView = z.infer<typeof FinalResponseViewSchema>;

export const ArtifactViewSchema = z.object({
  id: z.string(),
  /** Relative to the trial root: `workspace/summary.csv`. */
  path: z.string(),
  origin: z.enum(ARTIFACT_ORIGINS),
  sizeBytes: countView,
  /** Null when the content was not stored (skippedReason). */
  sha256: sha256View.nullable(),
  skippedReason: z.enum(ARTIFACT_SKIP_REASONS).nullable(),
  preview: TablePreviewSchema.nullable(),
});
export type ArtifactView = z.infer<typeof ArtifactViewSchema>;

export const ArtifactsViewSchema = z.object({
  items: z.array(ArtifactViewSchema),
  /** e.g. "partial · written before the cancel". */
  note: z.string().nullable(),
  /** True when no artifact has origin `agent`: "The agent wrote no files …". */
  agentWroteNothing: z.boolean(),
});
export type ArtifactsView = z.infer<typeof ArtifactsViewSchema>;

/** The trial container, as launched. */
export const LaunchContainerViewSchema = z.object({
  image: z.string(),
  /** Image digest, possibly shortened for display. */
  digest: z.string(),
  /** "hermes-agent v0.22.4 @ 4d04303". */
  hermes: z.string(),
  network: z.string(),
  user: z.string(),
  imageFilesystem: z.string(),
  limits: z.object({
    memory: z.string(),
    cpus: z.number().positive(),
    processes: z.number().int().positive(),
    tmp: z.string(),
  }),
  mounts: z.array(z.object({ name: z.string(), target: z.string() })),
  diskCap: z.object({ bytes: countView, files: countView }),
  worker: z.object({
    name: z.string(),
    startedAt: isoTimeView,
    exitCode: z.number().int().nullable(),
  }),
  skills: z.array(z.object({ name: z.string(), version: z.string(), contentHash: sha256View })),
  mcpServers: z.array(
    z.object({
      name: z.string(),
      version: z.number().int().positive(),
      transport: z.enum(MCP_TRANSPORTS),
      /** The server's config.yaml entry, secret values as `<from env NAME>`. */
      definition: z.string(),
    }),
  ),
});
export type LaunchContainerView = z.infer<typeof LaunchContainerViewSchema>;

export const LaunchRecordViewSchema = z.object({
  container: LaunchContainerViewSchema,
  /** The command verbatim, with the run token shown as ‹run token, revoked›. */
  command: z.string(),
  commandNote: z.string().nullable(),
  configPath: z.string(),
  /** /opt/data/config.yaml verbatim (MCP secret values replaced by `<from env NAME>`). */
  configYaml: z.string(),
  configNote: z.string().nullable(),
});
export type LaunchRecordView = z.infer<typeof LaunchRecordViewSchema>;

/** The same task and repetition under the other configuration (the A/B jump). */
export const CounterpartViewSchema = z.object({
  runId: z.string().nullable(),
  /** Configuration name. */
  configuration: z.string(),
  status: z.enum(RUN_STATUSES).nullable(),
  /** Disabled reason, e.g. "Counterpart run is not scored yet (running)". Null when available. */
  unavailableReason: z.string().nullable(),
});
export type CounterpartView = z.infer<typeof CounterpartViewSchema>;

// ---------------------------------------------------------------------------
// The whole detail
// ---------------------------------------------------------------------------

/** GET /runs/:id: header, attempts, outcome, timeline, final response, artifacts, launch record. */
export const RunDetailSchema = z.object({
  id: z.string(),
  experimentId: z.string(),
  experimentName: z.string(),
  suite: SuiteVersionRefSchema,
  task: z.object({ key: z.string(), version: z.number().int().positive(), summary: z.string() }),
  configuration: ExperimentConfigRefSchema,
  repetition: z.number().int().positive(),
  status: z.enum(RUN_STATUSES),
  /** Attempts so far, and the one shown (always the current attempt); 0 before the first. */
  attemptCount: countView,
  shownAttempt: countView,
  attempts: z.array(AttemptViewSchema),
  primary: z.object({ key: z.string(), status: z.enum(SCORE_STATUSES).nullable() }),
  startedAt: isoTimeView.nullable(),
  finishedAt: isoTimeView.nullable(),
  durationS: secondsView.nullable(),
  /** True when the duration is the whole budget ("300 s (budget)"). */
  durationIsBudget: z.boolean(),
  tokens: TokenCountsSchema.nullable(),
  costUsd: usdView.nullable(),
  limits: z.object({
    maxTurns: z.number().int().positive(),
    budgetS: z.number().int().positive(),
  }),
  /** Running only. */
  live: z.object({ elapsedS: secondsView, turn: countView }).nullable(),
  cancelled: z
    .object({ at: isoTimeView, by: z.enum(['experiment', 'user']), ranForS: secondsView })
    .nullable(),
  executionError: ExecutionErrorViewSchema.nullable(),
  outcomeNotice: OutcomeNoticeSchema.nullable(),
  /** The evaluation `scores` come from, and a re-score in flight or failed (plan 9.4). */
  evaluation: RunEvaluationViewSchema,
  scores: z.array(ScoreRowViewSchema),
  timeline: TimelineViewSchema,
  finalResponse: FinalResponseViewSchema.nullable(),
  artifacts: ArtifactsViewSchema,
  /** The shown attempt's launch record; null before the first attempt starts (a queued run). */
  launchRecord: LaunchRecordViewSchema.nullable(),
  counterpart: CounterpartViewSchema.nullable(),
  needs: RunModelNeedsSchema,
});
export type RunDetail = z.infer<typeof RunDetailSchema>;
