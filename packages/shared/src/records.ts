/**
 * Shapes of the JSON columns in the database. The API and worker parse with
 * these schemas before writing; the Drizzle columns are typed from them.
 *
 * Rules for every schema here:
 * - JSON round-trip stable: no transforms, no Date objects, no bigint.
 *   Timestamps are ISO strings, durations are milliseconds.
 * - Additive evolution only. Evidence rows and frozen snapshots are never
 *   rewritten, so a field added later must be optional, not defaulted.
 */
import { z } from 'zod';
import {
  ATTEMPT_TRIGGERS,
  EXECUTION_ERROR_CATEGORIES,
  SCORE_STATUSES,
  VERDICT_CAUSES,
  VERDICTS,
} from './status.js';
import {
  MCP_TRANSPORTS,
  NETWORK_DECISIONS,
  NETWORK_EVENT_KINDS,
  PLATFORM_EVENT_SUBTYPES,
  SCORER_TYPES,
} from './vocab.js';

const isoTime = z.iso.datetime({ offset: true });
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();

/** Any JSON value. Used for reference answers and scorer expected/observed values. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const isJsonValue = (value: unknown): boolean => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value as object).every(isJsonValue)
  );
};

/**
 * Validates without rebuilding the value, so it returns exactly what
 * JSON.parse produced. z.json() rebuilds objects and drops a `__proto__` key.
 */
export const JsonValueSchema = z.custom<JsonValue>(isJsonValue, { message: 'not a JSON value' });

// ---------------------------------------------------------------------------
// Suites and tasks
// ---------------------------------------------------------------------------

export const TaskLimitsSchema = z.object({
  max_turns: z.number().int().min(1).max(200),
  run_budget_seconds: z.number().int().min(30).max(3600),
  /** Informational; shown on the task detail page. */
  toolsets_needed: z.array(z.string()),
});
export type TaskLimits = z.infer<typeof TaskLimitsSchema>;

/** One entry of a task's `verification` list. Params are validated per scorer type. */
export const VerificationEntrySchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  type: z.enum(SCORER_TYPES),
  primary: z.boolean(),
  params: z.record(z.string(), z.unknown()),
});
export type VerificationEntry = z.infer<typeof VerificationEntrySchema>;

export const SelfCheckResultSchema = z.object({
  key: z.string(),
  type: z.enum(SCORER_TYPES),
  /**
   * `answer` checks reference.json as if it were the agent's answer; `script`
   * runs a verifier; `workspace` runs file_check or a verifier against the
   * hidden expected workspace (fixtures overlaid with `expected/`); `none` is
   * schema-only (trajectory_match, llm_judge).
   */
  mode: z.enum(['answer', 'script', 'workspace', 'none']),
  /**
   * `fail` marks a negative control: the same check run against the untouched
   * fixtures, which must not pass, or the verifier would pass any agent.
   */
  expect: z.enum(['pass', 'fail']).optional(),
  status: z.enum([...SCORE_STATUSES, 'skipped']),
  score: z.number().min(0).max(1).nullable(),
  comment: z.string(),
  duration_ms: count.optional(),
  argv: z.array(z.string()).optional(),
  exit_code: z.number().int().nullable().optional(),
  timed_out: z.boolean().optional(),
  stdout_tail: z.string().optional(),
  stderr_tail: z.string().optional(),
});
export type SelfCheckResult = z.infer<typeof SelfCheckResultSchema>;

export const SelfCheckSchema = z.object({
  /** `skipped` when the task has load errors, so no check could run. */
  status: z.enum(['passed', 'failed', 'error', 'skipped']),
  ran_at: isoTime.nullable(),
  duration_ms: count.nullable(),
  results: z.array(SelfCheckResultSchema),
  /** Files of the hidden expected workspace the checks ran against, when the task has one. */
  expected_workspace: z.array(z.object({ path: z.string(), sha256: sha256Hex })).optional(),
});
export type SelfCheck = z.infer<typeof SelfCheckSchema>;

export const LoadIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.enum([
    'yaml_invalid',
    'schema_invalid',
    'primary_count',
    'duplicate_key',
    'unknown_type',
    'params_invalid',
    'file_missing',
    'prompt_no_fenced_json',
    /** reference.json is missing or is not valid JSON. */
    'reference_invalid',
    /** A symlink, special file or oversized file in the task folder; never read. */
    'unsafe_file',
    /** A check that cannot be self-checked as declared, e.g. file_check without an expected workspace. */
    'self_check_unsupported',
  ]),
  /** Verification key the issue belongs to, when it belongs to one. */
  key: z.string().optional(),
  /** File or YAML path, e.g. `task.yaml#verification[1].params.path`. */
  path: z.string().optional(),
  message: z.string(),
});
export type LoadIssue = z.infer<typeof LoadIssueSchema>;

export const SuiteLoadErrorSchema = z.object({
  file: z.string(),
  line: z.number().int().nullable(),
  column: z.number().int().nullable(),
  message: z.string(),
  excerpt: z.string().nullable(),
});
export type SuiteLoadError = z.infer<typeof SuiteLoadErrorSchema>;

/** Task keys that changed relative to the previously current version of a suite. */
export const SuiteChangesSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  /** Tasks present in both versions whose own content hash differs. */
  changed: z.array(z.string()),
  now_invalid: z.array(z.string()),
  now_valid: z.array(z.string()),
});
export type SuiteChanges = z.infer<typeof SuiteChangesSchema>;

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const McpToolSchema = z.object({ name: z.string(), description: z.string().optional() });

/** An environment variable name, as MCP definitions and configurations reference secrets. */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * One header of an http MCP server: the header name and the environment
 * variable that holds its value. Egress reads the value from its own
 * environment and adds the header on the way to the server (plan 5.3);
 * the value never enters a trial.
 */
export const McpHeaderSchema = z.object({
  header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  env: z.string().regex(ENV_NAME_PATTERN),
});
export type McpHeader = z.infer<typeof McpHeaderSchema>;

/** Result of the last "Test start" of one MCP server version. Never holds secret values. */
export const McpTestStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('untested') }),
  z.object({ status: z.literal('running'), job_id: z.string(), requested_at: isoTime }),
  z.object({
    status: z.literal('passed'),
    job_id: z.string(),
    requested_at: isoTime,
    finished_at: isoTime,
    started_ms: count,
    tools: z.array(McpToolSchema),
  }),
  z.object({
    status: z.literal('failed'),
    job_id: z.string(),
    requested_at: isoTime,
    finished_at: isoTime,
    started_ms: count.optional(),
    error: z.string(),
    stderr_tail: z.string().optional(),
    /** Env or header variable names the worker (stdio) or egress (http) lacks. Names only. */
    missing_secret_names: z.array(z.string()),
  }),
]);
export type McpTestState = z.infer<typeof McpTestStateSchema>;

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

export const ModelPriceSchema = z.object({
  input_per_1m: z.number().nonnegative(),
  output_per_1m: z.number().nonnegative(),
  cache_read_per_1m: z.number().nonnegative().optional(),
  cache_write_per_1m: z.number().nonnegative().optional(),
  /** Date the price was last checked against the provider, YYYY-MM-DD. */
  checked_at: z.string(),
});

/** Snapshot of config/prices.yaml taken when an experiment launches. */
export const PriceTableSchema = z.object({
  sha256: sha256Hex,
  loaded_at: isoTime,
  models: z.record(z.string(), ModelPriceSchema),
});
export type PriceTable = z.infer<typeof PriceTableSchema>;

/** What the New experiment form showed at launch, kept to compare with actual cost. */
export const ExperimentEstimateSchema = z.object({
  runs: count,
  duration_s: count,
  cost_usd: z.number().nonnegative().nullable(),
  basis: z.enum(['history', 'budget']),
});
export type ExperimentEstimate = z.infer<typeof ExperimentEstimateSchema>;

/** Why the circuit breaker stopped an experiment. */
export const ExperimentFailureSchema = z.object({
  at: isoTime,
  threshold: z.number().int().positive(),
  category: z.enum(EXECUTION_ERROR_CATEGORIES),
  exit_code: z.number().int().nullable(),
  message: z.string(),
  stderr_first_line: z.string().nullable(),
  attempt_id: z.string(),
  run_id: z.string(),
});
export type ExperimentFailure = z.infer<typeof ExperimentFailureSchema>;

/** One verdict computation for one candidate, appended on completion, retry or re-score. */
export const VerdictEntrySchema = z.object({
  at: isoTime,
  cause: z.enum(VERDICT_CAUSES),
  candidate_version_id: z.string(),
  /** Score key the verdict is computed on; the task's primary key by default. */
  key: z.string(),
  delta: z.number().nullable(),
  lo: z.number().nullable(),
  hi: z.number().nullable(),
  verdict: z.enum([...VERDICTS, 'not_computable']),
  /** Set when verdict is `not_computable`, e.g. `single_repetition`. */
  reason: z.string().nullable(),
});
export type VerdictEntry = z.infer<typeof VerdictEntrySchema>;

// ---------------------------------------------------------------------------
// Attempts and evidence
// ---------------------------------------------------------------------------

export const TokensSchema = z.object({
  input: count,
  output: count,
  total: count,
  cache_read: count,
  cache_write: count,
});
export type Tokens = z.infer<typeof TokensSchema>;

/**
 * Everything needed to reproduce an attempt by hand. Written once, before
 * Hermes is spawned. Secret values never appear: env vars are listed by name
 * and config_yaml has MCP env and header values replaced by `<from env NAME>`.
 */
/**
 * The trial container as the worker created it (plan 8.2): its name, image,
 * slot network, user, limits, mounts, disk cap and every variable it got, by
 * name. Kept beside the launch record so the inspector shows the container
 * this attempt really ran in, not today's defaults.
 */
export const LaunchContainerRecordSchema = z.object({
  name: z.string(),
  image: z.string(),
  network: z.string(),
  user: z.string(),
  read_only_root: z.literal(true),
  limits: z.object({
    memory_mib: z.number().int(),
    cpus: z.number(),
    pids: z.number().int(),
    tmp_mib: z.number().int(),
  }),
  mounts: z.array(z.object({ volume: z.string(), subpath: z.string(), target: z.string() })),
  disk_cap: z.object({ bytes: z.number().int(), files: z.number().int() }),
  stop_grace_seconds: z.number().int(),
  /** Unix seconds after which recovery stops the container even without its worker. */
  deadline_unix: z.number().int(),
  /** Every variable the container gets, by name; values never. */
  env_names: z.array(z.string()),
});
export type LaunchContainerRecord = z.infer<typeof LaunchContainerRecordSchema>;

export const LaunchRecordSchema = z.object({
  argv: z.array(z.string()),
  cwd: z.string(),
  /** Closed allowlist of non-secret variables, recorded verbatim. */
  env: z.object({ HERMES_HOME: z.string(), HOME: z.string(), PATH: z.string() }),
  /** Variables passed to the process whose values are secret. Names only. */
  secret_env_names: z.array(z.string()),
  config_path: z.string(),
  config_yaml: z.string(),
  skills: z.array(
    z.object({
      skill_id: z.string(),
      name: z.string(),
      version: z.string(),
      content_hash: sha256Hex,
    }),
  ),
  mcp_servers: z.array(
    z.object({
      mcp_server_version_id: z.string(),
      name: z.string(),
      version: z.number().int(),
      transport: z.enum(MCP_TRANSPORTS),
      definition_hash: sha256Hex,
    }),
  ),
  /** Files copied into the workspace before the run, used to label artifacts. */
  inputs: z.array(
    z.object({
      path: z.string(),
      sha256: sha256Hex,
      source: z.enum(['fixture', 'document']),
      document_id: z.string().optional(),
    }),
  ),
  limits: z.object({
    max_turns: z.number().int(),
    run_budget_seconds: z.number().int(),
    /** Budget plus 60 s grace plus 10 s before SIGKILL. */
    deadline_seconds: z.number().int(),
  }),
  hermes: z.object({ version: z.string(), revision: z.string() }),
  /**
   * The slot network the trial ran on, and the container as created. Read
   * leniently: a record without them, or with a block an earlier runner
   * wrote differently, still parses, and the inspector falls back per field
   * to the trial defaults.
   */
  network: z.string().optional().catch(undefined),
  container: LaunchContainerRecordSchema.optional().catch(undefined),
});
export type LaunchRecord = z.infer<typeof LaunchRecordSchema>;

/**
 * The answer pulled out of the agent's final text: the last fenced JSON block.
 * Offsets are UTF-16 code-unit indices into the final text, half-open, and
 * bound the block body only. `missing` and `invalid` make answer keys ungradable.
 */
export const ExtractedAnswerSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('missing'), block_count: z.literal(0) }),
  z.object({
    status: z.literal('found'),
    block_count: z.number().int().positive(),
    start: count,
    end: count,
    value: JsonValueSchema,
  }),
  z.object({
    status: z.literal('invalid'),
    block_count: z.number().int().positive(),
    start: count,
    end: count,
    error: z.string(),
    /** Absolute offset of the parse error in the final text, when known. */
    position: count.nullable(),
  }),
]);
export type ExtractedAnswer = z.infer<typeof ExtractedAnswerSchema>;

/**
 * One entry of an attempt's egress connection log, stored as a `platform`
 * event with subtype `network` (plan 8.3, UI_FLOWS 19 #6): every connection
 * the trial attempted, allowed or refused, and every model and MCP gateway
 * call. Loose, so fields egress adds later are kept. Absent fields were not
 * known for that kind (a model call has no port; a refused CONNECT has no
 * status). Values are never secret: egress logs hosts and outcomes, not
 * headers or bodies.
 */
export const NetworkEventPayloadSchema = z.looseObject({
  type: z.literal('platform'),
  subtype: z.literal('network'),
  kind: z.enum(NETWORK_EVENT_KINDS),
  /** Target host as the trial named it; the MCP server's host for `mcp`. */
  host: z.string().optional(),
  port: z.number().int().min(0).max(65_535).optional(),
  decision: z.enum(NETWORK_DECISIONS),
  /** Why egress refused it, or a note on an allowed call, e.g. `private address`. */
  reason: z.string().optional(),
  /** HTTP status egress or the upstream answered, for `http`, `model` and `mcp`. */
  status: z.number().int().optional(),
  /** How long the connection or call took. */
  ms: count.optional(),
  /** Model the call named, for `model`. */
  model: z.string().optional(),
  /** MCP server name (the `/mcp/<name>` route), for `mcp`. */
  server: z.string().optional(),
  /**
   * True for Hermes's own baseline traffic rather than an agent action, such
   * as the credits-seed pricing fetch every `nous` run makes (plan 8.2). The
   * inspector labels these rows as Hermes background calls.
   */
  background: z.boolean(),
});
export type NetworkEventPayload = z.infer<typeof NetworkEventPayloadSchema>;

/** Platform subtypes whose payload has no fields of its own beyond what the worker adds. */
const PLAIN_PLATFORM_SUBTYPES = PLATFORM_EVENT_SUBTYPES.filter(
  (subtype): subtype is Exclude<(typeof PLATFORM_EVENT_SUBTYPES)[number], 'network'> =>
    subtype !== 'network',
);

/** A `platform` event: a network log entry, or one of the worker's other subtypes. */
export const PlatformEventPayloadSchema = z.discriminatedUnion('subtype', [
  NetworkEventPayloadSchema,
  z.looseObject({ type: z.literal('platform'), subtype: z.enum(PLAIN_PLATFORM_SUBTYPES) }),
]);
export type PlatformEventPayload = z.infer<typeof PlatformEventPayloadSchema>;

/**
 * Payload of one run event. Hermes events keep every field they arrive with;
 * platform events carry a subtype. A line that matches neither is stored as
 * a platform event with subtype `noise` (not JSON) or `unmapped` (unknown type).
 */
export const RunEventPayloadSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('system') }),
  z.looseObject({ type: z.literal('text'), text: z.string() }),
  z.looseObject({ type: z.literal('tool_use'), name: z.string() }),
  z.looseObject({ type: z.literal('tool_result'), name: z.string() }),
  z.looseObject({ type: z.literal('result') }),
  PlatformEventPayloadSchema,
]);
export type RunEventPayload = z.infer<typeof RunEventPayloadSchema>;

/** Pointers from a score to the evidence behind it, plus scorer-specific detail. */
export const ScoreEvidenceSchema = z.object({
  event_seqs: z.array(z.number().int()).optional(),
  artifact_ids: z.array(z.string()).optional(),
  judge: z
    .object({
      provider: z.string(),
      base_url: z.string(),
      model: z.string(),
      calls: z.number().int().positive(),
      tokens: TokensSchema.partial({ cache_read: true, cache_write: true }),
      cost_usd: z.number().nonnegative().nullable(),
      latency_ms: count,
    })
    .optional(),
  script: z
    .object({
      argv: z.array(z.string()),
      exit_code: z.number().int().nullable(),
      timed_out: z.boolean(),
      duration_ms: count,
      stdout_line: z.string().nullable(),
      stdout_tail: z.string(),
      stderr_tail: z.string(),
    })
    .optional(),
  /** Set when status is `error`: a short message plus the technical detail line. */
  error: z.object({ message: z.string(), detail: z.string().nullable() }).optional(),
});
export type ScoreEvidence = z.infer<typeof ScoreEvidenceSchema>;

/** The `trigger` carried by every execute-run job and copied onto the attempt. */
export const AttemptTriggerSchema = z.enum(ATTEMPT_TRIGGERS);
