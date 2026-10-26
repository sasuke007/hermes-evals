/**
 * What an attempt registration may hold (MCP routes, a custom upstream, the
 * token), what each refusal says over the admin socket, how a `custom`
 * attempt's model calls reach its own base URL, and allowlist mode: CONNECT
 * refuses every host when allowHosts is empty.
 */
import http, { type IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminServer } from '../src/admin.js';
import { createGatewayServer } from '../src/gateway.js';
import { createProxyServer } from '../src/proxy.js';
import {
  EXPIRED_RETENTION_MS,
  Registry,
  RegistrationSchema,
  type RegistrationInput,
} from '../src/registry.js';

const ATTEMPT = '01K8ZQ7M3V5X9C2B4N6P8R0T2A';
const TOKEN = 'k'.repeat(43);
const CUSTOM_KEY = 'sk-custom-endpoint-key';

const valid: RegistrationInput = {
  token: TOKEN,
  mode: 'allowlist',
  provider: null,
  expiresAt: Date.now() + 60_000,
  mcp: [
    {
      name: 'vendor-api',
      url: 'http://192.168.5.2:9000/mcp',
      headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }],
    },
  ],
};

describe('RegistrationSchema', () => {
  it('accepts MCP routes to private addresses and a custom upstream', () => {
    expect(RegistrationSchema.parse(valid).mcp[0]!.url).toBe('http://192.168.5.2:9000/mcp');
    expect(
      RegistrationSchema.parse({
        ...valid,
        provider: 'custom',
        models: ['mock/scripted'],
        upstream: { baseUrl: 'http://mock-model:8090/v1' },
      }).upstream,
    ).toEqual({ baseUrl: 'http://mock-model:8090/v1' });
    // Routes and their headers default to none.
    expect(RegistrationSchema.parse({ ...valid, mcp: undefined }).mcp).toEqual([]);
  });

  const route = valid.mcp![0]!;
  const withRoute = (over: Record<string, unknown>) => ({ ...valid, mcp: [{ ...route, ...over }] });
  const header = (h: string, env = 'VENDOR_API_TOKEN') =>
    withRoute({ headers: [{ header: h, env }] });

  const prefixed = (prefix: unknown) =>
    withRoute({ headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN', prefix }] });

  it('accepts a header prefix of printable ASCII, and a header without one (Phase 7)', () => {
    expect(RegistrationSchema.parse(prefixed('Bearer ')).mcp[0]!.headers).toEqual([
      { header: 'Authorization', env: 'VENDOR_API_TOKEN', prefix: 'Bearer ' },
    ]);
    expect(RegistrationSchema.parse(prefixed('x'.repeat(64))).mcp).toHaveLength(1);
    expect(RegistrationSchema.parse(valid).mcp[0]!.headers[0]).not.toHaveProperty('prefix');
  });

  it.each<[string, unknown]>([
    ['an empty prefix', ''],
    ['a prefix with a line break', 'Bearer\r\nX-Injected: 1 '],
    ['a prefix with a tab', 'Bearer\t'],
    ['a prefix over 64 characters', 'x'.repeat(65)],
    ['a prefix outside ASCII', 'Bearér '],
    ['a null prefix', null],
  ])('refuses %s', (_label, prefix) => {
    expect(RegistrationSchema.safeParse(prefixed(prefix)).success).toBe(false);
  });

  it.each<[string, unknown]>([
    ['an ftp url', withRoute({ url: 'ftp://files.example.com/mcp' })],
    ['a file url', withRoute({ url: 'file:///etc/passwd' })],
    ['a relative url', withRoute({ url: '/mcp' })],
    ['credentials in the url', withRoute({ url: 'https://user:pw@vendor.example.com/mcp' })],
    ['a user in the url', withRoute({ url: 'https://user@vendor.example.com/mcp' })],
    ['a lower-case env name', header('Authorization', 'vendor_token')],
    ['an env name starting with a digit', header('Authorization', '1TOKEN')],
    ['a Host header', header('Host')],
    ['a Connection header', header('connection')],
    ['a Transfer-Encoding header', header('Transfer-Encoding')],
    ['a Content-Length header', header('Content-Length')],
    ['a Proxy-Authorization header', header('Proxy-Authorization')],
    ['an Upgrade header', header('Upgrade')],
    ['a header name with a space', header('X Api')],
    [
      'a repeated header',
      withRoute({
        headers: [
          { header: 'X-Key', env: 'A_KEY' },
          { header: 'x-key', env: 'B_KEY' },
        ],
      }),
    ],
    ['an unknown route field', withRoute({ follow: true })],
    ['a route name that is not a slug', withRoute({ name: '../admin' })],
    ['a repeated route name', { ...valid, mcp: [route, route] }],
    ['provider custom without an upstream', { ...valid, provider: 'custom' }],
    [
      'an upstream for another provider',
      { ...valid, provider: 'openrouter', upstream: { baseUrl: 'http://x/v1' } },
    ],
    [
      'an upstream with credentials',
      { ...valid, provider: 'custom', upstream: { baseUrl: 'http://u:p@x/v1' } },
    ],
    ['a token with a colon', { ...valid, token: `${'a'.repeat(40)}:bcd` }],
    ['a token with a space', { ...valid, token: `${'a'.repeat(40)} bcd` }],
  ])('refuses %s', (_label, input) => {
    expect(RegistrationSchema.safeParse(input).success).toBe(false);
  });
});

describe('Registry.register', () => {
  it('refuses a route that names a provider credential as a header variable', () => {
    const registry = new Registry(Date.now, { credentialEnvNames: ['MY_PROVIDER_KEY'] });
    for (const env of ['OPENROUTER_API_KEY', 'CUSTOM_API_KEY', 'NOUS_API_KEY', 'MY_PROVIDER_KEY']) {
      const input = {
        ...valid,
        mcp: [{ ...valid.mcp![0]!, headers: [{ header: 'Authorization', env }] }],
      };
      expect(() => registry.register(ATTEMPT, input), env).toThrow(/provider credential/);
    }
    expect(registry.size).toBe(0);
    expect(registry.register(ATTEMPT, valid).mcp).toHaveLength(1);
  });

  it('refuses a route whose header variable egress does not hold, naming it', () => {
    let env: NodeJS.ProcessEnv = {};
    const registry = new Registry(Date.now, { env: () => env });
    const two = {
      ...valid,
      mcp: [
        { ...valid.mcp![0]!, headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }] },
        {
          name: 'other',
          url: 'https://other.example.com/mcp',
          headers: [{ header: 'X-Key', env: 'OTHER_KEY' }],
        },
      ],
    };
    expect(() => registry.register(ATTEMPT, two)).toThrow(
      "mcp: VENDOR_API_TOKEN and OTHER_KEY are not set in egress's environment; the MCP servers that use them cannot start",
    );
    // An empty value is not set either: it gives egress nothing to send.
    env = { VENDOR_API_TOKEN: 'secret', OTHER_KEY: '' };
    expect(() => registry.register(ATTEMPT, two)).toThrow(/OTHER_KEY is not set/);
    expect(registry.size).toBe(0);
    env = { VENDOR_API_TOKEN: 'secret', OTHER_KEY: 'k' };
    expect(registry.register(ATTEMPT, two).mcp).toHaveLength(2);
  });
});

describe('Registry expiry', () => {
  it('counts only live registrations, and drops one 10 minutes after it expired', () => {
    let now = 1_000_000;
    const registry = new Registry(() => now);
    registry.register(ATTEMPT, { ...valid, mcp: [], expiresAt: now + 60_000 });
    expect(registry.size).toBe(1);
    // Expired: refused and no longer counted, but a late remove still gets its report.
    now += 60_000;
    expect(registry.authenticate(ATTEMPT, TOKEN)).toBeNull();
    expect(registry.size).toBe(0);
    expect(registry.get(ATTEMPT)).not.toBeNull();
    // An attempt nobody removes (its worker died) is dropped after the retention.
    now += EXPIRED_RETENTION_MS;
    expect(registry.size).toBe(0);
    expect(registry.get(ATTEMPT)).toBeNull();
    expect(registry.remove(ATTEMPT)).toBeNull();
  });

  it('a late remove within the retention returns the usage', () => {
    let now = 1_000_000;
    const registry = new Registry(() => now);
    registry.register(ATTEMPT, { ...valid, mcp: [], expiresAt: now + 1 });
    now += EXPIRED_RETENTION_MS - 1;
    registry.register('01K8ZQ7M3V5X9C2B4N6P8R0T2B', { ...valid, mcp: [], expiresAt: now + 60_000 });
    expect(registry.remove(ATTEMPT)).toMatchObject({ usage: { calls: 0 } });
  });
});

describe('admin socket registration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-reg-'));
  const socket = join(dir, 'admin.sock');
  const registry = new Registry();
  const admin = createAdminServer(registry);

  beforeAll(() => new Promise<void>((resolve) => admin.listen(socket, resolve)));
  afterAll(() => {
    admin.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const put = (body: unknown) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request({ socketPath: socket, method: 'PUT', path: `/attempts/${ATTEMPT}` });
      req.on('response', (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode!, text }));
      });
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });

  it('answers 400 with the issue for a bad route, and 204 for a good one', async () => {
    const bad = await put({
      ...valid,
      mcp: [{ ...valid.mcp![0]!, url: 'https://u:p@x.example.com/mcp' }],
    });
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.text).message.join('\n')).toMatch(
      /^mcp\.0\.url: must be an http\(s\) URL/,
    );
    const credential = await put({
      ...valid,
      mcp: [{ ...valid.mcp![0]!, headers: [{ header: 'Authorization', env: 'OPENAI_API_KEY' }] }],
    });
    expect(credential).toMatchObject({ status: 400 });
    expect(credential.text).toContain('OPENAI_API_KEY holds a provider credential');
    expect((await put(valid)).status).toBe(204);
    // The routes read back with names only, never a value, and no token.
    expect(registry.get(ATTEMPT)!.registration).toMatchObject({ mcp: valid.mcp });
    expect(JSON.stringify(registry.get(ATTEMPT))).not.toContain(TOKEN);
  });
});

describe('custom model upstream', () => {
  const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: string }> = [];
  const model = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ url: req.url!, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    });
  });
  const registry = new Registry();
  let env: NodeJS.ProcessEnv = {};
  const gateway = createGatewayServer({ registry, upstreams: {}, env: () => env });
  let modelPort = 0;
  let gatewayPort = 0;

  beforeAll(async () => {
    await new Promise<void>((r) => model.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
    modelPort = (model.address() as net.AddressInfo).port;
    gatewayPort = (gateway.address() as net.AddressInfo).port;
  });
  afterAll(() => {
    model.close();
    gateway.close();
  });
  beforeEach(() => {
    seen.length = 0;
    registry.remove(ATTEMPT);
    registry.register(ATTEMPT, {
      token: TOKEN,
      mode: 'allowlist',
      provider: 'custom',
      // A private address: the configuration chose it, the agent cannot.
      upstream: { baseUrl: `http://127.0.0.1:${modelPort}/v1` },
      models: ['mock/scripted'],
      expiresAt: Date.now() + 60_000,
    });
  });

  const chat = (body: unknown) =>
    fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('forwards to the registered base URL with CUSTOM_API_KEY, never the attempt token', async () => {
    env = { CUSTOM_API_KEY: CUSTOM_KEY };
    const res = await chat({ model: 'mock/scripted', messages: [] });
    expect(res.status).toBe(200);
    expect(seen).toMatchObject([{ url: '/v1/chat/completions' }]);
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${CUSTOM_KEY}`);
    expect(JSON.stringify(seen[0])).not.toContain(TOKEN);
    expect(registry.usage(ATTEMPT)).toMatchObject({ calls: 1, totalTokens: 5 });
    expect((await chat({ model: 'openai/gpt-6.1-sol', messages: [] })).status).toBe(403);
  });

  it('sends no credential when CUSTOM_API_KEY is not set (empty counts)', async () => {
    env = { CUSTOM_API_KEY: '' };
    expect((await chat({ model: 'mock/scripted', messages: [] })).status).toBe(200);
    expect(seen[0]!.headers.authorization).toBeUndefined();
  });
});

describe('allowlist mode (UI_FLOWS 19 #16)', () => {
  const registry = new Registry();
  const resolved: string[] = [];
  const connected: string[] = [];
  const proxy = createProxyServer({
    registry,
    resolve: async (host) => {
      resolved.push(host);
      return ['93.184.216.34'];
    },
    connect: (address, port) => {
      connected.push(`${address}:${port}`);
      return net.connect({ host: '127.0.0.1', port: 9 });
    },
  });
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    port = (proxy.address() as net.AddressInfo).port;
  });
  afterAll(() => proxy.close());

  const auth = `Basic ${Buffer.from(`${ATTEMPT}:${TOKEN}`).toString('base64')}`;
  const connect = (authority: string) =>
    new Promise<{ status: number; reason?: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port,
        method: 'CONNECT',
        path: authority,
        headers: { 'proxy-authorization': auth },
      });
      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve({ status: res.statusCode!, reason: res.headers['x-egress-reason'] as string });
      });
      req.on('error', reject);
      req.end();
    });

  it('refuses every CONNECT and plain http request when allowHosts is empty, and logs each', async () => {
    registry.register(ATTEMPT, {
      token: TOKEN,
      mode: 'allowlist',
      provider: 'custom',
      upstream: { baseUrl: 'http://mock-model:8090/v1' },
      expiresAt: Date.now() + 60_000,
    });
    for (const authority of [
      'example.com:443',
      'api.openai.com:443',
      '93.184.216.34:443',
      'inference-api.nousresearch.com:443',
    ]) {
      expect(await connect(authority), authority).toEqual({
        status: 403,
        reason: 'host is not on the allowlist',
      });
    }
    const plain = await new Promise<number>((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port,
            path: 'http://example.com/',
            headers: { 'proxy-authorization': auth },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          },
        )
        .on('error', reject);
    });
    expect(plain).toBe(403);
    // Refused before any lookup or connection.
    expect(resolved).toEqual([]);
    expect(connected).toEqual([]);
    const log = registry.get(ATTEMPT)!.log;
    expect(log).toHaveLength(5);
    expect(
      log.every((e) => e.decision === 'denied' && e.reason === 'host is not on the allowlist'),
    ).toBe(true);
    expect(log.map((e) => e.kind)).toEqual(['connect', 'connect', 'connect', 'connect', 'http']);
    // Hermes's own credits-seed host is labelled as its background request (Phase 7), still refused.
    expect(log.map((e) => [e.host, e.origin])).toEqual([
      ['example.com', 'agent'],
      ['api.openai.com', 'agent'],
      ['93.184.216.34', 'agent'],
      ['inference-api.nousresearch.com', 'hermes_background'],
      ['example.com', 'agent'],
    ]);
  });

  it('labels a request to each of Hermes’s background hosts, in any case, and nothing else', async () => {
    registry.register(ATTEMPT, {
      token: TOKEN,
      mode: 'allowlist',
      provider: null,
      expiresAt: Date.now() + 60_000,
    });
    for (const authority of [
      'hermes-agent.nousresearch.com:443',
      'RAW.githubusercontent.com:443',
      'githubusercontent.com:443',
      'portal.nousresearch.com:443',
    ]) {
      expect((await connect(authority)).status, authority).toBe(403);
    }
    expect(registry.get(ATTEMPT)!.log.map((e) => [e.host, e.origin])).toEqual([
      ['hermes-agent.nousresearch.com', 'hermes_background'],
      ['RAW.githubusercontent.com', 'hermes_background'],
      ['githubusercontent.com', 'agent'],
      ['portal.nousresearch.com', 'agent'],
    ]);
  });
});
