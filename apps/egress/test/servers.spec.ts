import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdminServer } from '../src/admin.js';
import { createGatewayServer } from '../src/gateway.js';
import { createProxyServer } from '../src/proxy.js';
import { Registry } from '../src/registry.js';

const ATTEMPT = '01K8ZQ7M3V5X9C2B4N6P8R0T1W';
const TOKEN = 'a'.repeat(64);
const REAL_KEY = 'sk-real-upstream-key';

const registry = new Registry();
const dir = mkdtempSync(join(tmpdir(), 'egress-'));
const adminSocket = join(dir, 'admin.sock');

// A local "public internet": an echo server for tunnels and a plain http server.
const echo = net.createServer((socket) => socket.pipe(socket));
const web = http.createServer((req, res) => res.end(`hello from ${req.headers.host}`));
const seenUpstream: Array<{ authorization?: string; body: string }> = [];
const upstream = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seenUpstream.push({ authorization: req.headers.authorization, body });
    const parsed = JSON.parse(body || '{}') as { stream?: boolean };
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
      res.write(
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120}}\n\n',
      );
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'hi' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    }
  });
});

const ports: Record<string, number> = {};
const listen = (server: net.Server, name: string) =>
  new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      ports[name] = (server.address() as net.AddressInfo).port;
      resolve();
    }),
  );

const resolveFake = async (host: string): Promise<string[]> => {
  const table: Record<string, string[]> = {
    'example.com': ['93.184.216.34'],
    'localtest.me': ['127.0.0.1'],
  };
  if (!table[host]) throw new Error('ENOTFOUND');
  return table[host]!;
};

// Allowed connections to "93.184.216.34" are redirected to the local echo or web server.
const proxy = createProxyServer({
  registry,
  resolve: resolveFake,
  connect: (_address, port) =>
    net.connect({ host: '127.0.0.1', port: port === 80 ? ports.web! : ports.echo! }),
});
let gateway: http.Server;
const admin = createAdminServer(registry);

beforeAll(async () => {
  await listen(echo, 'echo');
  await listen(web, 'web');
  await listen(upstream, 'upstream');
  gateway = createGatewayServer({
    registry,
    upstreams: {
      mock: {
        baseUrl: `http://127.0.0.1:${ports.upstream}/v1`,
        apiKey: REAL_KEY,
        bodyDefaults: { reasoning: { enabled: true, effort: 'medium' } },
      },
    },
  });
  await listen(proxy, 'proxy');
  await listen(gateway, 'gateway');
  await new Promise<void>((resolve) => admin.listen(adminSocket, resolve));
});

afterAll(async () => {
  for (const server of [echo, web, upstream, proxy, gateway, admin]) server.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  registry.remove(ATTEMPT);
  registry.register(ATTEMPT, {
    token: TOKEN,
    mode: 'public',
    provider: 'mock',
    models: ['mock/scripted'],
    maxTokens: 200,
    expiresAt: Date.now() + 60_000,
  });
  seenUpstream.length = 0;
});

const basic = (id: string, token: string) =>
  `Basic ${Buffer.from(`${id}:${token}`).toString('base64')}`;

/** Sends a CONNECT and returns the status line and, if established, the echoed payload. */
function tunnel(
  authority: string,
  auth?: string,
): Promise<{ status: number; echoed?: string; reason?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: ports.proxy,
      method: 'CONNECT',
      path: authority,
      headers: auth ? { 'proxy-authorization': auth } : {},
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return resolve({
          status: res.statusCode!,
          reason: res.headers['x-egress-reason'] as string,
        });
      }
      socket.write('ping');
      socket.once('data', (data) => {
        socket.destroy();
        resolve({ status: 200, echoed: data.toString() });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('forward proxy', () => {
  it('requires the attempt credentials', async () => {
    expect((await tunnel('example.com:443')).status).toBe(407);
    expect((await tunnel('example.com:443', basic(ATTEMPT, 'b'.repeat(64)))).status).toBe(407);
  });

  it('refuses a token after it expires', async () => {
    registry.remove(ATTEMPT);
    registry.register(ATTEMPT, {
      token: TOKEN,
      mode: 'public',
      provider: null,
      expiresAt: Date.now() - 1,
    });
    expect((await tunnel('example.com:443', basic(ATTEMPT, TOKEN))).status).toBe(407);
  });

  it.each([
    '127.0.0.1:443',
    '[::1]:443',
    '[::ffff:127.0.0.1]:443',
    '10.0.0.1:443',
    '169.254.169.254:80',
    'localtest.me:443',
    'postgres:5432',
    'api:3000',
    'host.docker.internal:443',
    'example.com:22',
    'nowhere.invalid:443',
  ])('refuses %s', async (authority) => {
    const result = await tunnel(authority, basic(ATTEMPT, TOKEN));
    expect(result.status, result.reason).toBe(403);
  });

  it('tunnels to an allowed public host and logs it', async () => {
    const result = await tunnel('example.com:443', basic(ATTEMPT, TOKEN));
    expect(result).toEqual({ status: 200, echoed: 'ping' });
    // The entry is written as the tunnel closes; under load that can trail the echo.
    const entry = await vi.waitFor(
      () => {
        const found = registry.get(ATTEMPT)!.log.find((e) => e.decision === 'allowed');
        if (!found) throw new Error('no allowed entry yet');
        return found;
      },
      { timeout: 2000, interval: 10 },
    );
    expect(entry).toMatchObject({
      kind: 'connect',
      host: 'example.com',
      ip: '93.184.216.34',
      port: 443,
    });
  });

  it('proxies plain http to an allowed host and refuses a private one', async () => {
    const get = (url: string) =>
      new Promise<{ status: number; body: string }>((resolve) => {
        http
          .get(
            {
              host: '127.0.0.1',
              port: ports.proxy,
              path: url,
              headers: { 'proxy-authorization': basic(ATTEMPT, TOKEN) },
            },
            (res) => {
              let body = '';
              res.on('data', (c) => (body += c));
              res.on('end', () => resolve({ status: res.statusCode!, body }));
            },
          )
          .end();
      });
    expect(await get('http://example.com/')).toEqual({
      status: 200,
      body: 'hello from example.com',
    });
    expect((await get('http://127.0.0.1/')).status).toBe(403);
    expect((await get('http://user:pass@example.com/')).status).toBe(403);
  });
});

function chat(token: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: ports.gateway,
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    req.on('response', (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode!, text }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('model gateway', () => {
  it('refuses an unknown token and a model the attempt may not use', async () => {
    expect((await chat('nope'.repeat(10), { model: 'mock/scripted' })).status).toBe(401);
    expect((await chat(TOKEN, { model: 'openai/gpt-6.1-sol' })).status).toBe(403);
    expect(seenUpstream).toEqual([]);
  });

  it('swaps in the real key, never forwards the attempt token, and meters usage', async () => {
    const res = await chat(TOKEN, { model: 'mock/scripted', stream: true, messages: [] });
    expect(res.status).toBe(200);
    expect(res.text).toContain('[DONE]');
    expect(seenUpstream[0]!.authorization).toBe(`Bearer ${REAL_KEY}`);
    expect(seenUpstream[0]!.body).not.toContain(TOKEN);
    expect(registry.usage(ATTEMPT)).toEqual({
      calls: 1,
      promptTokens: 100,
      completionTokens: 20,
      totalTokens: 120,
    });
    await chat(TOKEN, { model: 'mock/scripted', messages: [] });
    expect(registry.usage(ATTEMPT)!.totalTokens).toBe(135);
    // Each call's own usage is in the connection log, for the inspector's model rows.
    const calls = registry.get(ATTEMPT)!.log.filter((e) => e.kind === 'model');
    expect(calls).toEqual([
      expect.objectContaining({ status: 200, promptTokens: 100, completionTokens: 20 }),
      expect.objectContaining({ status: 200, promptTokens: 10, completionTokens: 5 }),
    ]);
  });

  it('adds upstream default fields the request did not set, and keeps the ones it did', async () => {
    await chat(TOKEN, { model: 'mock/scripted', messages: [] });
    await chat(TOKEN, { model: 'mock/scripted', messages: [], reasoning: { enabled: false } });
    expect(JSON.parse(seenUpstream[0]!.body).reasoning).toEqual({
      enabled: true,
      effort: 'medium',
    });
    expect(JSON.parse(seenUpstream[1]!.body).reasoning).toEqual({ enabled: false });
  });

  it('stops serving once the attempt budget is spent', async () => {
    await chat(TOKEN, { model: 'mock/scripted', stream: true });
    await chat(TOKEN, { model: 'mock/scripted', stream: true });
    expect((await chat(TOKEN, { model: 'mock/scripted', stream: true })).status).toBe(429);
  });

  it('stops serving as soon as the attempt is removed', async () => {
    registry.remove(ATTEMPT);
    expect((await chat(TOKEN, { model: 'mock/scripted' })).status).toBe(401);
  });

  it('holds at most 8 calls of one attempt in flight, and frees a slot when one ends', async () => {
    const id = '01K8ZQ7M3V5X9C2B4N6P8R0T2X';
    const token = 'c'.repeat(64);
    registry.register(id, {
      token,
      mode: 'allowlist',
      provider: 'mock',
      expiresAt: Date.now() + 60_000,
    });
    // Uploads that never finish: each holds a slot while its body is read.
    const uploads = Array.from({ length: 8 }, () =>
      net.connect(ports.gateway!, '127.0.0.1', function (this: net.Socket) {
        this.write(
          'POST /v1/chat/completions HTTP/1.1\r\nHost: egress\r\n' +
            `Authorization: Bearer ${token}\r\nContent-Type: application/json\r\n` +
            'Content-Length: 100000\r\n\r\n{"model":',
        );
      }),
    );
    try {
      await vi.waitFor(() => expect(registry.modelCallsInFlight(id)).toBe(8), { timeout: 5000 });
      const refused = await chat(token, { model: 'mock/scripted', messages: [] });
      expect(refused.status).toBe(429);
      expect(JSON.parse(refused.text)).toMatchObject({ error: { type: 'rate_limit_exceeded' } });
      expect(registry.get(id)!.log).toContainEqual(
        expect.objectContaining({
          kind: 'model',
          decision: 'denied',
          reason: 'too many model calls in flight',
        }),
      );
      uploads[0]!.destroy();
      await vi.waitFor(() => expect(registry.modelCallsInFlight(id)).toBe(7), { timeout: 5000 });
      expect((await chat(token, { model: 'mock/scripted', messages: [] })).status).toBe(200);
      expect(registry.modelCallsInFlight(id)).toBe(7);
    } finally {
      for (const socket of uploads) socket.destroy();
      await vi.waitFor(() => expect(registry.modelCallsInFlight(id)).toBe(0), { timeout: 5000 });
      registry.remove(id);
    }
  });

  it('refuses a body declared larger than 10 MiB before reading it, holding no slot', async () => {
    const line = await raw(
      ports.gateway!,
      'POST /v1/chat/completions HTTP/1.1\r\nHost: egress\r\n' +
        `Authorization: Bearer ${TOKEN}\r\nContent-Length: ${20 * 1024 * 1024}\r\n\r\n`,
    );
    expect(line).toBe('HTTP/1.1 413 Payload Too Large');
    expect(registry.modelCallsInFlight(ATTEMPT)).toBe(0);
  });
});

function adminCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: adminSocket, method, path });
    req.on('response', (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () =>
        resolve({ status: res.statusCode!, json: text ? JSON.parse(text) : null }),
      );
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** Sends raw bytes to a port and returns the first response line. */
function raw(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\r\n')) {
        socket.destroy();
        resolve(data.split('\r\n')[0]!);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
  });
}

describe('malformed requests', () => {
  // Node's parser accepts these absolute-form targets; the URL parser does not.
  const targets = ['http://a:99999/x', 'http://[/x', 'http://[::1/x'];

  it('get 400 from the gateway, before any token check, and the gateway keeps serving', async () => {
    for (const target of targets) {
      expect(await raw(ports.gateway!, `GET ${target} HTTP/1.1\r\nHost: a\r\n\r\n`)).toMatch(
        /^HTTP\/1\.1 400/,
      );
    }
    const health = await fetch(`http://127.0.0.1:${ports.gateway}/health`);
    expect(health.status).toBe(200);
  });

  it('get 400 from the proxy with valid credentials, and the proxy keeps serving', async () => {
    const auth = `Proxy-Authorization: ${basic(ATTEMPT, TOKEN)}\r\n`;
    for (const target of targets) {
      expect(await raw(ports.proxy!, `GET ${target} HTTP/1.1\r\nHost: a\r\n${auth}\r\n`)).toMatch(
        /^HTTP\/1\.1 400/,
      );
    }
    expect((await tunnel('example.com:443', basic(ATTEMPT, TOKEN))).status).toBe(200);
  });
});

describe('admin socket', () => {
  it('registers, reads and removes an attempt, returning its usage and log', async () => {
    const id = '01K8ZQ7M3V5X9C2B4N6P8R0T1X';
    const put = await adminCall('PUT', `/attempts/${id}`, {
      token: 'c'.repeat(64),
      mode: 'allowlist',
      provider: 'mock',
      expiresAt: Date.now() + 60_000,
    });
    expect(put.status).toBe(204);
    const got = (await adminCall('GET', `/attempts/${id}`)).json as {
      registration: Record<string, unknown>;
    };
    expect(got.registration.token).toBeUndefined();
    const removed = await adminCall('DELETE', `/attempts/${id}`);
    expect(removed.json).toEqual({
      usage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      log: [],
    });
    expect((await adminCall('GET', `/attempts/${id}`)).status).toBe(404);
  });

  it('rejects a registration with a weak token or unknown fields', async () => {
    const id = '01K8ZQ7M3V5X9C2B4N6P8R0T1Y';
    expect(
      (
        await adminCall('PUT', `/attempts/${id}`, {
          token: 'short',
          mode: 'public',
          provider: null,
          expiresAt: 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await adminCall('PUT', `/attempts/${id}`, {
          token: 'd'.repeat(64),
          mode: 'public',
          provider: null,
          expiresAt: 1,
          allowAll: true,
        })
      ).status,
    ).toBe(400);
  });
});
