/**
 * The model gateway's forwarding pieces, shared by the trial-facing gateway
 * (gateway.ts) and the LLM judge's path on the admin socket (judge-path.ts):
 * which upstream a registration's calls go to, the credential egress adds,
 * the body defaults an upstream wants, usage read from the answer, and the
 * per-registration token cap. One copy, so a judge call reaches a provider
 * exactly the way an agent's call does, and provider credentials stay here.
 */
import type { Usage } from './registry.js';

/** One model upstream (MODEL_UPSTREAMS entry, or a `custom` registration's own base URL). */
export interface Upstream {
  /** Base URL including the version segment, e.g. `https://openrouter.ai/api/v1`. */
  baseUrl: string;
  /** Credential sent upstream; omitted for an upstream that holds its own (nous-proxy). */
  apiKey?: string;
  /**
   * Fields added to POST bodies that do not already set them. Hermes only adds
   * Nous's `reasoning` field when it talks to nousresearch.com directly, so the
   * nous upstream restores it here to keep requests identical to direct use.
   */
  bodyDefaults?: Record<string, unknown>;
}

/** The variable holding the optional key for a `custom` registration's own base URL. */
export const CUSTOM_API_KEY_ENV = 'CUSTOM_API_KEY';

/**
 * Total tokens one registration is served before the gateway answers 429
 * (Phase 2 question 2), unless the registration names its own maxTokens.
 * MODEL_TOKEN_CAP_PER_ATTEMPT in egress's environment overrides it. Without
 * a cap a runaway agent would call the model until its deadline.
 */
export const DEFAULT_TOKEN_CAP_PER_ATTEMPT = 2_000_000;

/** The `error.code` of a 429 past the token cap, so a client can tell it from a rate limit. */
export const TOKEN_CAP_CODE = 'token_cap_reached';

/** What a registration says about its model route: an upstream name, or its own base URL. */
export interface ModelRoute {
  provider: string | null;
  upstream?: { baseUrl: string };
}

/**
 * Where a registration's model calls go: its own base URL for `custom`
 * (with CUSTOM_API_KEY when egress has one; empty counts as unset), else the
 * named upstream. Undefined when egress has no such upstream.
 */
export function resolveUpstream(
  route: ModelRoute,
  upstreams: Readonly<Record<string, Upstream>>,
  env: NodeJS.ProcessEnv,
): Upstream | undefined {
  if (route.upstream) {
    return { baseUrl: route.upstream.baseUrl, apiKey: env[CUSTOM_API_KEY_ENV] || undefined };
  }
  if (!route.provider || !Object.hasOwn(upstreams, route.provider)) return undefined;
  return upstreams[route.provider];
}

/**
 * The paths whose streamed answers carry usage only when the request asks
 * for it with `stream_options.include_usage` (OpenAI's rule, which the
 * compatible upstreams follow).
 */
export const USAGE_ON_REQUEST_PATHS: ReadonlySet<string> = new Set([
  '/chat/completions',
  '/completions',
]);

/**
 * The body with `stream_options.include_usage` turned on, or null when it
 * already is. Without it a streamed call reports no usage, so it would be
 * metered as nothing and slip past the token cap and the spend guard. Hermes
 * asks for usage already (plan 21 I4), so its requests reach the upstream
 * byte for byte.
 */
export function withStreamUsage(parsed: Record<string, unknown>): Record<string, unknown> | null {
  const options = parsed.stream_options;
  const current =
    options !== null && typeof options === 'object' && !Array.isArray(options)
      ? (options as Record<string, unknown>)
      : {};
  if (current.include_usage === true) return null;
  return { ...parsed, stream_options: { ...current, include_usage: true } };
}

/** The body with the upstream's default fields added where the request did not set them. */
export function withBodyDefaults(
  parsed: Record<string, unknown>,
  upstream: Upstream,
): Record<string, unknown> | null {
  const defaults = Object.entries(upstream.bodyDefaults ?? {}).filter(([key]) => !(key in parsed));
  return defaults.length > 0 ? { ...parsed, ...Object.fromEntries(defaults) } : null;
}

/**
 * One request to the upstream, with egress's credential for it. The caller
 * owns the response body and the abort signal.
 */
export function upstreamFetch(
  doFetch: typeof fetch,
  upstream: Upstream,
  subpath: string,
  init: { method: string; accept: string; body?: Buffer; signal: AbortSignal },
): Promise<Response> {
  const headers: Record<string, string> = { accept: init.accept };
  if (init.body) headers['content-type'] = 'application/json';
  if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`;
  return doFetch(`${upstream.baseUrl.replace(/\/$/, '')}${subpath}`, {
    method: init.method,
    headers,
    body: init.body,
    signal: init.signal,
  });
}

/** OpenAI-style usage, as upstreams report it. */
export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/** Finds the usage block in a JSON response or in the last SSE chunk that carries one. */
export class UsageReader {
  private buffered = '';
  private usage: TokenUsage | null = null;

  constructor(private readonly streaming: boolean) {}

  feed(chunk: Buffer): void {
    this.buffered += chunk.toString('utf8');
    if (!this.streaming) return;
    let newline: number;
    while ((newline = this.buffered.indexOf('\n')) >= 0) {
      const line = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      this.consume(line);
    }
  }

  private consume(line: string): void {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data) as { usage?: TokenUsage | null };
      if (parsed.usage) this.usage = parsed.usage;
    } catch {
      // A partial or non-JSON data line carries no usage.
    }
  }

  result(): TokenUsage | null {
    if (this.streaming) {
      this.consume(this.buffered.trim());
      return this.usage;
    }
    try {
      return (JSON.parse(this.buffered) as { usage?: TokenUsage }).usage ?? null;
    } catch {
      return null;
    }
  }
}

/** A count from an upstream's usage block; anything that is not a non-negative number is 0. */
export const tokenCount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;

/**
 * One call's usage as egress meters it, from the upstream's usage block: the
 * total, or prompt plus completion when the upstream leaves the total out.
 * Null when the upstream reported none.
 */
export function meteredUsage(reported: TokenUsage | null): Usage | null {
  if (reported === null) return null;
  const promptTokens = tokenCount(reported.prompt_tokens);
  const completionTokens = tokenCount(reported.completion_tokens);
  return {
    calls: 1,
    promptTokens,
    completionTokens,
    totalTokens: tokenCount(reported.total_tokens) || promptTokens + completionTokens,
  };
}

/** Bytes per token the estimate below assumes; text runs nearer 4 to 5, so it errs high. */
const BYTES_PER_TOKEN = 4;

/**
 * What a call that answered but reported no usage is charged: never nothing,
 * or a client that closes the stream before the usage chunk (the upstream
 * still bills what it generated) could call past its cap. The prompt as the
 * request's bytes; the completion as the request's `max_completion_tokens`
 * or `max_tokens`, the most the upstream bills, else the answer's bytes.
 */
export function estimatedUsage(input: {
  requestBytes: number;
  maxTokens: number | null;
  answerBytes: number;
}): Usage {
  const promptTokens = Math.ceil(input.requestBytes / BYTES_PER_TOKEN);
  const completionTokens = input.maxTokens ?? Math.ceil(input.answerBytes / BYTES_PER_TOKEN);
  return { calls: 1, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens };
}

/** The completion limit a request sets, if any: `max_completion_tokens`, else `max_tokens`. */
export const requestedMaxTokens = (parsed: Record<string, unknown>): number | null =>
  tokenCount(parsed.max_completion_tokens) || tokenCount(parsed.max_tokens) || null;

/** The connection-log reason of a call charged by estimatedUsage. */
export const ESTIMATED_USAGE_REASON =
  'the upstream reported no usage for this call; charged an estimate from its size';

/** The registration's cap: its own maxTokens, else egress's default. */
export const effectiveTokenCap = (maxTokens: number | undefined, fallback: number): number =>
  maxTokens ?? fallback;

/**
 * The 429 a registration gets once its total reaches the cap, and the
 * connection-log reason the runner turns into a `network` event. Both name
 * the cap, so the inspector says why the agent stopped getting answers.
 */
export function tokenCapRefusal(
  used: number,
  cap: number,
  subject: 'attempt' | 'judge registration' = 'attempt',
): { reason: string; body: { error: Record<string, unknown> } } {
  const reason = `token cap reached: ${used} of ${cap} tokens used`;
  return {
    reason,
    body: {
      error: {
        message: `This ${subject} reached its token cap of ${cap} tokens (${used} used; MODEL_TOKEN_CAP_PER_ATTEMPT)`,
        type: 'rate_limit_exceeded',
        code: TOKEN_CAP_CODE,
        cap,
        used,
      },
    },
  };
}
