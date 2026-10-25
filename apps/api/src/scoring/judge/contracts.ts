/**
 * The LLM judge's contracts (plan 9.3, 9.5): which model grades an
 * llm_judge key, what one judge call asks, and what it answers.
 *
 * Where the calls go (Phase 3 decision S2): never from the worker to a
 * provider. The worker has no TCP route to egress, by design; it reaches
 * egress only over the admin unix socket, so the judge has its own path
 * there (sandbox/egress-client.ts EgressJudgeApi). Egress forwards it with
 * the model gateway's code: the upstream per provider, Nous through
 * nous-proxy, key providers with egress's own keys, `custom` with
 * CUSTOM_API_KEY. Provider credentials stay in egress and nous-proxy. Each
 * call is registered and metered like an attempt: a short-lived
 * registration for the judge model only (no MCP, no CONNECT), its usage
 * and connection log read back, the registration removed in `finally`.
 *
 * A JudgeClient implements that. Scorers see only this file's types, so
 * tests use an in-process fake and never a real provider.
 */
import type { LlmJudgeParams, Provider } from '@hermes-evals/shared';
import type { Env } from '../../config/env.js';

// ---------------------------------------------------------------------------
// Which model judges
// ---------------------------------------------------------------------------

/** The provider a check's `model:` runs on when JUDGE_PROVIDER is unset: the platform's default route. */
export const DEFAULT_JUDGE_PROVIDER: Provider = 'nous';

/** The `error` comment of every llm_judge key when neither the check nor the settings name a model. */
export const NO_JUDGE_MODEL_MESSAGE =
  'No judge model is configured (set JUDGE_PROVIDER and JUDGE_MODEL, or model: in the check)';

/** The platform's judge default, from the worker's (and the API's) environment. */
export interface JudgeSettings {
  /** JUDGE_PROVIDER. */
  provider?: Provider;
  /** JUDGE_MODEL. */
  model?: string;
  /** JUDGE_BASE_URL: a `custom` judge's own base URL (env.ts requires it exactly for `custom`). */
  baseUrl?: string;
}

/** The judge settings of a validated environment. */
export const judgeSettingsOf = (
  env: Pick<Env, 'JUDGE_PROVIDER' | 'JUDGE_MODEL' | 'JUDGE_BASE_URL'>,
): JudgeSettings => ({
  provider: env.JUDGE_PROVIDER,
  model: env.JUDGE_MODEL,
  baseUrl: env.JUDGE_BASE_URL,
});

/** The model that grades one llm_judge key, and the route its calls take. */
export interface JudgeTarget {
  provider: Provider;
  model: string;
  /** For `custom` only: where egress forwards the calls. Null for every other provider. */
  baseUrl: string | null;
  /** `check`: the key's own `model:`; `settings`: JUDGE_MODEL. */
  source: 'check' | 'settings';
}

/**
 * The judge of one llm_judge key (S3): the check's `model:` when it sets
 * one, else JUDGE_MODEL. Either runs on JUDGE_PROVIDER, or on `nous` when
 * that is unset, so a check that names its model needs no setting at all.
 * Null when neither names a model: the key is then published as `error`
 * with NO_JUDGE_MODEL_MESSAGE, never scored zero.
 *
 * One rule for every place that needs the judge's provider: the scorer, the
 * launch and re-score checks (409 when that provider is not ready), and the
 * run views' `needs.judgeProvider`.
 */
export function resolveJudgeModel(
  params: Pick<LlmJudgeParams, 'model'>,
  settings: JudgeSettings,
): JudgeTarget | null {
  const fromCheck = params.model?.trim() || undefined;
  const fromSettings = settings.model?.trim() || undefined;
  const model = fromCheck ?? fromSettings;
  if (model === undefined) return null;
  const provider = settings.provider ?? DEFAULT_JUDGE_PROVIDER;
  return {
    provider,
    model,
    baseUrl: provider === 'custom' ? (settings.baseUrl ?? null) : null,
    source: fromCheck !== undefined ? 'check' : 'settings',
  };
}

// ---------------------------------------------------------------------------
// One judge call
// ---------------------------------------------------------------------------

/**
 * Most tokens a judge answer may use (S4). A score and a short comment need
 * far fewer, but a reasoning model spends its thinking from the same budget:
 * the `nous` upstreams turn reasoning on by default, and 1,024 cut such an
 * answer off before it was written (Phase 3 question 6).
 */
export const JUDGE_MAX_TOKENS = 4096;

/** How long one judge call may take before it counts as a `timeout` (S4). */
export const JUDGE_TIMEOUT_MS = 60_000;

/** Sampling temperature of every judge call (S4), so a re-score asks the same question the same way. */
export const JUDGE_TEMPERATURE = 0;

/**
 * Retries of one judge call (S4): one more try after a transport error or a
 * 5xx; none after a 4xx, a refusal or a timeout.
 */
export const JUDGE_RETRIES = 1;

/** Wait before the one retry. */
export const JUDGE_RETRY_DELAY_MS = 1000;

/**
 * What the judge is asked to return: an OpenAI `response_format`. `json_object`
 * is the widely supported form; a provider that ignores it still has its text
 * parsed strictly by the scorer.
 */
export type JudgeResponseFormat =
  | { type: 'json_object' }
  | {
      type: 'json_schema';
      json_schema: { name: string; strict: boolean; schema: Record<string, unknown> };
    };

/** One chat completion for the judge, built by the scorer (llm-judge.ts). */
export interface JudgeRequest {
  provider: Provider;
  model: string;
  /** JudgeTarget.baseUrl: set for `custom` only. */
  baseUrl: string | null;
  /**
   * The system message holds the rules and the facts (rubric, task prompt,
   * reference answer); the user message holds the agent's final text as
   * untrusted data between explicit delimiters (S4). Exactly these two.
   */
  messages: { system: string; user: string };
  /** JUDGE_MAX_TOKENS unless a test asks for less. */
  maxTokens: number;
  /** Per call, retry included separately: JUDGE_TIMEOUT_MS unless a test asks for less. */
  timeoutMs: number;
  responseFormat?: JudgeResponseFormat;
}

/** Token counts of the judge's calls, as egress metered them. */
export interface JudgeTokens {
  input: number;
  output: number;
  total: number;
}

/**
 * One call of a judge request, as the worker saw it (Phase 3 question 9):
 * the HTTP status that ended it, egress's own or the upstream's as relayed,
 * or null when it failed in transport or timed out before any answer; and
 * how long it took.
 */
export interface JudgeCallRecord {
  status: number | null;
  latencyMs: number;
}

/** The judge's answer to one JudgeRequest: the text of its first choice, unparsed. */
export interface JudgeResponse {
  /** The assistant message's content, verbatim; the scorer parses it strictly. */
  text: string;
  /** Summed over every call this request made (a retried call counts twice). */
  tokens: JudgeTokens;
  /** The model the provider says answered. */
  model: string;
  /** The choice's finish reason, e.g. `stop` or `length`; null when the provider sent none. */
  finishReason: string | null;
  /** Calls made: 1, or 1 + JUDGE_RETRIES when the first failed in transport or with a 5xx. */
  calls: number;
  /** Each call in order, one per call made. */
  callLog: JudgeCallRecord[];
  /** Wall time of the whole request, retry included. */
  latencyMs: number;
}

/**
 * Why a judge call produced no answer. The scorer turns each into an
 * `error` score with the message (plan 9.2), never a zero:
 * - `transport`: egress or the upstream could not be reached, or answered
 *   5xx, on every try;
 * - `refused`: a 4xx (bad request, auth, model not served, the token cap),
 *   or egress refused the registration; never retried;
 * - `timeout`: no answer within `timeoutMs`, or the caller's signal aborted;
 * - `provider_not_ready`: the judge's provider is not ready
 *   (providers/readiness.ts), checked before any call is made.
 */
export type JudgeErrorKind = 'transport' | 'refused' | 'timeout' | 'provider_not_ready';

export class JudgeError extends Error {
  override readonly name = 'JudgeError';

  constructor(
    readonly kind: JudgeErrorKind,
    message: string,
    /** The HTTP status that ended the call, when there was one. */
    readonly status: number | null = null,
    /** Tokens egress metered before the failure (a 5xx can still bill); zero when none. */
    readonly tokens: JudgeTokens = { input: 0, output: 0, total: 0 },
  ) {
    super(message);
  }
}

/**
 * Makes judge calls. Resolves the judge's answer, or rejects with a
 * JudgeError; any other rejection is a bug the scorer reports as `error`
 * too. Implementations never log the request's messages, which hold the
 * reference answer, and never hold a provider key.
 */
export interface JudgeClient {
  complete(request: JudgeRequest, signal?: AbortSignal): Promise<JudgeResponse>;
}
