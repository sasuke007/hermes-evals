/**
 * Environment variable names an MCP definition may not reference (plan
 * section 1, invariant 7; plan 5.3).
 *
 * A stdio server's env names are read from the WORKER's environment and set
 * in the trial container, where the agent can read them. The worker's
 * environment also holds what must never enter a trial: the provider keys
 * (Compose gives the worker the whole of .env, for those stdio values),
 * DATABASE_URL and the worker's own settings.
 * An http server's header variables are read from egress's environment, which
 * holds the provider keys as well; a definition must not be able to tell
 * egress to send one to an arbitrary URL. So both kinds of reference refuse
 * these names: the API when a definition is saved, and the worker when it
 * tests or runs one (which also covers versions stored before this rule).
 */

/**
 * Variables the platform sets in every trial container. A definition that
 * named one would replace the platform's value with the worker's.
 */
export const PLATFORM_TRIAL_ENV_NAMES = [
  'HOME',
  'HERMES_HOME',
  'HERMES_WRITE_SAFE_ROOT',
  'XDG_RUNTIME_DIR',
  'TMPDIR',
  'PATH',
  'NO_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
  /**
   * The attempt token, for the `Authorization` header config.yaml gives each
   * http MCP server as `Bearer ${HERMES_EVALS_ATTEMPT_TOKEN}` (spike in
   * apps/api/src/execution/providers-map.ts). Also covered by `HERMES_`.
   */
  'HERMES_EVALS_ATTEMPT_TOKEN',
] as const;

/**
 * Provider credentials. Egress holds them for the model gateway and for the
 * LLM judge, whose calls the worker sends through egress's admin socket
 * (Phase 3), so the worker itself never uses one; a trial gets a
 * per-attempt egress token instead.
 * Keep in step with the apiKeyEnv names of MODEL_UPSTREAMS (docker-compose.yml)
 * and of PROVIDER_ROUTES (apps/api/src/execution/providers-map.ts).
 * CUSTOM_API_KEY is the optional key egress sends to a `custom` provider's
 * own base URL.
 */
export const PROVIDER_KEY_ENV_NAMES = [
  'NOUS_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CUSTOM_API_KEY',
] as const;

/**
 * The worker's own settings (the API's EnvSchema, apps/api/src/config/env.ts;
 * a test checks every key of it is reserved here or by a prefix).
 */
export const WORKER_SETTING_ENV_NAMES = [
  'NODE_ENV',
  'PORT',
  'HOST',
  'ALLOWED_HOSTS',
  'LOG_LEVEL',
  'DATABASE_URL',
  'SUITES_DIR',
  'DATA_DIR',
  'HERMES_BIN',
  'WORKER_CONCURRENCY',
  'TRIALS_DIR',
  'CORS_ORIGIN',
  'PRICES_FILE',
  'SUITE_RELOAD_TIMEOUT_S',
  'MCP_TEST_TIMEOUT_S',
  'SKILL_UPLOAD_TTL_S',
  'MAX_CONSECUTIVE_EXECUTION_ERRORS',
  'TRIAL_RETENTION_DAYS',
  'RECOVERY_INTERVAL_MS',
  'LEASE_SECONDS',
  'NOUS_LOGIN_URL',
  'JUDGE_PROVIDER',
  'JUDGE_MODEL',
  'JUDGE_BASE_URL',
  'MODEL_TOKEN_CAP_PER_ATTEMPT',
] as const;

/** Every name refused outright. */
export const WORKER_RESERVED_ENV_NAMES: ReadonlySet<string> = new Set<string>([
  ...PLATFORM_TRIAL_ENV_NAMES,
  ...PROVIDER_KEY_ENV_NAMES,
  ...WORKER_SETTING_ENV_NAMES,
]);

/**
 * Namespaces refused whole: the sandbox's settings (DOCKER_, EGRESS_,
 * TRIAL_), Hermes's own (HERMES_), Node's (NODE_), libpq's (PG, as in
 * PGPASSWORD) and the providers' (NOUS_, OPENROUTER_, OPENAI_, ANTHROPIC_).
 */
export const WORKER_RESERVED_ENV_PREFIXES = [
  'DOCKER_',
  'EGRESS_',
  'TRIAL_',
  'HERMES_',
  'NODE_',
  'PG',
  'NOUS_',
  'OPENROUTER_',
  'OPENAI_',
  'ANTHROPIC_',
] as const;

/** True for a name no MCP definition may reference, as a stdio env name or an http header variable. */
export function isReservedEnvName(name: string): boolean {
  return (
    WORKER_RESERVED_ENV_NAMES.has(name) ||
    WORKER_RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

/** Why a reserved name is refused, for a form issue or a test result. */
export function reservedEnvNameMessage(names: readonly string[]): string {
  const list =
    names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return names.length === 1
    ? `${list} is a platform variable or credential; it never enters a trial`
    : `${list} are platform variables or credentials; they never enter a trial`;
}
