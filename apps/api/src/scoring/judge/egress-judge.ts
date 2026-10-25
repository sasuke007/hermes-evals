/**
 * The JudgeClient the worker uses (Phase 3 S2, S4): each judge request is
 * registered with egress over its admin socket, forwarded there by the
 * model gateway's own code, and removed in `finally`, which reads back what
 * egress metered. The worker holds no provider key and opens no TCP
 * connection: egress adds the credential (or nous-proxy holds the login).
 *
 * One request:
 * 1. The judge's provider must be ready (providers/readiness.ts, the rule
 *    launch and the provider guard use); otherwise `provider_not_ready`
 *    and no call is made.
 * 2. Register: kind judge, the judge model only, a token cap, and an expiry
 *    just past the longest the request can take.
 * 3. Call: temperature 0, max_tokens, a non-streaming chat completion, each
 *    try bounded by `timeoutMs`. One retry after a transport failure or a
 *    5xx (JUDGE_RETRIES); none after a 4xx, a refusal or a timeout. Each
 *    call's status and latency go in the answer's call log (question 9).
 * 4. Remove: egress's usage for the registration is the request's tokens,
 *    a retried call included.
 *
 * Nothing here logs the messages, which hold the reference answer.
 */
import { z } from 'zod';
import type { Provider } from '@hermes-evals/shared';
import { newId } from '../../database/ids.js';
import type { AppDb } from '../../database/types.js';
import { PROVIDER_ROUTES } from '../../execution/providers-map.js';
import {
  providerReadiness,
  type ProviderReadiness,
  type ProviderReadinessDeps,
} from '../../providers/readiness.js';
import {
  EgressCallError,
  type EgressClient,
  type EgressJudgeApi,
  type EgressJudgeChatBody,
  type EgressJudgeReply,
  type EgressUsage,
} from '../../sandbox/egress-client.js';
import { JudgeCallError } from './call-error.js';
import {
  JUDGE_RETRIES,
  JUDGE_RETRY_DELAY_MS,
  JUDGE_TEMPERATURE,
  JudgeError,
  type JudgeCallRecord,
  type JudgeClient,
  type JudgeErrorKind,
  type JudgeRequest,
  type JudgeResponse,
  type JudgeTokens,
} from './contracts.js';

export { JudgeCallError } from './call-error.js';
export { JUDGE_RETRY_DELAY_MS } from './contracts.js';

/** Tokens one judge registration is served: a call and its retry need tens of thousands at most. */
export const JUDGE_REGISTRATION_TOKEN_CAP = 200_000;

/** Slack beyond the longest a request can take, so egress never expires a registration mid-call. */
const EXPIRY_MARGIN_MS = 30_000;
/** Egress refuses a judge registration that would live longer (apps/egress judge-registry.ts). */
const MAX_REGISTRATION_LIFETIME_MS = 10 * 60_000 - 1000;

/** How much of a provider's error message a JudgeError quotes. */
const QUOTED_CHARS = 300;

export interface EgressJudgeClientDeps {
  egress: EgressJudgeApi;
  /** The judge provider's readiness, asked before every request. Absent: not checked (tests). */
  readiness?: (provider: Provider) => Promise<ProviderReadiness>;
  /** A fresh ULID per registration. database/ids.ts newId by default. */
  newId?: () => string;
  now?: () => number;
  retryDelayMs?: number;
  /** The registration's token cap. JUDGE_REGISTRATION_TOKEN_CAP by default. */
  tokenCap?: number;
}

const ContentPartSchema = z.object({ type: z.string().optional(), text: z.string().optional() });

/** The part of a chat completion the judge reads. */
const ChatCompletionSchema = z.object({
  model: z.string().optional(),
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.union([z.string(), z.array(ContentPartSchema), z.null()]).optional(),
          refusal: z.string().nullable().optional(),
        }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
});

const ZERO: JudgeTokens = { input: 0, output: 0, total: 0 };

const tokensOf = (usage: EgressUsage): JudgeTokens => ({
  input: usage.promptTokens,
  output: usage.completionTokens,
  total: usage.totalTokens || usage.promptTokens + usage.completionTokens,
});

const plus = (a: JudgeTokens, b: JudgeTokens): JudgeTokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  total: a.total + b.total,
});

/** The provider's or egress's own error message in an answer body, quoted briefly. */
function errorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const { error, message } = body as { error?: { message?: unknown }; message?: unknown };
  const text = typeof error?.message === 'string' ? error.message : message;
  if (typeof text !== 'string' || text.trim() === '') return null;
  return text.length > QUOTED_CHARS ? `${text.slice(0, QUOTED_CHARS)}…` : text;
}

/** The answer text of a choice's message: a string, or the text parts of a content array. */
function contentText(content: z.infer<typeof ContentPartSchema>[] | string | null | undefined) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
  return '';
}

/** An HTTP status for the call log; anything outside 100 to 599 is not one, and reads as none. */
const httpStatus = (status: number): number | null =>
  Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;

/** Waits `ms`, or less when the signal aborts; resolves false when it aborted. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

type Outcome =
  | { ok: true; text: string; model: string; finishReason: string | null }
  | { ok: false; kind: JudgeErrorKind; message: string; status: number | null };

const failed = (kind: JudgeErrorKind, message: string, status: number | null = null): Outcome => ({
  ok: false,
  kind,
  message,
  status,
});

/** One relayed answer as an outcome, or `retry` for a 5xx the caller may try once more. */
function readReply(reply: EgressJudgeReply, request: JudgeRequest): Outcome | 'retry' {
  const { status, body } = reply;
  if (status >= 500) return 'retry';
  if (status >= 400) {
    const reason = errorMessage(body);
    return failed(
      'refused',
      `The judge call was refused (${status})${reason ? `: ${reason}` : ''}.`,
      status,
    );
  }
  if (status < 200 || status >= 300) {
    return failed('transport', `The judge's provider answered ${status}.`, status);
  }
  const completion = ChatCompletionSchema.safeParse(body);
  if (!completion.success) {
    return failed(
      'transport',
      "The judge's provider answered 200 without a chat completion.",
      status,
    );
  }
  const [choice] = completion.data.choices;
  const text = contentText(choice!.message.content);
  const refusal = choice!.message.refusal?.trim();
  if (text.trim() === '' && refusal) {
    return failed('refused', `The judge declined to grade: ${refusal.slice(0, QUOTED_CHARS)}`);
  }
  return {
    ok: true,
    text,
    model: completion.data.model ?? request.model,
    finishReason: choice!.finish_reason ?? null,
  };
}

/** A JudgeClient over egress's judge path. */
export function createEgressJudgeClient(deps: EgressJudgeClientDeps): JudgeClient {
  const now = deps.now ?? Date.now;
  const makeId = deps.newId ?? newId;
  const retryDelayMs = deps.retryDelayMs ?? JUDGE_RETRY_DELAY_MS;
  const tokenCap = deps.tokenCap ?? JUDGE_REGISTRATION_TOKEN_CAP;

  async function checkReady(provider: Provider): Promise<void> {
    if (!deps.readiness) return;
    let answer: ProviderReadiness;
    try {
      answer = await deps.readiness(provider);
    } catch (err) {
      throw new JudgeError(
        'provider_not_ready',
        `Whether the judge's provider (${provider}) is ready could not be checked: ${(err as Error).message}`,
      );
    }
    if (!answer.ready) {
      throw new JudgeError(
        'provider_not_ready',
        `The judge's provider is not ready: ${answer.reason ?? `${provider} is ${answer.status}`}`,
      );
    }
  }

  /**
   * The calls of one registered request: the first, and one retry after a
   * transport failure or a 5xx. Every call made is counted and logged once.
   */
  async function call(
    judgeId: string,
    request: JudgeRequest,
    signal: AbortSignal | undefined,
    counted: { calls: number; tokens: JudgeTokens; log: JudgeCallRecord[] },
  ): Promise<Outcome> {
    const body: EgressJudgeChatBody = {
      model: request.model,
      messages: [
        { role: 'system', content: request.messages.system },
        { role: 'user', content: request.messages.user },
      ],
      temperature: JUDGE_TEMPERATURE,
      max_tokens: request.maxTokens,
      ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
      stream: false,
    };
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt >= JUDGE_RETRIES;
      counted.calls += 1;
      const callStarted = now();
      let reply: EgressJudgeReply | null = null;
      let thrown: unknown = null;
      try {
        reply = await deps.egress.judgeComplete(judgeId, body, {
          timeoutMs: request.timeoutMs,
          signal,
        });
      } catch (err) {
        thrown = err;
      }
      counted.log.push({
        status: reply ? httpStatus(reply.status) : null,
        latencyMs: Math.max(0, Math.round(now() - callStarted)),
      });
      if (reply) {
        if (reply.usage) counted.tokens = plus(counted.tokens, tokensOf(reply.usage));
        const outcome = readReply(reply, request);
        if (outcome !== 'retry') return outcome;
        if (last) {
          const reason = errorMessage(reply.body);
          return failed(
            'transport',
            `The judge's provider answered ${reply.status}${reason ? `: ${reason}` : ''}.`,
            reply.status,
          );
        }
      } else {
        const failure = thrown instanceof EgressCallError ? thrown.failure : 'unreachable';
        if (failure === 'timeout') {
          return failed(
            'timeout',
            `The judge did not answer within ${request.timeoutMs / 1000} s.`,
          );
        }
        if (failure === 'aborted' || signal?.aborted) {
          return failed('timeout', 'The judge call was stopped before it answered.');
        }
        if (last) {
          return failed(
            'transport',
            `The judge could not be reached through egress: ${(thrown as Error).message}`,
          );
        }
      }
      if (!(await pause(retryDelayMs, signal))) {
        return failed('timeout', 'The judge call was stopped before its retry.');
      }
    }
  }

  return {
    async complete(request: JudgeRequest, signal?: AbortSignal): Promise<JudgeResponse> {
      await checkReady(request.provider);
      const route = PROVIDER_ROUTES[request.provider];
      if (request.provider === 'custom' && !request.baseUrl) {
        throw new JudgeError(
          'refused',
          'A custom judge needs JUDGE_BASE_URL: egress has no fixed upstream for custom.',
        );
      }
      const started = now();
      const lifetime = Math.min(
        request.timeoutMs * (1 + JUDGE_RETRIES) + retryDelayMs + EXPIRY_MARGIN_MS,
        MAX_REGISTRATION_LIFETIME_MS,
      );
      const judgeId = makeId();
      try {
        await deps.egress.registerJudge(judgeId, {
          kind: 'judge',
          provider: route.upstream,
          ...(request.provider === 'custom' ? { upstream: { baseUrl: request.baseUrl! } } : {}),
          model: request.model,
          maxTokens: tokenCap,
          expiresAt: started + lifetime,
        });
      } catch (err) {
        const refused = err instanceof EgressCallError && err.failure === 'refused';
        throw new JudgeError(
          refused ? 'refused' : 'transport',
          refused
            ? `Egress refused the judge call: ${(err as Error).message}`
            : `The judge could not be registered with egress: ${(err as Error).message}`,
          err instanceof EgressCallError ? err.status : null,
        );
      }

      const counted = { calls: 0, tokens: ZERO, log: [] as JudgeCallRecord[] };
      let outcome: Outcome;
      let metered: JudgeTokens | null = null;
      try {
        outcome = await call(judgeId, request, signal, counted);
      } finally {
        // Egress's count for the registration is the record; the per-call sum covers a failed remove.
        const report = await deps.egress.removeJudge(judgeId).catch(() => null);
        if (report) metered = tokensOf(report.usage);
      }
      const tokens = metered ?? counted.tokens;
      const latencyMs = Math.max(0, now() - started);
      if (!outcome.ok) {
        throw new JudgeCallError(
          outcome.kind,
          outcome.message,
          outcome.status,
          tokens,
          counted.calls,
          latencyMs,
          counted.log,
        );
      }
      return {
        text: outcome.text,
        tokens,
        model: outcome.model,
        finishReason: outcome.finishReason,
        calls: counted.calls,
        callLog: counted.log,
        latencyMs,
      };
    },
  };
}

/**
 * The worker's judge client: egress over its admin socket, and the judge
 * provider's readiness asked of that same egress, live, as the worker's
 * provider guard asks it (worker.service.ts).
 */
export function workerJudgeClient(deps: {
  db: AppDb;
  egress: EgressClient;
  readinessDeps: ProviderReadinessDeps;
}): JudgeClient {
  const { db, egress, readinessDeps } = deps;
  return createEgressJudgeClient({
    egress,
    readiness: (provider) =>
      providerReadiness(db, provider, {
        ...readinessDeps,
        egressEnvNames: () => egress.envNames(),
        egressHealth: () => egress.healthReport(),
      }),
  });
}
