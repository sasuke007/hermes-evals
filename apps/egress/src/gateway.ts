/**
 * The model gateway: an OpenAI-compatible endpoint on the trial network. A
 * trial calls it with its attempt token as the API key; the gateway checks
 * the token, the model and the budget, swaps in the real upstream credential,
 * streams the answer back unchanged, and records usage against the attempt.
 * The real credential never enters a trial, and a token stops working the
 * moment the worker removes its attempt.
 *
 * The token cap: once an attempt's metered total reaches its registration's
 * maxTokens, or MODEL_TOKEN_CAP_PER_ATTEMPT (default 2,000,000) when it names
 * none, every further call answers 402 (TOKEN_CAP_STATUS, which Hermes does
 * not retry) with `x-should-retry: false`, `error.code` token_cap_reached
 * and the cap, and is logged with that reason, so the inspector's `network`
 * event says why the agent stopped getting answers and the platform
 * classifies the run `limit`. A call already running
 * finishes: the cap is checked before forwarding, never mid-stream, so the
 * calls in flight together (at most `maxModelCallsPerAttempt`) can overshoot
 * it by what they generate.
 *
 * Every forwarded call is metered, because the agent holds its token and
 * could otherwise call past the cap and the spend guard. A streamed chat or
 * text completion is sent with `stream_options.include_usage` on (Hermes
 * sets it already), so its usage arrives in the last chunk. A total the
 * upstream leaves out is prompt plus completion. A call that answered 2xx
 * but reported no usage (the client closed before the usage chunk, or the
 * upstream sent none) is charged an estimate from its size, logged as such,
 * never 0 (upstream.ts estimatedUsage).
 *
 * The forwarding pieces (upstream choice, credentials, body defaults, usage)
 * live in upstream.ts, shared with the LLM judge's path (judge-path.ts).
 *
 * The same port serves the MCP gateway under /mcp/<name> (mcp-gateway.ts).
 * A `custom` attempt brings its own upstream: the configuration's base URL,
 * with CUSTOM_API_KEY from egress's environment when it is set.
 *
 * Its memory is bounded, because the agent holds its token and can call the
 * gateway as often as it likes: each request body is read into memory (up
 * to 10 MiB, a larger Content-Length refused before reading), each attempt
 * has at most `maxModelCallsPerAttempt` calls in flight (the next answers
 * 429), the server takes at most `maxConnections` sockets, and a request
 * must arrive within `requestTimeoutMs`, so a slow upload cannot hold a
 * slot.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { guarded, parseTarget } from './handler.js';
import { createMcpGateway, MCP_PATH_PREFIX, type McpGatewayOptions } from './mcp-gateway.js';
import type { Registration, Registry } from './registry.js';
import {
  DEFAULT_TOKEN_CAP_PER_ATTEMPT,
  effectiveTokenCap,
  ESTIMATED_USAGE_REASON,
  estimatedUsage,
  meteredUsage,
  requestedMaxTokens,
  resolveUpstream,
  TOKEN_CAP_STATUS,
  tokenCapRefusal,
  upstreamFetch,
  USAGE_ON_REQUEST_PATHS,
  UsageReader,
  withBodyDefaults,
  withStreamUsage,
  type Upstream,
} from './upstream.js';

// Kept importable from here: main.ts and the tests name them by this module.
export { CUSTOM_API_KEY_ENV, UsageReader, type Upstream } from './upstream.js';

export interface GatewayOptions {
  registry: Registry;
  upstreams: Record<string, Upstream>;
  fetch?: typeof fetch;
  /**
   * Egress's environment: CUSTOM_API_KEY and MCP header values are read from
   * it on every request. process.env unless a test supplies one.
   */
  env?: () => NodeJS.ProcessEnv;
  /** Caps and the process log for the MCP gateway. */
  mcp?: Omit<McpGatewayOptions, 'registry' | 'env'>;
  /** Model calls one attempt may have in flight. Default 8. */
  maxModelCallsPerAttempt?: number;
  /**
   * Total tokens an attempt whose registration names no maxTokens is served
   * (MODEL_TOKEN_CAP_PER_ATTEMPT). Default DEFAULT_TOKEN_CAP_PER_ATTEMPT.
   */
  tokenCapPerAttempt?: number;
  /** Sockets the server holds at once, model and MCP calls together. Default 512. */
  maxConnections?: number;
  /** Longest a request (headers and body) may take to arrive. Default 60 s. */
  requestTimeoutMs?: number;
}

export const DEFAULT_MODEL_CALLS_PER_ATTEMPT = 8;

const MAX_REQUEST_BYTES = 10 * 1024 * 1024;
const FORWARDED_POSTS = new Set(['/chat/completions', '/completions', '/embeddings']);
const RESPONSE_HEADERS = ['content-type', 'cache-control', 'x-request-id'];

function error(
  res: ServerResponse,
  status: number,
  message: string,
  type = 'invalid_request_error',
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type } }));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_REQUEST_BYTES) throw new Error('request too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function createGatewayServer(options: GatewayOptions): http.Server {
  const { registry, upstreams } = options;
  const doFetch = options.fetch ?? fetch;
  const env = options.env ?? (() => process.env);
  const mcp = createMcpGateway({ ...options.mcp, registry, env });
  const maxCalls = options.maxModelCallsPerAttempt ?? DEFAULT_MODEL_CALLS_PER_ATTEMPT;
  const tokenCap = options.tokenCapPerAttempt ?? DEFAULT_TOKEN_CAP_PER_ATTEMPT;

  /** One model call of an attempt that holds an in-flight slot: read, check, forward, meter. */
  async function forward(
    registration: Registration,
    upstream: Upstream,
    subpath: string,
    isModels: boolean,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: Buffer | undefined;
    let model: string | undefined;
    let streaming = false;
    let maxTokens: number | null = null;
    if (!isModels) {
      try {
        body = await readBody(req);
        const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
        model = typeof parsed.model === 'string' ? parsed.model : undefined;
        streaming = parsed.stream === true;
        maxTokens = requestedMaxTokens(parsed);
        let completed = withBodyDefaults(parsed, upstream);
        if (streaming && USAGE_ON_REQUEST_PATHS.has(subpath)) {
          completed = withStreamUsage(completed ?? parsed) ?? completed;
        }
        if (completed) body = Buffer.from(JSON.stringify(completed));
      } catch (err) {
        return error(res, 400, `invalid request body: ${(err as Error).message}`);
      }
      if (registration.models.length > 0 && (!model || !registration.models.includes(model))) {
        registry.log(registration.attemptId, {
          kind: 'model',
          model,
          decision: 'denied',
          reason: 'model not allowed',
        });
        return error(res, 403, `model ${model ?? '(none)'} is not allowed for this attempt`);
      }
    }

    const started = Date.now();
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    let response: Response;
    try {
      response = await upstreamFetch(doFetch, upstream, subpath, {
        method: req.method ?? 'POST',
        accept: req.headers.accept ?? 'application/json',
        body,
        signal: abort.signal,
      });
    } catch (err) {
      registry.log(registration.attemptId, {
        kind: 'model',
        model,
        decision: 'allowed',
        status: 502,
        reason: (err as Error).message,
      });
      return error(res, 502, `upstream unreachable: ${(err as Error).message}`, 'api_error');
    }

    const outHeaders: Record<string, string> = {};
    for (const name of RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) outHeaders[name] = value;
    }
    res.writeHead(response.status, outHeaders);
    const reader = new UsageReader(
      streaming || (response.headers.get('content-type') ?? '').includes('event-stream'),
    );
    let answerBytes = 0;
    try {
      if (response.body) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          const buffer = Buffer.from(chunk);
          answerBytes += buffer.length;
          if (!isModels) reader.feed(buffer);
          res.write(buffer);
        }
      }
    } catch {
      // The client went away or the upstream broke mid-stream; record what we saw.
    } finally {
      res.end();
      if (!isModels) {
        const reported = meteredUsage(reader.result());
        // An answer without usage is charged an estimate; a refusal (no 2xx) bills nothing.
        const answered = response.status >= 200 && response.status < 300;
        const charged =
          reported ??
          (answered
            ? estimatedUsage({ requestBytes: body?.length ?? 0, maxTokens, answerBytes })
            : null);
        registry.addUsage(registration.attemptId, charged ?? { calls: 1 });
        registry.log(registration.attemptId, {
          kind: 'model',
          model,
          decision: 'allowed',
          status: response.status,
          ms: Date.now() - started,
          // This call's own usage, so the inspector can show it per call;
          // absent when nothing was charged.
          ...(charged
            ? { promptTokens: charged.promptTokens, completionTokens: charged.completionTokens }
            : {}),
          ...(reported === null && charged ? { reason: ESTIMATED_USAGE_REASON } : {}),
        });
      }
    }
  }

  const server = http.createServer(
    guarded(async (req, res) => {
      const url = parseTarget(req.url, 'http://gateway');
      if (!url) return error(res, 400, 'malformed request target');
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }
      if (url.pathname.startsWith(MCP_PATH_PREFIX)) return mcp(req, res, url);

      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const registration = bearer ? registry.byToken(bearer) : null;
      if (!registration)
        return error(res, 401, 'invalid or expired attempt token', 'invalid_api_key');
      if (!registration.provider) return error(res, 403, 'this attempt makes no model calls');
      const upstream = resolveUpstream(registration, upstreams, env());
      if (!upstream) return error(res, 503, `no upstream configured for ${registration.provider}`);

      const subpath = url.pathname.replace(/^\/v1(?=\/)/, '');
      const isModels = req.method === 'GET' && subpath === '/models';
      if (!isModels && !(req.method === 'POST' && FORWARDED_POSTS.has(subpath))) {
        return error(res, 404, `${req.method} ${url.pathname} is not served`);
      }

      const used = registry.usage(registration.attemptId)?.totalTokens ?? 0;
      const cap = effectiveTokenCap(registration.maxTokens, tokenCap);
      if (used >= cap) {
        // Logged with its reason, so the runner's `network` event says why the agent was cut off.
        const refusal = tokenCapRefusal(used, cap);
        registry.log(registration.attemptId, {
          kind: 'model',
          decision: 'denied',
          status: TOKEN_CAP_STATUS,
          reason: refusal.reason,
        });
        res.writeHead(TOKEN_CAP_STATUS, {
          'content-type': 'application/json',
          'x-should-retry': 'false',
        });
        res.end(JSON.stringify(refusal.body));
        return;
      }
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
        return error(res, 413, `request bodies are at most ${MAX_REQUEST_BYTES} bytes`);
      }
      if (!registry.openModelCall(registration.attemptId, maxCalls)) {
        registry.log(registration.attemptId, {
          kind: 'model',
          decision: 'denied',
          reason: 'too many model calls in flight',
        });
        return error(
          res,
          429,
          `at most ${maxCalls} model calls of one attempt may be in flight`,
          'rate_limit_exceeded',
        );
      }
      try {
        await forward(registration, upstream, subpath, isModels, req, res);
      } finally {
        registry.closeModelCall(registration.attemptId);
      }
    }),
  );
  server.maxConnections = options.maxConnections ?? 512;
  server.requestTimeout = options.requestTimeoutMs ?? 60_000;
  server.headersTimeout = Math.min(server.headersTimeout, server.requestTimeout);
  return server;
}
