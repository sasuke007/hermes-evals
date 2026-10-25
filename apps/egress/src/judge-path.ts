/**
 * The LLM judge's path on the admin socket (Phase 3 S2). The worker grades
 * llm_judge keys through it, because the worker has no TCP route to egress
 * and must hold no provider credential:
 *
 *   PUT    /judges/:id                   register one judge call (judge-registry.ts)
 *   POST   /judges/:id/chat/completions  forward one non-streaming chat completion
 *   GET    /judges/:id                   the registration, its usage and its log
 *   DELETE /judges/:id                   remove it: its usage and connection log
 *
 * A call is forwarded with the model gateway's own pieces (upstream.ts): the
 * upstream named by the registration (Nous through nous-proxy or the host
 * forward, key providers with egress's keys, `custom` with CUSTOM_API_KEY),
 * the upstream's body defaults, usage read from the answer, and the token
 * cap. The body is checked first: the registration's one model, system and
 * user messages only, no tools, no streaming.
 *
 * Answers. An upstream that answered, whatever its status, gives 200 with
 * `{ status, body, usage }`: the upstream's status, its JSON body (null when
 * it sent none), and this call's usage as egress metered it (null when the
 * upstream reported none). Egress's own refusals answer their own status
 * with `{ error: { message, type } }`: 404 unknown registration, 403 expired
 * or another model, 400 a bad body, 413 too large, 429 the token cap or too
 * many calls in flight, 502 upstream unreachable, 503 no such upstream, 504
 * no answer within JUDGE_UPSTREAM_TIMEOUT_MS. Every call whose body passed
 * the check is in the registration's connection log, forwarded or refused
 * (another model, the token cap, no upstream); a body egress cannot read
 * (400, 413) and a call over the in-flight limit (429) are answered without
 * an entry, as there is no model call to record. Neither the log nor an answer
 * ever holds a credential: an upstream answer that echoes egress's key is
 * redacted before it is returned.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { JudgeRegistration, JudgeRegistry } from './judge-registry.js';
import type { Usage } from './registry.js';
import {
  DEFAULT_TOKEN_CAP_PER_ATTEMPT,
  effectiveTokenCap,
  resolveUpstream,
  meteredUsage,
  tokenCapRefusal,
  upstreamFetch,
  UsageReader,
  withBodyDefaults,
  type Upstream,
} from './upstream.js';

export interface JudgePathOptions {
  judges: JudgeRegistry;
  upstreams: Readonly<Record<string, Upstream>>;
  fetch?: typeof fetch;
  /** Egress's environment, for CUSTOM_API_KEY; process.env unless a test supplies one. */
  env?: () => NodeJS.ProcessEnv;
  /** Total tokens a registration naming no maxTokens is served (MODEL_TOKEN_CAP_PER_ATTEMPT). */
  tokenCap?: number;
  /** Longest egress waits for the upstream's whole answer. Default JUDGE_UPSTREAM_TIMEOUT_MS. */
  upstreamTimeoutMs?: number;
}

/** Longest egress waits for one judge answer; the worker's own timeout is shorter (60 s). */
export const JUDGE_UPSTREAM_TIMEOUT_MS = 120_000;

/** A judge request holds the rubric, the task, the reference and the agent's (capped) text. */
const MAX_JUDGE_REQUEST_BYTES = 2 * 1024 * 1024;
/** A judge answer is a score and a comment; anything near this is not one. */
const MAX_JUDGE_ANSWER_BYTES = 4 * 1024 * 1024;

export const JUDGE_ROUTE = /^\/judges\/([0-9A-HJKMNP-TV-Z]{26})(\/chat\/completions)?$/;

/** The only body a judge call may send: OpenAI chat completions, narrowed to what grading needs. */
const JudgeChatBodySchema = z
  .object({
    model: z.string().min(1).max(200),
    messages: z
      .array(
        z.object({ role: z.enum(['system', 'user']), content: z.string().max(1_000_000) }).strict(),
      )
      .min(1)
      .max(8),
    temperature: z.number().min(0).max(2),
    max_tokens: z.number().int().min(1).max(16_384),
    response_format: z.looseObject({ type: z.string().min(1).max(64) }).optional(),
    stream: z.literal(false).optional(),
  })
  .strict();

function json(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const refuse = (
  res: ServerResponse,
  status: number,
  message: string,
  type = 'invalid_request_error',
) => json(res, status, { error: { message, type } });

/** Reads at most `limit` bytes; null when the stream is longer. */
async function readLimited(
  source: AsyncIterable<Uint8Array | string>,
  limit: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** Replaces every occurrence of the upstream's key in an answer before it leaves egress. */
const redact = (text: string, upstream: Upstream): string =>
  upstream.apiKey ? text.split(upstream.apiKey).join('[redacted]') : text;

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The handler for /judges routes, or 404 when `options` is absent (judge path not configured). */
export function createJudgePath(options: JudgePathOptions) {
  const { judges, upstreams } = options;
  const doFetch = options.fetch ?? fetch;
  const env = options.env ?? (() => process.env);
  const tokenCap = options.tokenCap ?? DEFAULT_TOKEN_CAP_PER_ATTEMPT;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? JUDGE_UPSTREAM_TIMEOUT_MS;

  async function complete(
    registration: JudgeRegistration,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const { judgeId } = registration;
    const raw = await readLimited(req, MAX_JUDGE_REQUEST_BYTES);
    if (raw === null) {
      return refuse(res, 413, `judge requests are at most ${MAX_JUDGE_REQUEST_BYTES} bytes`);
    }
    const parsed = JudgeChatBodySchema.safeParse(parseJson(raw.toString('utf8')));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      return refuse(res, 400, `invalid judge request: ${issues.join('; ')}`);
    }
    const body = parsed.data;
    if (body.model !== registration.model) {
      judges.log(judgeId, {
        kind: 'model',
        model: body.model,
        decision: 'denied',
        status: 403,
        reason: 'model not allowed',
      });
      return refuse(res, 403, `model ${body.model} is not this judge registration's model`);
    }
    const used = judges.usage(judgeId)?.totalTokens ?? 0;
    const cap = effectiveTokenCap(registration.maxTokens, tokenCap);
    if (used >= cap) {
      const refusal = tokenCapRefusal(used, cap, 'judge registration');
      judges.log(judgeId, {
        kind: 'model',
        model: body.model,
        decision: 'denied',
        status: 429,
        reason: refusal.reason,
      });
      return json(res, 429, refusal.body);
    }
    const upstream = resolveUpstream(registration, upstreams, env());
    if (!upstream) {
      judges.log(judgeId, {
        kind: 'model',
        model: body.model,
        decision: 'denied',
        status: 503,
        reason: `no upstream configured for ${registration.provider}`,
      });
      return refuse(res, 503, `no upstream configured for ${registration.provider}`, 'api_error');
    }
    if (!judges.openCall(judgeId)) {
      return refuse(
        res,
        429,
        'this judge registration already has calls in flight',
        'rate_limit_exceeded',
      );
    }
    try {
      await forward(registration, upstream, body, res);
    } finally {
      judges.closeCall(judgeId);
    }
  }

  async function forward(
    registration: JudgeRegistration,
    upstream: Upstream,
    body: z.output<typeof JudgeChatBodySchema>,
    res: ServerResponse,
  ): Promise<void> {
    const { judgeId } = registration;
    const started = Date.now();
    const abort = new AbortController();
    // The worker gave up (its own timeout or a lost claim): stop the upstream call too.
    res.on('close', () => abort.abort());
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, upstreamTimeoutMs);
    const sent = withBodyDefaults(body, upstream) ?? body;
    const fail = (status: number, reason: string, message: string) => {
      judges.log(judgeId, {
        kind: 'model',
        model: body.model,
        decision: 'allowed',
        status,
        reason,
        ms: Date.now() - started,
      });
      refuse(res, status, message, 'api_error');
    };
    try {
      let response: Response;
      try {
        response = await upstreamFetch(doFetch, upstream, '/chat/completions', {
          method: 'POST',
          accept: 'application/json',
          body: Buffer.from(JSON.stringify(sent)),
          signal: abort.signal,
        });
      } catch (err) {
        return timedOut
          ? fail(
              504,
              'upstream timed out',
              `the upstream did not answer within ${upstreamTimeoutMs} ms`,
            )
          : fail(502, (err as Error).message, `upstream unreachable: ${(err as Error).message}`);
      }
      let raw: Buffer | null;
      try {
        raw = response.body
          ? await readLimited(
              response.body as unknown as AsyncIterable<Uint8Array>,
              MAX_JUDGE_ANSWER_BYTES,
            )
          : Buffer.alloc(0);
      } catch (err) {
        return timedOut
          ? fail(
              504,
              'upstream timed out',
              `the upstream did not finish within ${upstreamTimeoutMs} ms`,
            )
          : fail(
              502,
              (err as Error).message,
              `the upstream answer broke off: ${(err as Error).message}`,
            );
      }
      if (raw === null) {
        return fail(
          502,
          'answer too large',
          `the upstream answer passed ${MAX_JUDGE_ANSWER_BYTES} bytes`,
        );
      }
      const text = redact(raw.toString('utf8'), upstream);
      const reader = new UsageReader(
        (response.headers.get('content-type') ?? '').includes('event-stream'),
      );
      reader.feed(Buffer.from(text));
      const usage: Usage | null = meteredUsage(reader.result());
      judges.addUsage(
        judgeId,
        usage ?? { calls: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      );
      judges.log(judgeId, {
        kind: 'model',
        model: body.model,
        decision: 'allowed',
        status: response.status,
        ms: Date.now() - started,
        ...(usage
          ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }
          : {}),
      });
      json(res, 200, { status: response.status, body: parseJson(text), usage });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Serves one /judges request whose path matched JUDGE_ROUTE. */
  return async function judgePath(
    req: IncomingMessage,
    res: ServerResponse,
    match: RegExpExecArray,
  ): Promise<void> {
    const judgeId = match[1]!;
    if (match[2]) {
      if (req.method !== 'POST') return refuse(res, 405, 'method not allowed');
      const registration = judges.live(judgeId);
      if (registration === null) return refuse(res, 404, 'unknown judge registration');
      if (registration === 'expired')
        return refuse(res, 403, 'this judge registration has expired');
      return complete(registration, req, res);
    }
    if (req.method === 'PUT') {
      const raw = await readLimited(req, 64 * 1024);
      if (raw === null) return refuse(res, 413, 'too large');
      try {
        judges.register(judgeId, JSON.parse(raw.toString('utf8')));
        return json(res, 204);
      } catch (err) {
        const status = (err as { status?: unknown }).status;
        const message =
          err instanceof z.ZodError
            ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
            : (err as Error).message;
        return json(res, typeof status === 'number' ? status : 400, { message });
      }
    }
    if (req.method === 'GET') {
      const entry = judges.get(judgeId);
      return entry ? json(res, 200, entry) : refuse(res, 404, 'unknown judge registration');
    }
    if (req.method === 'DELETE') {
      const removed = judges.remove(judgeId);
      return removed ? json(res, 200, removed) : refuse(res, 404, 'unknown judge registration');
    }
    return refuse(res, 405, 'method not allowed');
  };
}
