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

/** The comparison's selection that grades each task by its own primary key (the default). */
export const SCORE_KEY_PRIMARY = 'primary';
/** The comparison's selection under which a run passes only when none of its keys failed, errored or was ungradable. */
export const SCORE_KEY_ANY_FAILED = 'any_failed';

/**
 * Names no verification key may take (Phase 4 question 1): the comparison's
 * key select gives them a meaning of their own, so a check named either way
 * could never be selected by name. The suite loader refuses them through
 * VerificationKeySchema (records.ts), and the authoring editor uses the same
 * rule. Here beside the vocabularies, though no CHECK names them.
 */
export const RESERVED_SCORE_KEYS = [SCORE_KEY_PRIMARY, SCORE_KEY_ANY_FAILED] as const;
export type ReservedScoreKey = (typeof RESERVED_SCORE_KEYS)[number];

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
 * Where a file collected after a run came from. Inputs are the task's
 * fixtures and the configuration's documents in the workspace, and the
 * task's home seeds in the home (Phase 6 P2, migration 0008); anything else
 * the agent wrote. A `home_seed_*` origin belongs to an artifact with root
 * `home`, a fixture or document one to root `workspace` (artifacts_origin_root_ck).
 */
export const ARTIFACT_ORIGINS = [
  'fixture_unchanged',
  'fixture_modified',
  'document_unchanged',
  'document_modified',
  'home_seed_unchanged',
  'home_seed_modified',
  'agent',
] as const;
export type ArtifactOrigin = (typeof ARTIFACT_ORIGINS)[number];

/**
 * Which trial directory an artifact was collected from (Phase 6 P2,
 * migration 0008): the workspace, or the home, of which only `memories/` is
 * collected (the agent's MEMORY.md and USER.md). An artifact's path is
 * relative to its root, and a file_check names the root it reads.
 */
export const ARTIFACT_ROOTS = ['workspace', 'home'] as const;
export type ArtifactRoot = (typeof ARTIFACT_ROOTS)[number];

/**
 * Why a file was recorded without storing its content: larger than one
 * artifact may be (25 MiB), or past the attempt's collection budget (the
 * files collected before it already used it up).
 */
export const ARTIFACT_SKIP_REASONS = ['too_large', 'over_budget'] as const;
export type ArtifactSkipReason = (typeof ARTIFACT_SKIP_REASONS)[number];

/**
 * Files the suite loader copies into the blob store for each task. Only
 * fixtures (into the workspace) and home seeds (into the home's `memories/`)
 * ever reach a trial. `expected` is the hidden known-good workspace that
 * file-checking verifiers are validated against when the suite loads, and
 * `expected_home` the same for the home: the memory files a correct agent
 * leaves, overlaid on the home seeds (Phase 6 P1 and P2, migration 0008).
 */
export const TASK_FILE_KINDS = [
  'fixture',
  'verifier',
  'rubric',
  'expected',
  'home_seed',
  'expected_home',
] as const;
export type TaskFileKind = (typeof TASK_FILE_KINDS)[number];

/**
 * How a configuration's skills reach the agent (Phase 6 P5, migration 0008).
 * Both copy each skill into home/skills/<name>/. `preload` passes `-s <name>`
 * per skill, so Hermes loads each into the prompt at start; `on_demand`
 * passes no `-s` and adds the `skills` toolset, so the agent has to list and
 * open them itself. `preload` is the default and what every version stored
 * before Phase 6 ran with.
 */
export const SKILL_LOADING_MODES = ['preload', 'on_demand'] as const;
export type SkillLoadingMode = (typeof SKILL_LOADING_MODES)[number];

/** Result of the last load of one suite directory. */
export const SUITE_LOAD_OUTCOMES = [
  'created',
  'unchanged',
  'reverted',
  'error',
  'missing',
] as const;
export type SuiteLoadOutcome = (typeof SUITE_LOAD_OUTCOMES)[number];
