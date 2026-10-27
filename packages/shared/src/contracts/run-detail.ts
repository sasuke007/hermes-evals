/**
 * View models for the run inspector (plan sections 8 and 9, UI_FLOWS 18):
 * GET /runs/:id; its timeline and GET /runs/:id/events are in
 * ./run-timeline.ts. Secret values never appear: the launch record shows
 * the run token as ‹run token, revoked› and MCP secret values as
 * `<from env NAME>`.
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
  ARTIFACT_ROOTS,
  ARTIFACT_SKIP_REASONS,
  MCP_TRANSPORTS,
  SCORER_TYPES,
  SKILL_LOADING_MODES,
  TRAJECTORY_MODES,
} from '../vocab.js';
import { countView, isoTimeView, rateView, secondsView, sha256View, usdView } from './common.js';
import { ExperimentConfigRefSchema } from './experiments.js';
import { RunEvaluationViewSchema, RunModelNeedsSchema, TokenCountsSchema } from './runs.js';
import { TimelineViewSchema } from './run-timeline.js';
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
  /**
   * The last lines of stderr (at most 40), and how many lines the full log
   * has; "Full log" reads the whole stderr.log (AttemptStderr, ./run-output.ts).
   */
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
// Final response, artifacts and launch record
// ---------------------------------------------------------------------------

/** What the inspector says above an unfenced answer (Phase 8 G5). */
export const UNFENCED_ANSWER_NOTE =
  'Unfenced answer: the reply was one JSON object without a ```json fence.';

export const FinalResponseViewSchema = z
  .object({
    /** The final text Hermes recorded, verbatim. Never rebuilt from streamed pieces. */
    text: z.string(),
    /** Range of the JSON body the scorer parsed, as the API stores it; null when no block was found. */
    extracted: TextSpanSchema.nullable(),
    /** Range of the whole fenced block, fences included: what JsonBlock highlights. Null when unfenced. */
    fence: TextSpanSchema.nullable(),
    extraction: z.enum(['found', 'missing', 'invalid']),
    /**
     * The answer is the whole trimmed reply, one JSON object without a
     * ```json fence (ExtractedAnswer `unfenced`, Phase 8 G5): the inspector
     * shows UNFENCED_ANSWER_NOTE, and `extracted` is the trimmed reply.
     */
    unfenced: z.boolean(),
    parsed: JsonValueSchema.nullable(),
    parseError: z.object({ message: z.string(), position: countView.nullable() }).nullable(),
    /** The task's reference answer (inspector only, labelled hidden from the agent). */
    reference: JsonValueSchema,
    /** One-line explanation under the reference, when the design gives one. */
    referenceNote: z.string().nullable(),
  })
  .superRefine((view, ctx) => {
    if (view.unfenced && (view.extraction !== 'found' || view.fence !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['unfenced'],
        message: 'only a found answer without a fence is unfenced',
      });
    }
  });
export type FinalResponseView = z.infer<typeof FinalResponseViewSchema>;

/** A home seed's origin: only an artifact with root `home` can carry one. */
const HOME_SEED_ORIGINS: ReadonlySet<string> = new Set([
  'home_seed_unchanged',
  'home_seed_modified',
]);

export const ArtifactViewSchema = z
  .object({
    id: z.string(),
    /**
     * Which directory it was collected from (Phase 6 P2): the inspector's
     * Files tab draws `home` artifacts (the agent's memory files) in a
     * Memory group of their own.
     */
    root: z.enum(ARTIFACT_ROOTS),
    /** Relative to the trial root, so it starts with the root: `workspace/summary.csv`, `home/memories/MEMORY.md`. */
    path: z.string(),
    /** Fixtures and documents label workspace files; home seeds label home files. */
    origin: z.enum(ARTIFACT_ORIGINS),
    sizeBytes: countView,
    /** Null when the content was not stored (skippedReason). */
    sha256: sha256View.nullable(),
    skippedReason: z.enum(ARTIFACT_SKIP_REASONS).nullable(),
    preview: TablePreviewSchema.nullable(),
  })
  .superRefine((a, ctx) => {
    if (!a.path.startsWith(`${a.root}/`)) {
      ctx.addIssue({ code: 'custom', path: ['path'], message: `path must start with ${a.root}/` });
    }
    if (a.origin !== 'agent' && HOME_SEED_ORIGINS.has(a.origin) !== (a.root === 'home')) {
      ctx.addIssue({
        code: 'custom',
        path: ['origin'],
        message: `origin ${a.origin} does not belong to root ${a.root}`,
      });
    }
  });
export type ArtifactView = z.infer<typeof ArtifactViewSchema>;

export const ArtifactsViewSchema = z.object({
  items: z.array(ArtifactViewSchema),
  /** e.g. "partial · written before the cancel". */
  note: z.string().nullable(),
  /**
   * True when no workspace artifact has origin `agent`: "The agent wrote no
   * files in its workspace". Memory files in the home do not count.
   */
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
  /**
   * How the skills reached the agent (Phase 6 P5): `-s` per skill, or the
   * `skills` toolset. `preload` for records from before Phase 6, which all
   * preloaded.
   */
  skillLoading: z.enum(SKILL_LOADING_MODES),
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
  /**
   * The task's home seeds copied into the home before the run (Phase 6 P1,
   * the launch record's inputs of source `home_seed`), relative to the home:
   * `memories/MEMORY.md` is /opt/data/memories/MEMORY.md in the trial. Empty
   * when the task has none.
   */
  homeSeeds: z.array(z.object({ path: z.string(), sha256: sha256View })),
  /**
   * config.yaml's background review intervals (Phase 6 P3): user turns
   * between memory reviews and tool iterations between skill reviews; 0 is
   * off. Null on records from before Phase 6, which left Hermes's defaults
   * implicit.
   */
  backgroundReview: z
    .object({ memoryNudgeInterval: countView, skillCreationNudgeInterval: countView })
    .nullable(),
  /**
   * Memory in the home (Phase 8 G9, the record's `home_memory`): with memory
   * off the task's home seeds were not copied in (`seedsSkipped`) and
   * home/memories was not collected. Null on records from before Phase 8,
   * which seeded and collected either way.
   */
  homeMemory: z
    .object({
      memoryEnabled: z.boolean(),
      seedsSkipped: z.array(z.string()),
      memoriesCollected: z.boolean(),
    })
    .nullable(),
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
