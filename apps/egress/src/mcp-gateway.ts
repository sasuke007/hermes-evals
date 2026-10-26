/**
 * The MCP gateway (plan 5.3): `http://egress:8080/mcp/<name>` on the trial
 * network. A trial's config.yaml points each http MCP server here with
 * `Authorization: Bearer ${HERMES_EVALS_ATTEMPT_TOKEN}`, which Hermes fills
 * from the container environment. The gateway checks that token, finds the
 * attempt's route by name, and forwards the request to the definition's
 * exact URL with the definition's headers added from egress's own
 * environment, each after its fixed prefix when the definition gives one
 * (`Bearer `, Phase 7). Header values never enter a trial, and none is ever
 * logged or echoed: errors name the variable, never its value.
 *
 * Streamable HTTP: POST carries JSON-RPC and may be answered with JSON or an
 * SSE stream, GET opens the server's SSE stream, DELETE ends the session, and
 * Hermes's preflight probe sends HEAD first. Bodies stream through in both
 * directions unchanged and unbuffered. No redirect is followed: a 3xx answers
 * 502, so a server cannot send the request, with its headers, elsewhere.
 *
 * Only these request headers are forwarded: Accept, Content-Type,
 * Content-Length, Mcp-Session-Id, MCP-Protocol-Version and Last-Event-ID.
 * Everything else, the trial's Authorization and every hop-by-hop header
 * included, stays here. The upstream may be a private address: the
 * definition chooses it, and the agent cannot.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { LogEntry, McpRoute, Registration, Registry } from './registry.js';

export interface McpGatewayOptions {
  registry: Registry;
  /** Where header values are read, on every request; process.env unless a test supplies one. */
  env?: () => NodeJS.ProcessEnv;
  /** Largest request body forwarded (default 4 MiB). */
  maxRequestBytes?: number;
  /** In-flight calls per attempt, open SSE streams included (default 16). */
  maxCallsPerAttempt?: number;
  /** An upstream socket idle this long is closed (default 300 s, Hermes's SSE read timeout). */
  idleTimeoutMs?: number;
  /** Process log for what has no attempt to log against (an unknown token). */
  log?: (entry: Record<string, unknown>) => void;
}

export const MCP_PATH_PREFIX = '/mcp/';
const ROUTE_PATH = /^\/mcp\/([a-z0-9][a-z0-9_-]{0,62})$/;
const METHODS = new Set(['GET', 'POST', 'DELETE', 'HEAD']);
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'content-length',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
];
const RETURNED_RESPONSE_HEADERS = [
  'content-type',
  'content-encoding',
  'cache-control',
  'mcp-session-id',
  'mcp-protocol-version',
  'retry-after',
];
/** What Node refuses in a header value: control characters other than tab, and non-latin1. */
// oxlint-disable-next-line no-control-regex -- the point is to find control characters
const INVALID_HEADER_VALUE = /[^\t\x20-\x7e\x80-\xff]/;

export const DEFAULT_MCP_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MCP_CALLS_PER_ATTEMPT = 16;
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;

class RequestTooLarge extends Error {}

/** Counts the bytes that pass and fails the stream past `max`. */
class ByteCounter extends Transform {
  bytes = 0;
  constructor(private readonly max = Infinity) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.max) return done(new RequestTooLarge(`more than ${this.max} bytes`));
    done(null, chunk);
  }
}

function fail(
  res: ServerResponse,
  status: number,
  message: string,
  extra: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify({ error: { message, type: 'mcp_gateway_error' } }));
}

/** What the upstream gets: the forwarded few, then the route's own from egress's env. */
function upstreamHeaders(
  req: IncomingMessage,
  route: McpRoute,
  env: NodeJS.ProcessEnv,
): { ok: true; headers: Record<string, string> } | { ok: false; reason: string } {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  for (const { header, env: variable, prefix } of route.headers) {
    const value = env[variable];
    if (!value) return { ok: false, reason: `${variable} is not set in egress's environment` };
    if (INVALID_HEADER_VALUE.test(value)) {
      return { ok: false, reason: `${variable} holds a value that cannot be sent as a header` };
    }
    // A route header replaces a forwarded one of the same name (case-insensitively).
    const lower = header.toLowerCase();
    for (const key of Object.keys(headers)) if (key === lower) delete headers[key];
    // The prefix (`Bearer `) is the definition's, printable ASCII by the registration's rule.
    headers[header] = `${prefix ?? ''}${value}`;
  }
  return { ok: true, headers };
}

export function createMcpGateway(options: McpGatewayOptions) {
  const { registry } = options;
  const env = options.env ?? (() => process.env);
  const maxBytes = options.maxRequestBytes ?? DEFAULT_MCP_MAX_REQUEST_BYTES;
  const maxCalls = options.maxCallsPerAttempt ?? DEFAULT_MCP_CALLS_PER_ATTEMPT;
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

  /** Handles one request whose path starts with /mcp/. Never throws for a refused call. */
  return async function handleMcp(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const registration = bearer ? registry.byToken(bearer) : null;
    if (!registration) {
      // No attempt to log against; the process log names the path, never the token.
      options.log?.({ msg: 'mcp gateway refused an unknown or expired token', path: url.pathname });
      return fail(res, 401, 'invalid or expired attempt token');
    }
    const method = req.method ?? 'GET';
    const name = ROUTE_PATH.exec(url.pathname)?.[1];
    const route = name ? registration.mcp.find((r) => r.name === name) : undefined;
    // The trial chose this text: kept short and printable for the connection log.
    const server =
      name ??
      url.pathname
        .slice(MCP_PATH_PREFIX.length, MCP_PATH_PREFIX.length + 63)
        .replace(/[^\w.-]/g, '?');
    const deny = (status: number, reason: string, extra: Partial<LogEntry> = {}) => {
      registry.log(registration.attemptId, {
        kind: 'mcp',
        server,
        method,
        decision: 'denied',
        reason,
        status,
        ...extra,
      });
    };
    if (!route) {
      deny(404, 'no such MCP server for this attempt');
      return fail(res, 404, `no MCP server ${server} for this attempt`);
    }
    const target = new URL(route.url);
    const where = { host: target.hostname, port: Number(target.port) || defaultPort(target) };
    if (url.search !== '') {
      deny(400, 'the gateway forwards to the exact URL; no query', where);
      return fail(
        res,
        400,
        'the MCP gateway forwards to the definition URL as it is; send no query',
      );
    }
    if (!METHODS.has(method)) {
      deny(405, `${method} is not an MCP method`, where);
      return fail(res, 405, `${method} is not served`, { allow: [...METHODS].join(', ') });
    }
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBytes) {
      deny(413, `request body over ${maxBytes} bytes`, where);
      return fail(res, 413, `request body is over ${maxBytes} bytes`);
    }
    const built = upstreamHeaders(req, route, env());
    if (!built.ok) {
      deny(503, built.reason, where);
      return fail(res, 503, built.reason);
    }
    if (!registry.openMcpCall(registration.attemptId, maxCalls)) {
      deny(429, 'too many MCP calls in flight', where);
      return fail(res, 429, `at most ${maxCalls} MCP calls may be in flight per attempt`);
    }
    try {
      await forward(req, res, { registration, route, target, method, headers: built.headers });
    } finally {
      registry.closeMcpCall(registration.attemptId);
    }
  };

  /** Sends the request upstream and streams the answer back; logs the call once. */
  async function forward(
    req: IncomingMessage,
    res: ServerResponse,
    call: {
      registration: Registration;
      route: McpRoute;
      target: URL;
      method: string;
      headers: Record<string, string>;
    },
  ): Promise<void> {
    const { registration, route, target, method } = call;
    const started = Date.now();
    const up = new ByteCounter(maxBytes);
    const down = new ByteCounter();
    const port = Number(target.port) || defaultPort(target);
    let logged = false;
    const record = (entry: Pick<LogEntry, 'decision' | 'status' | 'reason'>) => {
      if (logged) return;
      logged = true;
      registry.log(registration.attemptId, {
        kind: 'mcp',
        server: route.name,
        method,
        host: target.hostname,
        port,
        bytesUp: up.bytes,
        bytesDown: down.bytes,
        ms: Date.now() - started,
        ...entry,
      });
    };

    const client = (target.protocol === 'https:' ? https : http).request(target, {
      method,
      headers: call.headers,
      timeout: idleMs,
    });
    client.on('timeout', () => client.destroy(new Error(`no data for ${idleMs} ms`)));

    await new Promise<void>((resolve) => {
      /** Set once the trial's answer is decided: later upstream errors change nothing. */
      let settled = false;
      const settle = () => {
        settled = true;
        resolve();
      };
      // The trial went away: end the upstream call too (an SSE stream would otherwise stay open).
      res.on('close', () => {
        if (res.writableFinished) return;
        client.destroy(new Error('the trial closed the connection'));
        record({
          decision: 'allowed',
          status: res.headersSent ? res.statusCode : undefined,
          reason: 'the trial closed the connection',
        });
        if (!settled) settle();
      });

      client.on('response', (response) => {
        if (settled) return void response.resume();
        const status = response.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          response.resume();
          record({ decision: 'denied', status, reason: 'redirect refused' });
          fail(res, 502, `the MCP server answered ${status} (a redirect); egress follows none`);
          client.destroy();
          return settle();
        }
        const headers: Record<string, string> = {};
        for (const name of RETURNED_RESPONSE_HEADERS) {
          const value = response.headers[name];
          if (typeof value === 'string') headers[name] = value;
        }
        res.writeHead(status, headers);
        // Headers now, so an SSE stream's reader sees the answer before the first event.
        res.flushHeaders();
        pipeline(response, down, res)
          .then(() => record({ decision: 'allowed', status }))
          .catch((err: Error) => record({ decision: 'allowed', status, reason: err.message }))
          .finally(settle);
      });

      client.on('error', (err) => {
        if (settled) return;
        if (res.headersSent) {
          // Broken mid-stream: the pipeline above records it and closes the trial's response.
          res.destroy();
          return;
        }
        const tooLarge = err instanceof RequestTooLarge;
        const status = tooLarge ? 413 : 502;
        const reason = tooLarge ? `request body over ${maxBytes} bytes` : err.message;
        record({ decision: tooLarge ? 'denied' : 'allowed', status, reason });
        fail(res, status, tooLarge ? reason : `MCP server unreachable: ${err.message}`, {
          connection: 'close',
        });
        settle();
      });

      // The body streams through as it arrives. Past the cap the upstream call is torn down and
      // the rest of the body is drained, so the trial still gets its 413.
      up.on('error', (err) => {
        req.unpipe(up);
        req.resume();
        client.destroy(err);
      });
      req.on('error', (err) => client.destroy(err));
      req.pipe(up).pipe(client);
    });
  }
}

function defaultPort(url: URL): number {
  return url.protocol === 'https:' ? 443 : 80;
}
