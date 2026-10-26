/**
 * The MCP gateway against in-process upstream servers: what reaches the
 * server (the route's headers, never the trial's token), what comes back
 * (streamed, never a redirect), every refusal, the caps, and the attempt's
 * connection log. No header value may appear in a response or a log.
 */
import http, { type IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGatewayServer } from '../src/gateway.js';
import { Registry, type LogEntry } from '../src/registry.js';

const ATTEMPT = '01K8ZQ7M3V5X9C2B4N6P8R0T1W';
const TOKEN = 't'.repeat(43);
const VENDOR_SECRET = 'vendor-secret-value-9f8e7d';
const OTHER_SECRET = 'other-secret-value-1a2b3c';

/** What the upstream saw, per request. */
interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}
const seen: Seen[] = [];
/** Resolves the held SSE stream's second event; replaced per test. */
let releaseSecondEvent: () => void = () => {};
const heldStreams: http.ServerResponse[] = [];

const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    const path = req.url!;
    if (path === '/redirect') {
      res.writeHead(307, { location: `http://127.0.0.1:${ports.elsewhere}/mcp` }).end();
    } else if (path === '/mcp/stream') {
      // One event now, the next only once the test has read the first: buffering would hang.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-1' });
      res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"step":1}}\n\n');
      void new Promise<void>((resolve) => (releaseSecondEvent = resolve)).then(() => {
        res.end('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"step":2}}\n\n');
      });
    } else if (path === '/mcp/hold') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': open\n\n');
      heldStreams.push(res);
    } else if (req.method === 'DELETE') {
      res.writeHead(204).end();
    } else if (req.method === 'HEAD') {
      res.writeHead(405).end();
    } else {
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'sess-1',
        'set-cookie': 'tracking=1',
        'x-upstream-internal': 'yes',
      });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] }, echoedLength: body.length }),
      );
    }
  });
});
const elsewhereHits: string[] = [];
const elsewhere = http.createServer((req, res) => {
  elsewhereHits.push(req.url!);
  res.end('should never be reached');
});

const ports: Record<string, number> = {};
const listen = (server: net.Server, name: string) =>
  new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      ports[name] = (server.address() as net.AddressInfo).port;
      resolve();
    }),
  );

let env: NodeJS.ProcessEnv = {};
const processLog: Array<Record<string, unknown>> = [];
const registry = new Registry();
const gateway = createGatewayServer({
  registry,
  upstreams: {},
  env: () => env,
  mcp: { maxRequestBytes: 1024, maxCallsPerAttempt: 2, log: (e) => processLog.push(e) },
});

beforeAll(async () => {
  await listen(upstream, 'upstream');
  await listen(elsewhere, 'elsewhere');
  await listen(gateway, 'gateway');
});

afterAll(() => {
  for (const res of heldStreams) res.destroy();
  for (const server of [upstream, elsewhere, gateway]) server.close();
});

const base = () => `http://127.0.0.1:${ports.upstream}`;

beforeEach(() => {
  registry.remove(ATTEMPT);
  registry.register(ATTEMPT, {
    token: TOKEN,
    mode: 'allowlist',
    provider: null,
    expiresAt: Date.now() + 60_000,
    mcp: [
      {
        name: 'vendor-api',
        url: `${base()}/mcp`,
        headers: [
          { header: 'Authorization', env: 'VENDOR_API_TOKEN' },
          { header: 'X-Other', env: 'OTHER_TOKEN' },
        ],
      },
      {
        name: 'prefixed',
        url: `${base()}/mcp`,
        headers: [{ header: 'Authorization', env: 'RAW_TOKEN', prefix: 'Bearer ' }],
      },
      { name: 'streamer', url: `${base()}/mcp/stream`, headers: [] },
      { name: 'holder', url: `${base()}/mcp/hold`, headers: [] },
      { name: 'mover', url: `${base()}/redirect`, headers: [] },
      { name: 'gone', url: 'http://127.0.0.1:9/mcp', headers: [] },
    ],
  });
  env = {
    VENDOR_API_TOKEN: `Bearer ${VENDOR_SECRET}`,
    OTHER_TOKEN: OTHER_SECRET,
    RAW_TOKEN: VENDOR_SECRET,
  };
  seen.length = 0;
  elsewhereHits.length = 0;
  processLog.length = 0;
});

interface Answer {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
}

function call(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    token?: string | null;
  } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const token = options.token === undefined ? TOKEN : options.token;
    const req = http.request({
      host: '127.0.0.1',
      port: ports.gateway,
      method: options.method ?? 'POST',
      path,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    req.on('response', (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
const mcpLog = (): LogEntry[] => registry.get(ATTEMPT)!.log.filter((e) => e.kind === 'mcp');

/** No header value in anything the trial or the log can see. */
function expectNoValue(...things: unknown[]): void {
  for (const thing of [...things, registry.get(ATTEMPT)?.log ?? [], processLog]) {
    const text = JSON.stringify(thing);
    expect(text).not.toContain(VENDOR_SECRET);
    expect(text).not.toContain(OTHER_SECRET);
    expect(text).not.toContain(TOKEN);
  }
}

describe('MCP gateway: forwarding', () => {
  it('adds the route headers from egress, strips the trial token and other headers, keeps the MCP ones', async () => {
    const answer = await call('/mcp/vendor-api', {
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': 'sess-1',
        'mcp-protocol-version': '2025-03-26',
        'last-event-id': '7',
        cookie: 'session=trial',
        'x-forwarded-for': '10.0.0.5',
        'proxy-authorization': 'Basic abc',
        'x-other': 'from-the-trial',
      },
      body: initialize,
    });
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toMatchObject({
      result: { tools: [] },
      echoedLength: initialize.length,
    });
    // Back to the trial: the MCP headers only.
    expect(answer.headers['mcp-session-id']).toBe('sess-1');
    expect(answer.headers['content-type']).toBe('application/json');
    expect(answer.headers['set-cookie']).toBeUndefined();
    expect(answer.headers['x-upstream-internal']).toBeUndefined();

    expect(seen).toHaveLength(1);
    const headers = seen[0]!.headers;
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/mcp', body: initialize });
    expect(headers.authorization).toBe(`Bearer ${VENDOR_SECRET}`);
    // The route's header replaces the trial's header of the same name.
    expect(headers['x-other']).toBe(OTHER_SECRET);
    expect(headers).toMatchObject({
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-session-id': 'sess-1',
      'mcp-protocol-version': '2025-03-26',
      'last-event-id': '7',
      host: `127.0.0.1:${ports.upstream}`,
    });
    for (const dropped of ['cookie', 'x-forwarded-for', 'proxy-authorization']) {
      expect(headers[dropped], dropped).toBeUndefined();
    }
    expect(JSON.stringify(headers)).not.toContain(TOKEN);

    expect(mcpLog()).toEqual([
      {
        at: expect.any(String),
        kind: 'mcp',
        server: 'vendor-api',
        method: 'POST',
        host: '127.0.0.1',
        port: ports.upstream,
        decision: 'allowed',
        status: 200,
        bytesUp: initialize.length,
        bytesDown: Buffer.byteLength(answer.text),
        ms: expect.any(Number),
      },
    ]);
    expectNoValue(answer);
  });

  it('writes a header’s prefix before the raw value, so .env holds only the token (Phase 7)', async () => {
    const answer = await call('/mcp/prefixed', {
      headers: { 'content-type': 'application/json' },
      body: initialize,
    });
    expect(answer.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${VENDOR_SECRET}`);
    // Without a prefix the variable is the whole value, as before (the vendor-api route above).
    await call('/mcp/vendor-api', { body: initialize });
    expect(seen[1]!.headers.authorization).toBe(`Bearer ${VENDOR_SECRET}`);
    expect(mcpLog().map((e) => [e.server, e.status, e.origin])).toEqual([
      ['prefixed', 200, undefined],
      ['vendor-api', 200, undefined],
    ]);
    expectNoValue(answer);
  });

  it('streams an SSE answer as it comes, without buffering', async () => {
    const events: string[] = [];
    const done = new Promise<{ status: number; type?: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: ports.gateway,
        method: 'POST',
        path: '/mcp/streamer',
        headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
      });
      req.on('response', (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          events.push(chunk);
          // The second event exists only after the first arrived here.
          if (events.length === 1) releaseSecondEvent();
        });
        res.on('end', () =>
          resolve({ status: res.statusCode!, type: res.headers['content-type'] }),
        );
      });
      req.on('error', reject);
      req.end(initialize);
    });
    expect(await done).toEqual({ status: 200, type: 'text/event-stream' });
    expect(events.join('')).toContain('"step":1');
    expect(events.join('')).toContain('"step":2');
    expect(events[0]).toContain('"step":1');
    expect(events[0]).not.toContain('"step":2');
  });

  it('forwards GET, DELETE and HEAD, and refuses other methods', async () => {
    expect(
      (await call('/mcp/vendor-api', { method: 'DELETE', headers: { 'mcp-session-id': 's' } }))
        .status,
    ).toBe(204);
    // Hermes's preflight sends HEAD first and falls back to GET on 405.
    expect((await call('/mcp/vendor-api', { method: 'HEAD' })).status).toBe(405);
    expect((await call('/mcp/vendor-api', { method: 'GET' })).status).toBe(200);
    expect(seen.map((s) => s.method)).toEqual(['DELETE', 'HEAD', 'GET']);

    const put = await call('/mcp/vendor-api', { method: 'PUT', body: '{}' });
    expect(put.status).toBe(405);
    expect(put.headers.allow).toBe('GET, POST, DELETE, HEAD');
    expect(seen).toHaveLength(3);
    expect(mcpLog().at(-1)).toMatchObject({ method: 'PUT', decision: 'denied', status: 405 });
  });
});

describe('MCP gateway: refusals', () => {
  it('refuses an unknown or expired token with 401, logging no token', async () => {
    expect(
      (await call('/mcp/vendor-api', { token: 'u'.repeat(43), body: initialize })).status,
    ).toBe(401);
    expect((await call('/mcp/vendor-api', { token: null, body: initialize })).status).toBe(401);
    registry.remove(ATTEMPT);
    registry.register(ATTEMPT, {
      token: TOKEN,
      mode: 'allowlist',
      provider: null,
      expiresAt: Date.now() - 1,
      mcp: [{ name: 'vendor-api', url: `${base()}/mcp` }],
    });
    expect((await call('/mcp/vendor-api', { body: initialize })).status).toBe(401);
    expect(seen).toEqual([]);
    expect(processLog).toHaveLength(3);
    expect(processLog[0]).toMatchObject({ path: '/mcp/vendor-api' });
    expectNoValue();
  });

  it('refuses a name the attempt has no route for with 404, and logs it', async () => {
    const answer = await call('/mcp/other-server', { body: initialize });
    expect(answer.status).toBe(404);
    expect((await call('/mcp/vendor-api/extra', { body: initialize })).status).toBe(404);
    expect(seen).toEqual([]);
    expect(mcpLog()).toMatchObject([
      {
        server: 'other-server',
        decision: 'denied',
        status: 404,
        reason: 'no such MCP server for this attempt',
      },
      { server: 'vendor-api?extra', decision: 'denied', status: 404 },
    ]);
  });

  it('answers 503 naming a variable egress lacks (empty counts), never a value', async () => {
    env = { OTHER_TOKEN: OTHER_SECRET };
    const missing = await call('/mcp/vendor-api', { body: initialize });
    expect(missing.status).toBe(503);
    expect(JSON.parse(missing.text).error.message).toBe(
      "VENDOR_API_TOKEN is not set in egress's environment",
    );
    env = { VENDOR_API_TOKEN: '', OTHER_TOKEN: OTHER_SECRET };
    expect((await call('/mcp/vendor-api', { body: initialize })).status).toBe(503);
    env = {
      VENDOR_API_TOKEN: `Bearer ${VENDOR_SECRET}\r\nX-Injected: 1`,
      OTHER_TOKEN: OTHER_SECRET,
    };
    const invalid = await call('/mcp/vendor-api', { body: initialize });
    expect(invalid.status).toBe(503);
    expect(invalid.text).toContain(
      'VENDOR_API_TOKEN holds a value that cannot be sent as a header',
    );
    expect(seen).toEqual([]);
    expect(mcpLog().map((e) => [e.status, e.decision])).toEqual([
      [503, 'denied'],
      [503, 'denied'],
      [503, 'denied'],
    ]);
    expectNoValue(missing, invalid);
  });

  it('follows no redirect: a 3xx answers 502 and is logged as refused', async () => {
    const answer = await call('/mcp/mover', { body: initialize });
    expect(answer.status).toBe(502);
    expect(answer.headers.location).toBeUndefined();
    expect(answer.text).toContain('307');
    expect(elsewhereHits).toEqual([]);
    expect(mcpLog()).toMatchObject([
      { server: 'mover', decision: 'denied', status: 307, reason: 'redirect refused' },
    ]);
  });

  it('answers 502 when the server cannot be reached, and logs it', async () => {
    const answer = await call('/mcp/gone', { body: initialize });
    expect(answer.status).toBe(502);
    expect(answer.text).toContain('MCP server unreachable');
    expect(mcpLog()).toMatchObject([{ server: 'gone', port: 9, status: 502, decision: 'allowed' }]);
  });

  it('refuses a query: requests go to the exact URL', async () => {
    expect((await call('/mcp/vendor-api?x=1', { body: initialize })).status).toBe(400);
    expect(seen).toEqual([]);
  });
});

describe('MCP gateway: caps', () => {
  it('refuses a declared body over the cap before contacting the server', async () => {
    const answer = await call('/mcp/vendor-api', { body: 'x'.repeat(2048) });
    expect(answer.status).toBe(413);
    expect(seen).toEqual([]);
    expect(mcpLog()).toMatchObject([{ decision: 'denied', status: 413 }]);
  });

  it('cuts a streamed body that passes the cap', async () => {
    const answer = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: ports.gateway,
        method: 'POST',
        path: '/mcp/vendor-api',
        headers: { authorization: `Bearer ${TOKEN}`, 'transfer-encoding': 'chunked' },
      });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      for (let i = 0; i < 4; i++) req.write('y'.repeat(512));
      req.end();
    });
    expect(answer).toBe(413);
    expect(mcpLog()).toMatchObject([{ decision: 'denied', status: 413 }]);
    // Never a whole body upstream.
    expect(seen.every((s) => s.body.length <= 1024)).toBe(true);
  });

  it('holds at most the per-attempt number of calls in flight, open streams included', async () => {
    const open = () =>
      new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: ports.gateway,
          method: 'GET',
          path: '/mcp/holder',
          headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
        });
        req.on('response', resolve);
        req.on('error', reject);
        req.end();
      });
    const first = await open();
    const second = await open();
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    const refused = await call('/mcp/vendor-api', { body: initialize });
    expect(refused.status).toBe(429);
    expect(mcpLog().at(-1)).toMatchObject({ decision: 'denied', status: 429 });

    // A closed stream frees its place, and closing the trial's side closes the upstream call.
    const upstreamClosed = new Promise<void>((resolve) =>
      heldStreams.at(-1)!.on('close', () => resolve()),
    );
    second.destroy();
    await upstreamClosed;
    await expect
      .poll(async () => (await call('/mcp/vendor-api', { body: initialize })).status)
      .toBe(200);
    first.destroy();
  });
});
