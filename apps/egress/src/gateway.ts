/**
 * The model gateway: an OpenAI-compatible endpoint on the trial network. A
 * trial calls it with its attempt token as the API key; the gateway checks
 * the token, the model and the budget, swaps in the real upstream credential,
 * streams the answer back unchanged, and records usage against the attempt.
 * The real credential never enters a trial, and a token stops working the
 * moment the worker removes its attempt.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { guarded, parseTarget } from './handler.js';
import type { Registry } from './registry.js';

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

export interface GatewayOptions {
  registry: Registry;
  upstreams: Record<string, Upstream>;
  fetch?: typeof fetch;
}

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

interface TokenUsage {
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

export function createGatewayServer(options: GatewayOptions): http.Server {
  const { registry, upstreams } = options;
  const doFetch = options.fetch ?? fetch;

  return http.createServer(
    guarded(async (req, res) => {
      const url = parseTarget(req.url, 'http://gateway');
      if (!url) return error(res, 400, 'malformed request target');
      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
        return;
      }

      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const registration = bearer ? registry.byToken(bearer) : null;
      if (!registration)
        return error(res, 401, 'invalid or expired attempt token', 'invalid_api_key');
      if (!registration.provider) return error(res, 403, 'this attempt makes no model calls');
      const upstream = upstreams[registration.provider];
      if (!upstream) return error(res, 503, `no upstream configured for ${registration.provider}`);

      const subpath = url.pathname.replace(/^\/v1(?=\/)/, '');
      const isModels = req.method === 'GET' && subpath === '/models';
      if (!isModels && !(req.method === 'POST' && FORWARDED_POSTS.has(subpath))) {
        return error(res, 404, `${req.method} ${url.pathname} is not served`);
      }

      const usage = registry.usage(registration.attemptId);
      if (registration.maxTokens && usage && usage.totalTokens >= registration.maxTokens) {
        registry.log(registration.attemptId, {
          kind: 'model',
          decision: 'denied',
          reason: 'token budget exhausted',
        });
        return error(res, 429, 'token budget for this attempt is exhausted', 'rate_limit_exceeded');
      }

      let body: Buffer | undefined;
      let model: string | undefined;
      let streaming = false;
      if (!isModels) {
        try {
          body = await readBody(req);
          const parsed = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
          model = typeof parsed.model === 'string' ? parsed.model : undefined;
          streaming = parsed.stream === true;
          const defaults = Object.entries(upstream.bodyDefaults ?? {}).filter(
            ([key]) => !(key in parsed),
          );
          if (defaults.length > 0)
            body = Buffer.from(JSON.stringify({ ...parsed, ...Object.fromEntries(defaults) }));
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
      const headers: Record<string, string> = { accept: req.headers.accept ?? 'application/json' };
      if (body) headers['content-type'] = 'application/json';
      if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`;

      let response: Response;
      try {
        response = await doFetch(`${upstream.baseUrl.replace(/\/$/, '')}${subpath}`, {
          method: req.method,
          headers,
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
      try {
        if (response.body) {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            const buffer = Buffer.from(chunk);
            if (!isModels) reader.feed(buffer);
            res.write(buffer);
          }
        }
      } catch {
        // The client went away or the upstream broke mid-stream; record what we saw.
      } finally {
        res.end();
        if (!isModels) {
          const used = reader.result();
          registry.addUsage(registration.attemptId, {
            calls: 1,
            promptTokens: used?.prompt_tokens ?? 0,
            completionTokens: used?.completion_tokens ?? 0,
            totalTokens: used?.total_tokens ?? 0,
          });
          registry.log(registration.attemptId, {
            kind: 'model',
            model,
            decision: 'allowed',
            status: response.status,
            ms: Date.now() - started,
          });
        }
      }
    }),
  );
}
