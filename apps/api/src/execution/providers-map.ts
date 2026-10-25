/**
 * How a trial reaches its model and its http MCP servers: always through
 * egress, with its attempt token, never with a real credential (plan 8.2,
 * invariant 7). Verified against the Hermes source at revision 4d04303 by
 * reading it in the trial image (spike, Phase 2).
 *
 * Model access. Every trial is launched with
 *   --provider <hermesProvider> -m <model> --base-url http://egress:8080/v1 --api-key <attempt token>
 * and config.yaml's model section says the same. egress checks the token,
 * swaps in the upstream's credential, and forwards to the upstream named in
 * the attempt's registration (EgressRegistration.provider). The gateway
 * forwards only POST /chat/completions, /completions, /embeddings and GET
 * /models, and reads OpenAI-shaped usage, so every route below must make
 * Hermes speak Chat Completions.
 *
 * What Hermes does with each --provider id when --base-url and --api-key are
 * given (hermes_cli/runtime_provider.py resolve_runtime_provider; checked by
 * calling it in the image with the gateway URL):
 * - `nous`: provider nous, api_mode chat_completions, base URL honoured, the
 *   given key used as is (`_explicit_nous`, :741). Proven live in Phase 0 (I4).
 *   For `anthropic/*` models the Nous wire defaults to chat as well
 *   (hermes_cli/providers.py nous_api_mode, `nous.anthropic_wire`).
 * - `openrouter`: provider openrouter, chat_completions, base URL honoured;
 *   explicit credentials also skip the OpenRouter key pool (:632).
 * - `custom`: the direct-alias runtime, chat_completions, base URL honoured
 *   (runtime_provider_custom.py `_resolve_direct_alias_runtime`, :579).
 * - `openai` is not a Hermes provider id: `resolve_provider` answers
 *   "Unknown provider 'openai'" (hermes_cli/auth.py). Its registry id
 *   `openai-api` resolves to api_mode codex_responses (the Responses API,
 *   POST /responses), which the gateway does not forward.
 * - `anthropic` resolves to api_mode anthropic_messages (the Messages API),
 *   which the gateway does not forward either.
 * - `nous-api` is not a Hermes provider id at all.
 * So `openai` and `anthropic` run as Hermes `custom` against the provider's
 * own OpenAI-compatible Chat Completions endpoint, and `nous-api` runs as
 * Hermes `nous` with an API key instead of the Portal login. Consequence for
 * `anthropic`: the agent talks to Claude through Anthropic's OpenAI SDK
 * compatibility layer, not the native Messages route Hermes would use with
 * a direct key, so prompt caching and native thinking blocks are not used.
 * Both arms of a comparison take the same route, so comparisons stay fair;
 * docs/limits.md should say so.
 *
 * Hermes's own background call (plan 8.2): `seed_credits_at_session_start`
 * (agent/credits_tracker.py) returns early unless the agent's provider is
 * `nous`, so only Hermes `nous` runs make the credits-seed pricing fetch to
 * inference-api.nousresearch.com, which ignores --base-url. egress refuses it
 * in allowlist mode and it fails open. Phase 0's I10 measured exactly that
 * one host for `nous`; the other ids make no such call in the source.
 *
 * MCP access (plan 5.3, spike I15). Hermes interpolates `${NAME}` in every
 * string of an mcp_servers entry, headers included
 * (tools/mcp_tool_config.py `_interpolate_env_vars`, :554, applied to the
 * whole entry at :710), reading the process environment
 * (agent/secret_scope.py get_secret, :230), and fails closed when a
 * reference in an http entry's url or headers is unset (:585). The http
 * client sends the configured headers on every request, the preflight probe
 * included (tools/mcp_tool_transport.py `_http_endpoint`, :115;
 * `_preflight_content_type`, :428). The agent loop runs in the gateway daemon
 * that `hermes chat` starts, which inherits the container environment
 * (hermes_cli/gateway_runtime_start.py `spawn_unmanaged_gateway`; only
 * DAEMON_STRIPPED_ENV is removed, and our variable is not in it). stdio MCP
 * children get a filtered environment without it (mcp_tool_config.py
 * `_build_safe_env`). So each http server's config.yaml entry carries
 * MCP_GATEWAY_HEADERS, and the container environment carries the token as
 * ATTEMPT_TOKEN_ENV: the token is in no file in the home, and it is the same
 * revocable token the agent already holds for the model gateway. The MCP
 * gateway accepts it as `Authorization: Bearer <token>` against the
 * registration's `token`, as the model gateway does, and removes that header
 * before adding the definition's own headers and forwarding.
 */
import type { Provider } from '@hermes-evals/shared';
import type { EgressRegistration } from '../sandbox/egress-client.js';

/** The model gateway every trial calls (`--base-url`). */
export const MODEL_GATEWAY_BASE_URL = 'http://egress:8080/v1';

/**
 * The container environment variable that carries the attempt token for the
 * MCP gateway's `Authorization` header. Reserved: no MCP definition can name
 * it (PLATFORM_TRIAL_ENV_NAMES).
 */
export const ATTEMPT_TOKEN_ENV = 'HERMES_EVALS_ATTEMPT_TOKEN';

/**
 * The `headers` of every http MCP server entry in config.yaml. A reference,
 * not a value: Hermes fills it from ATTEMPT_TOKEN_ENV when it connects.
 */
export const MCP_GATEWAY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  Authorization: `Bearer \${${ATTEMPT_TOKEN_ENV}}`,
});

/** The Hermes `--provider` ids the platform launches with. */
export type HermesProviderId = 'nous' | 'openrouter' | 'custom';

/**
 * Hermes adds Nous's `reasoning` field only when it talks to
 * nousresearch.com directly; through the gateway it does not, so egress adds
 * it for both Nous upstreams to keep requests identical to direct use
 * (Phase 0, I4).
 */
const NOUS_BODY_DEFAULTS = Object.freeze({ reasoning: { enabled: true, effort: 'medium' } });

/** One platform provider's route from a trial through egress. */
export interface ProviderRoute {
  provider: Provider;
  /** The `--provider` id and config.yaml `model.provider`. */
  hermesProvider: HermesProviderId;
  /** The wire protocol Hermes uses on this route; the only one the gateway serves. */
  hermesApiMode: 'chat_completions';
  /**
   * The egress upstream name: the key in egress's MODEL_UPSTREAMS, and the
   * registration's `provider`. `custom` has no fixed entry: its base URL comes
   * with each registration (EgressRegistration.upstream).
   */
  upstream: string;
  /** Where egress forwards, with the version segment; null for `custom`. */
  upstreamBaseUrl: string | null;
  /**
   * The variable in egress's environment holding the upstream credential;
   * null when the upstream holds its own login (nous-proxy). Presence is what
   * the provider guard checks (workers.egress_env_names).
   */
  apiKeyEnv: string | null;
  /** Whether a run cannot work without that variable. `custom` endpoints may need no key. */
  keyRequired: boolean;
  /** Fields egress adds to POST bodies that do not set them. */
  bodyDefaults: Readonly<Record<string, unknown>> | null;
  /** Whether Hermes makes its credits-seed background call on this route. */
  creditsSeed: boolean;
  /**
   * Hosts Hermes contacts by itself on this route, ignoring --base-url: the
   * inspector labels network events to them as Hermes background traffic.
   */
  backgroundHosts: readonly string[];
}

const NOUS_BACKGROUND_HOSTS = Object.freeze(['inference-api.nousresearch.com']);

/** Every platform provider's route. Keep in step with MODEL_UPSTREAMS in docker-compose.yml. */
export const PROVIDER_ROUTES: Readonly<Record<Provider, ProviderRoute>> = Object.freeze({
  nous: {
    provider: 'nous',
    hermesProvider: 'nous',
    hermesApiMode: 'chat_completions',
    upstream: 'nous',
    // nous-proxy holds the Portal login (plan 6.1); with NOUS_HOST_PROXY egress
    // forwards to the host's `hermes proxy start` instead.
    upstreamBaseUrl: 'http://nous-proxy:8645/v1',
    apiKeyEnv: null,
    keyRequired: false,
    bodyDefaults: NOUS_BODY_DEFAULTS,
    creditsSeed: true,
    backgroundHosts: NOUS_BACKGROUND_HOSTS,
  },
  'nous-api': {
    provider: 'nous-api',
    // Same Hermes provider as the Portal, so both make identical requests;
    // only the credential differs.
    hermesProvider: 'nous',
    hermesApiMode: 'chat_completions',
    upstream: 'nous-api',
    upstreamBaseUrl: 'https://inference-api.nousresearch.com/v1',
    apiKeyEnv: 'NOUS_API_KEY',
    keyRequired: true,
    bodyDefaults: NOUS_BODY_DEFAULTS,
    creditsSeed: true,
    backgroundHosts: NOUS_BACKGROUND_HOSTS,
  },
  openrouter: {
    provider: 'openrouter',
    hermesProvider: 'openrouter',
    hermesApiMode: 'chat_completions',
    upstream: 'openrouter',
    upstreamBaseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    keyRequired: true,
    bodyDefaults: null,
    creditsSeed: false,
    backgroundHosts: [],
  },
  openai: {
    provider: 'openai',
    hermesProvider: 'custom',
    hermesApiMode: 'chat_completions',
    upstream: 'openai',
    upstreamBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    keyRequired: true,
    bodyDefaults: null,
    creditsSeed: false,
    backgroundHosts: [],
  },
  anthropic: {
    provider: 'anthropic',
    hermesProvider: 'custom',
    hermesApiMode: 'chat_completions',
    upstream: 'anthropic',
    // Anthropic's OpenAI SDK compatibility endpoint (POST /v1/chat/completions,
    // the key as a bearer token).
    upstreamBaseUrl: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    keyRequired: true,
    bodyDefaults: null,
    creditsSeed: false,
    backgroundHosts: [],
  },
  custom: {
    provider: 'custom',
    hermesProvider: 'custom',
    hermesApiMode: 'chat_completions',
    upstream: 'custom',
    // The configuration version's base_url, registered per attempt. It may be
    // a private address (the scripted mock model, a local server): the
    // configuration chooses it, and the agent cannot.
    upstreamBaseUrl: null,
    apiKeyEnv: 'CUSTOM_API_KEY',
    keyRequired: false,
    bodyDefaults: null,
    creditsSeed: false,
    backgroundHosts: [],
  },
});

export function providerRoute(provider: Provider): ProviderRoute {
  return PROVIDER_ROUTES[provider];
}

/** The model flags of `hermes chat` for an attempt (plan 8.2). The token is the attempt's, never a key. */
export function hermesModelArgs(provider: Provider, model: string, token: string): string[] {
  return [
    '--provider',
    PROVIDER_ROUTES[provider].hermesProvider,
    '-m',
    model,
    '--base-url',
    MODEL_GATEWAY_BASE_URL,
    '--api-key',
    token,
  ];
}

/** config.yaml's `model` section: the same route as the flags, with nothing secret in it. */
export function hermesModelConfig(provider: Provider, model: string, contextLength = 131_072) {
  return {
    default: model,
    provider: PROVIDER_ROUTES[provider].hermesProvider,
    base_url: MODEL_GATEWAY_BASE_URL,
    context_length: contextLength,
  };
}

/**
 * The model part of an attempt's egress registration: which upstream, which
 * model, and for `custom` the configuration's own base URL.
 */
export function egressModelAccess(configuration: {
  provider: Provider;
  model: string;
  baseUrl: string | null;
}): Pick<EgressRegistration, 'provider' | 'models' | 'upstream'> {
  const route = PROVIDER_ROUTES[configuration.provider];
  if (route.upstreamBaseUrl === null) {
    if (!configuration.baseUrl) {
      throw new Error(`provider ${configuration.provider} needs the configuration's base URL`);
    }
    return {
      provider: route.upstream,
      models: [configuration.model],
      upstream: { baseUrl: configuration.baseUrl },
    };
  }
  return { provider: route.upstream, models: [configuration.model] };
}

/** Whether a network event to `host` is Hermes's own baseline traffic on this provider's route. */
export function isBackgroundHost(provider: Provider, host: string | undefined): boolean {
  return (
    host !== undefined && PROVIDER_ROUTES[provider].backgroundHosts.includes(host.toLowerCase())
  );
}
