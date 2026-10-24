/**
 * View models for runs: the Runs tab table and the run inspector drawer
 * (plan sections 8.4, 9 and 11). See src/api/types/suites.ts for the
 * conventions shared by every types file.
 */
import type {
  ArtifactOrigin,
  AttemptStatus,
  AttemptTrigger,
  ExecutionErrorCategory,
  JsonValue,
  McpTransport,
  Provider,
  RunStatus,
  ScoreStatus,
  ScorerType,
} from '@hermes-evals/shared';
import type { ExperimentConfigRef } from './experiments';
import type { SuiteVersionRef, TablePreview } from './suites';

export interface TokenCounts {
  input: number;
  output: number;
  total: number;
}

/** What a model-needing action on a run requires, for BlockedReason. */
export interface RunModelNeeds {
  /** Provider the run's configuration uses: Retry execution needs it connected. */
  provider: Provider;
  /** llm_judge keys of the task: Re-score needs the judge's provider for them. */
  judgeKeys: string[];
  judgeProvider: Provider | null;
}

// ---------------------------------------------------------------------------
// Runs tab
// ---------------------------------------------------------------------------

export type RunSortKey =
  | 'task'
  | 'configuration'
  | 'repetition'
  | 'attempts'
  | 'status'
  | 'score'
  | 'duration'
  | 'tokens'
  | 'cost'
  | 'finished';

/** Runs tab filters and sort; mirrored in the URL query by the page. */
export interface RunFilters {
  /** Configuration name or version id; omitted or `all` for every configuration. */
  configuration?: string;
  task?: string;
  status?: RunStatus;
  scoreStatus?: ScoreStatus;
  hasExecutionError?: boolean;
  ungradable?: boolean;
  sort?: RunSortKey;
  dir?: 'asc' | 'desc';
}

export interface RunRow {
  id: string;
  experimentId: string;
  taskKey: string;
  taskVersion: number;
  configuration: ExperimentConfigRef;
  repetition: number;
  attempts: number;
  status: RunStatus;
  /** The primary key's result; null until scored and for execution_error or cancelled runs. */
  primaryScore: { key: string; status: ScoreStatus; score: number | null } | null;
  /** Set when status is execution_error. */
  executionErrorCategory: ExecutionErrorCategory | null;
  durationS: number | null;
  tokens: TokenCounts | null;
  costUsd: number | null;
  finishedAt: string | null;
  needs: RunModelNeeds;
}

/** Counts over the whole experiment for the count line and its shortcut chips. */
export interface RunSummaryCounts {
  total: number;
  passed: number;
  failed: number;
  error: number;
  ungradable: number;
  executionErrors: number;
}

export interface RunListResult {
  rows: RunRow[];
  /** Rows matching the filters (equals rows.length; pagination comes later). */
  matched: number;
  summary: RunSummaryCounts;
}

/** Result of a bulk Re-score or Retry execution. */
export interface BulkRunActionResult {
  action: 'rescore' | 'retry';
  enqueued: string[];
  /** Runs that could not be enqueued, each with the reason the ErrorBanner names. */
  refused: { runId: string; reason: string }[];
}

/** Result of a single-run action from the inspector. */
export interface RunActionResult {
  runId: string;
  status: RunStatus;
  /** For retry: the attempt that was created. */
  attempt: number | null;
}

// ---------------------------------------------------------------------------
// Run inspector
// ---------------------------------------------------------------------------

export interface AttemptView {
  number: number;
  trigger: AttemptTrigger;
  /** Attempt outcome, or `scored` for the attempt whose scores are shown. */
  status: AttemptStatus | 'scored';
  category: ExecutionErrorCategory | null;
  startedAt: string;
  durationS: number | null;
  exitCode: number | null;
  /** False for a provider lapse retried after resume: no attempt counted against the run. */
  countsAgainstRun: boolean;
}

/** The ErrorBanner that replaces Outcome when execution failed. */
export interface ExecutionErrorView {
  category: ExecutionErrorCategory;
  /** One-line reason, e.g. "No final response within the 300 s time budget." */
  reason: string;
  /** Detail under the reason, e.g. "stopped at 310 s". */
  meta: string | null;
  /** Longer explanation of what the agent was doing and what to try. */
  explanation: string | null;
  /** The last lines of stderr (at most 40), and how many lines the full log has. */
  stderrTail: { lines: string[]; totalLines: number };
  exitCode: number | null;
}

/** One score row in Outcome. */
export interface ScoreRowView {
  key: string;
  type: ScorerType;
  primary: boolean;
  /** VerificationSentence in compact form, e.g. "json_match on duplicates, unordered". */
  sentence: string;
  status: ScoreStatus;
  score: number | null;
  /** Short summary and optional detail lines, e.g. "2 pairs" / "[INV-1042, INV-1107]". */
  expected: { summary: string; detail: string | null } | null;
  observed: { summary: string; detail: string | null } | null;
  comment: string;
  /** Set when status is `error`: what failed, with the request in mono. */
  error: { message: string; detail: string | null } | null;
  evidence: { eventSeqs: number[]; artifactIds: string[] };
}

/** The banner above the score rows for ungradable or scorer-error results. */
export interface OutcomeNotice {
  kind: 'ungradable' | 'error';
  title: string;
  detail: string;
  /** Failed request, shown in mono (score error). */
  request: string | null;
  key: string;
}

export type TimelineEventKind = 'tool' | 'text' | 'final' | 'network' | 'refused' | 'platform';

/** One row of EventTimeline and one tick of TimelineScrubber. */
export interface TimelineEvent {
  seq: number;
  kind: TimelineEventKind;
  /** `hermes-background` for Hermes's own requests (drawn neutral, tagged). */
  origin: 'agent' | 'hermes-background';
  /** Milliseconds since the attempt started; pages show "+00:04.2". */
  atMs: number;
  title: string;
  /** MCP server name when the tool comes from one (drawn with its prefix tag). */
  server: string | null;
  summary: string;
  durationMs: number | null;
  error: boolean;
  /** Still running (live timeline). */
  running: boolean;
  /** Tool input, verbatim JSON text. */
  input: string | null;
  output: string | null;
  outputChars: number | null;
  /** Output cut by the runtime at 5,000 characters. */
  truncated: boolean;
  /** Free text for text, final, network and platform rows. */
  text: string | null;
  /** Model call detail for network rows. */
  network: {
    method: string;
    url: string;
    status: number;
    model: string;
    tokensIn: number;
    tokensOut: number;
    forwardedTo: string | null;
  } | null;
  /** A connection the sandbox refused: its own row (background) or a sub-row on a tool call. */
  refusal: { host: string; port: number; reason: string } | null;
}

export interface TimelineView {
  events: TimelineEvent[];
  /** True while the run executes: events append live. */
  live: boolean;
  /** Events recorded in total (the list virtualises above 200). */
  totalEvents: number;
}

export interface FinalResponseView {
  /** The final text Hermes recorded, verbatim. Never rebuilt from streamed pieces. */
  text: string;
  /**
   * Character range (UTF-16, half-open) of the JSON body the scorer parsed, as the API stores
   * it; null when no block was found.
   */
  extracted: { start: number; end: number } | null;
  /** Range of the whole fenced block, fences included: what JsonBlock highlights. */
  fence: { start: number; end: number } | null;
  extraction: 'found' | 'missing' | 'invalid';
  parsed: JsonValue | null;
  parseError: { message: string; position: number | null } | null;
  /** The task's reference answer (inspector only, labelled hidden from the agent). */
  reference: JsonValue;
  /** One-line explanation under the reference, when the design gives one. */
  referenceNote: string | null;
}

export interface ArtifactView {
  id: string;
  path: string;
  origin: ArtifactOrigin;
  sizeBytes: number;
  sha256: string | null;
  skippedReason: 'too_large' | null;
  preview: TablePreview | null;
}

export interface ArtifactsView {
  items: ArtifactView[];
  /** e.g. "partial · written before the cancel". */
  note: string | null;
  /** True when no artifact has origin `agent`: "The agent wrote no files …". */
  agentWroteNothing: boolean;
}

/** The trial container, as launched. */
export interface LaunchContainerView {
  image: string;
  digest: string;
  hermes: string;
  network: string;
  user: string;
  imageFilesystem: string;
  limits: { memory: string; cpus: number; processes: number; tmp: string };
  mounts: { name: string; target: string }[];
  diskCap: { bytes: number; files: number };
  worker: { name: string; startedAt: string; exitCode: number | null };
  skills: { name: string; version: string; contentHash: string }[];
  mcpServers: { name: string; version: number; transport: McpTransport; definition: string }[];
}

export interface LaunchRecordView {
  container: LaunchContainerView;
  /** The command verbatim, with the run token shown as ‹run token, revoked›. */
  command: string;
  commandNote: string | null;
  configPath: string;
  /** /opt/data/config.yaml verbatim (MCP secret values replaced by `<from env NAME>`). */
  configYaml: string;
  configNote: string | null;
}

/** The same task and repetition under the other configuration (the A/B jump). */
export interface CounterpartView {
  runId: string | null;
  configuration: string;
  status: RunStatus | null;
  /** Disabled reason, e.g. "Counterpart run is not scored yet (running)". Null when available. */
  unavailableReason: string | null;
}

export interface RunDetail {
  id: string;
  experimentId: string;
  experimentName: string;
  suite: SuiteVersionRef;
  task: { key: string; version: number; summary: string };
  configuration: ExperimentConfigRef;
  repetition: number;
  status: RunStatus;
  /** Attempts so far, and the one shown (always the current attempt). */
  attemptCount: number;
  shownAttempt: number;
  attempts: AttemptView[];
  primary: { key: string; status: ScoreStatus | null };
  startedAt: string | null;
  finishedAt: string | null;
  durationS: number | null;
  /** True when the duration is the whole budget ("300 s (budget)"). */
  durationIsBudget: boolean;
  tokens: TokenCounts | null;
  costUsd: number | null;
  limits: { maxTurns: number; budgetS: number };
  /** Running only. */
  live: { elapsedS: number; turn: number } | null;
  cancelled: { at: string; by: 'experiment' | 'user'; ranForS: number } | null;
  executionError: ExecutionErrorView | null;
  outcomeNotice: OutcomeNotice | null;
  scores: ScoreRowView[];
  timeline: TimelineView;
  finalResponse: FinalResponseView | null;
  artifacts: ArtifactsView;
  launchRecord: LaunchRecordView;
  counterpart: CounterpartView | null;
  needs: RunModelNeeds;
}

export interface RunEventsPage {
  events: TimelineEvent[];
  /** Pass as `after` to fetch the next events. */
  lastSeq: number;
  live: boolean;
}
