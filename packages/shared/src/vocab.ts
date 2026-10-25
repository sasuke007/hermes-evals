/**
 * Closed vocabularies other than statuses. Each list is enforced by a CHECK
 * constraint in the database, so adding a value needs a new migration.
 */

/**
 * The eight scorer types a task's verification list may use. `text_match`
 * was added in Phase 3 (migration 0006 widens scores_type_ck); it is last so
 * the order of the seven older types, and so of SCORER_VERSIONS, is kept.
 */
export const SCORER_TYPES = [
  'numeric_tolerance',
  'json_match',
  'exact_match',
  'file_check',
  'trajectory_match',
  'verifier_script',
  'llm_judge',
  'text_match',
] as const;
export type ScorerType = (typeof SCORER_TYPES)[number];

/**
 * How trajectory_match compares a whole trajectory with openevals when its
 * params set `mode` (plan 9.3); without one it counts calls. Here rather than
 * in suite-files.ts because score evidence (records.ts) records it too.
 */
export const TRAJECTORY_MODES = ['strict', 'unordered', 'subset', 'superset'] as const;
export type TrajectoryMode = (typeof TRAJECTORY_MODES)[number];

/** Model providers a configuration may name. `custom` requires a base URL. */
export const PROVIDERS = [
  'nous',
  'nous-api',
  'openrouter',
  'openai',
  'anthropic',
  'custom',
] as const;
export type Provider = (typeof PROVIDERS)[number];

export const MCP_TRANSPORTS = ['stdio', 'http'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

/** The `type` column of run_events: the five Hermes stream-json events plus our own. */
export const RUN_EVENT_TYPES = [
  'system',
  'text',
  'tool_use',
  'tool_result',
  'result',
  'platform',
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/**
 * Subtypes of `platform` events, which the worker writes itself. Stored in the
 * payload, so no CHECK depends on this list. `network` is one entry of the
 * attempt's egress connection log (UI_FLOWS 19 #6; payload in records.ts).
 */
export const PLATFORM_EVENT_SUBTYPES = [
  'started',
  'killed',
  'cancelled',
  'collected',
  'worker_lost',
  'noise',
  'unmapped',
  'network',
] as const;
export type PlatformEventSubtype = (typeof PLATFORM_EVENT_SUBTYPES)[number];

/**
 * What a `network` platform event records, as egress logs it per attempt:
 * `connect` a CONNECT tunnel through the forward proxy, `http` a plain-HTTP
 * request through it, `model` a model gateway call, `mcp` a call through the
 * MCP gateway (plan 5.3).
 */
export const NETWORK_EVENT_KINDS = ['connect', 'http', 'model', 'mcp'] as const;
export type NetworkEventKind = (typeof NETWORK_EVENT_KINDS)[number];

/** Egress's decision on one connection or call. */
export const NETWORK_DECISIONS = ['allowed', 'denied'] as const;
export type NetworkDecision = (typeof NETWORK_DECISIONS)[number];

/**
 * Where a file found in the workspace after a run came from. Inputs are the
 * task's fixtures and the configuration's documents; anything else the agent wrote.
 */
export const ARTIFACT_ORIGINS = [
  'fixture_unchanged',
  'fixture_modified',
  'document_unchanged',
  'document_modified',
  'agent',
] as const;
export type ArtifactOrigin = (typeof ARTIFACT_ORIGINS)[number];

/**
 * Why a file was recorded without storing its content: larger than one
 * artifact may be (25 MiB), or past the attempt's collection budget (the
 * files collected before it already used it up).
 */
export const ARTIFACT_SKIP_REASONS = ['too_large', 'over_budget'] as const;
export type ArtifactSkipReason = (typeof ARTIFACT_SKIP_REASONS)[number];

/**
 * Files the suite loader copies into the blob store for each task. Only
 * fixtures ever reach a trial; `expected` is the hidden known-good workspace
 * that file-checking verifiers are validated against when the suite loads.
 */
export const TASK_FILE_KINDS = ['fixture', 'verifier', 'rubric', 'expected'] as const;
export type TaskFileKind = (typeof TASK_FILE_KINDS)[number];

/** Result of the last load of one suite directory. */
export const SUITE_LOAD_OUTCOMES = [
  'created',
  'unchanged',
  'reverted',
  'error',
  'missing',
] as const;
export type SuiteLoadOutcome = (typeof SUITE_LOAD_OUTCOMES)[number];
