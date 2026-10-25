/**
 * The LLM judge's path on the admin socket (Phase 3 S2): what a judge
 * registration may hold and what each refusal says, routing per provider
 * with egress's own credentials, usage and the connection log, the token
 * cap, expiry, the upstream's failures, and a whole judge call answered by
 * the scripted mock model.
 */
import http, { type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createAdminServer } from '../src/admin.js';
import {
  JUDGE_EXPIRED_RETENTION_MS,
  JUDGE_MAX_LIFETIME_MS,
  JudgeRegistry,
} from '../src/judge-registry.js';
import { createMockModelServer, mockModelOptions } from '../src/mock-model.js';
import { Registry } from '../src/registry.js';
import type { Upstream } from '../src/upstream.js';

const JUDGE = '01K8ZQ7M3V5X9C2B4N6P8R0J01';
const OTHER = '01K8ZQ7M3V5X9C2B4N6P8R0J02';
const KEYED_KEY = 'sk-keyed-upstream-secret';
const CUSTOM_KEY = 'sk-custom-judge-secret';

type Behaviour = 'ok' | 'error500' | 'echoKey' | 'slow' | 'noUsage';
let behaviour: Behaviour = 'ok';
const seen: Array<{ url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }> =
  [];

const completion = (content: string) => ({
  id: 'chatcmpl-stub',
  object: 'chat.completion',
  model: 'judge/model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
});

const upstream = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    seen.push({ url: req.url!, headers: req.headers, body: JSON.parse(raw || '{}') });
    const send = (status: number, body: unknown) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    switch (behaviour) {
      case 'error500':
        return send(500, { error: { message: 'upstream overloaded' } });
      case 'echoKey':
        return send(401, { error: { message: `bad key ${req.headers.authorization}` } });
      case 'slow':
        return setTimeout(() => send(200, completion('late')), 1000);
      case 'noUsage': {
        const { usage: _usage, ...rest } = completion('{"score":1,"comment":"ok"}');
        return send(200, rest);
      }
      default:
        return send(200, completion('{"score":0.9,"comment":"meets the rubric"}'));
    }
  });
});

const mock = createMockModelServer(
  mockModelOptions({
    MOCK_MODEL: 'mock/judge',
    MOCK_SCRIPTS: JSON.stringify([
      {
        match: 'GRADE-THIS-RESPONSE',
        steps: [{ content: '{"score":0.8,"comment":"mostly right"}' }],
      },
    ]),
  }),
);

const dir = mkdtempSync(join(tmpdir(), 'egress-judge-'));
const socket = join(dir, 'admin.sock');
let clock = Date.now();
const judges = new JudgeRegistry(() => clock);
let env: NodeJS.ProcessEnv = {};
const upstreams: Record<string, Upstream> = {};
const admin = createAdminServer(new Registry(), {
  judges: { judges, upstreams, env: () => env, tokenCap: 120, upstreamTimeoutMs: 300 },
});

let upstreamPort = 0;
let mockPort = 0;
beforeAll(async () => {
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => admin.listen(socket, r));
  upstreamPort = (upstream.address() as AddressInfo).port;
  mockPort = (mock.address() as AddressInfo).port;
  upstreams.keyed = { baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: KEYED_KEY };
  upstreams.nous = {
    baseUrl: `http://127.0.0.1:${upstreamPort}/nous/v1`,
    bodyDefaults: { reasoning: { enabled: true, effort: 'medium' } },
  };
});
afterAll(() => {
  for (const server of [upstream, mock, admin]) server.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  clock = Date.now();
  behaviour = 'ok';
  seen.length = 0;
  env = {};
  judges.remove(JUDGE);
  judges.remove(OTHER);
});

function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, method, path });
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

const registration = (over: Record<string, unknown> = {}) => ({
  kind: 'judge',
  provider: 'keyed',
  model: 'judge/model',
  expiresAt: clock + 60_000,
  ...over,
});

const chatBody = (over: Record<string, unknown> = {}) => ({
  model: 'judge/model',
  messages: [
    { role: 'system', content: 'Grade the response.' },
    { role: 'user', content: 'GRADE-THIS-RESPONSE: 42' },
  ],
  temperature: 0,
  max_tokens: 1024,
  response_format: { type: 'json_object' },
  ...over,
});

const register = async (over: Record<string, unknown> = {}, id = JUDGE) =>
  (await call('PUT', `/judges/${id}`, registration(over))).status;

const complete = (body: unknown = chatBody(), id = JUDGE) =>
  call('POST', `/judges/${id}/chat/completions`, body);

describe('judge registration', () => {
  it('refuses MCP routes, CONNECT, a token and a model list, saying why', async () => {
    const mcp = await call(
      'PUT',
      `/judges/${JUDGE}`,
      registration({ mcp: [{ name: 'x', url: 'http://x', headers: [] }] }),
    );
    expect(mcp).toEqual({
      status: 400,
      json: { message: 'mcp: a judge registration reaches no MCP server' },
    });
    const connect = await call(
      'PUT',
      `/judges/${JUDGE}`,
      registration({ mode: 'public', allowHosts: ['example.com'] }),
    );
    expect(connect.status).toBe(400);
    expect(connect.json!.message).toBe('mode, allowHosts: a judge registration makes no CONNECT');
    expect(
      (await call('PUT', `/judges/${JUDGE}`, registration({ token: 'a'.repeat(64) }))).json,
    ).toMatchObject({ message: expect.stringContaining('has no token') });
    expect(await register({ models: ['a', 'b'] })).toBe(400);
    expect(judges.get(JUDGE)).toBeNull();
  });

  it('refuses unknown fields, a custom provider without its base URL, and the reverse', async () => {
    expect(await register({ allowAll: true })).toBe(400);
    expect(await register({ provider: 'custom' })).toBe(400);
    expect(await register({ upstream: { baseUrl: 'http://127.0.0.1:1/v1' } })).toBe(400);
    expect(await register({ kind: 'attempt' })).toBe(400);
  });

  it('lives at most 10 minutes, is refused once expired, and is refused twice', async () => {
    expect(await register({ expiresAt: clock - 1 })).toBe(400);
    expect(await register({ expiresAt: clock + JUDGE_MAX_LIFETIME_MS + 1 })).toBe(400);
    expect(await register()).toBe(204);
    expect(await register()).toBe(409);
  });

  it('reads back with no credential and removes with its usage and log', async () => {
    expect(await register()).toBe(204);
    expect((await call('GET', `/judges/${JUDGE}`)).json).toMatchObject({
      registration: { kind: 'judge', provider: 'keyed', model: 'judge/model' },
    });
    expect(JSON.stringify((await call('GET', `/judges/${JUDGE}`)).json)).not.toContain(KEYED_KEY);
    expect((await call('DELETE', `/judges/${JUDGE}`)).json).toEqual({
      usage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      log: [],
    });
    expect((await call('DELETE', `/judges/${JUDGE}`)).status).toBe(404);
    expect((await complete()).status).toBe(404);
  });

  it('is not an attempt: an attempt path never finds it, and /health counts it apart', async () => {
    expect(await register()).toBe(204);
    expect((await call('GET', `/attempts/${JUDGE}`)).status).toBe(404);
    expect((await call('GET', '/health')).json).toEqual({ ok: true, attempts: 0, judges: 1 });
  });
});

describe('judge calls', () => {
  it('forward to the named upstream with egress’s key, and meter usage in the log', async () => {
    expect(await register()).toBe(204);
    const res = await complete();
    expect(res).toEqual({
      status: 200,
      json: {
        status: 200,
        body: completion('{"score":0.9,"comment":"meets the rubric"}'),
        usage: { calls: 1, promptTokens: 40, completionTokens: 10, totalTokens: 50 },
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: '/v1/chat/completions' });
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${KEYED_KEY}`);
    expect(seen[0]!.body).toEqual(chatBody());
    const report = (await call('DELETE', `/judges/${JUDGE}`)).json as {
      usage: unknown;
      log: Array<Record<string, unknown>>;
    };
    expect(report.usage).toEqual({
      calls: 1,
      promptTokens: 40,
      completionTokens: 10,
      totalTokens: 50,
    });
    expect(report.log).toEqual([
      expect.objectContaining({
        kind: 'model',
        model: 'judge/model',
        decision: 'allowed',
        status: 200,
        promptTokens: 40,
        completionTokens: 10,
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain(KEYED_KEY);
  });

  it('send no key to an upstream that holds its own login, with its body defaults', async () => {
    expect(await register({ provider: 'nous' })).toBe(204);
    expect((await complete()).json).toMatchObject({ status: 200 });
    expect(seen[0]!.url).toBe('/nous/v1/chat/completions');
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.body.reasoning).toEqual({ enabled: true, effort: 'medium' });
  });

  it('reach a custom judge’s own base URL with CUSTOM_API_KEY', async () => {
    env = { CUSTOM_API_KEY: CUSTOM_KEY };
    expect(
      await register({
        provider: 'custom',
        upstream: { baseUrl: `http://127.0.0.1:${upstreamPort}/custom/v1` },
      }),
    ).toBe(204);
    expect((await complete()).json).toMatchObject({ status: 200 });
    expect(seen[0]!.url).toBe('/custom/v1/chat/completions');
    expect(seen[0]!.headers.authorization).toBe(`Bearer ${CUSTOM_KEY}`);
  });

  it('answer 503 for a provider egress has no upstream for, and log it', async () => {
    expect(await register({ provider: 'openrouter' })).toBe(204);
    const res = await complete();
    expect(res.status).toBe(503);
    expect(seen).toEqual([]);
    expect(judges.get(JUDGE)!.log).toEqual([
      expect.objectContaining({ decision: 'denied', status: 503 }),
    ]);
  });

  it('refuse another model, streaming, tools and other roles before forwarding', async () => {
    expect(await register()).toBe(204);
    expect((await complete(chatBody({ model: 'other/model' }))).status).toBe(403);
    expect((await complete(chatBody({ stream: true }))).status).toBe(400);
    expect((await complete(chatBody({ tools: [{ type: 'function' }] }))).status).toBe(400);
    expect(
      (await complete(chatBody({ messages: [{ role: 'assistant', content: 'x' }] }))).status,
    ).toBe(400);
    expect(seen).toEqual([]);
    expect(judges.get(JUDGE)!.log).toEqual([
      expect.objectContaining({ model: 'other/model', decision: 'denied', status: 403 }),
    ]);
  });

  it('stop at the token cap with a 429 naming it, and log the reason', async () => {
    // The path's cap is 120 tokens; each stub answer meters 50.
    expect(await register()).toBe(204);
    for (let i = 0; i < 3; i += 1) expect((await complete()).json).toMatchObject({ status: 200 });
    const refused = await complete();
    expect(refused.status).toBe(429);
    expect(refused.json).toEqual({
      error: expect.objectContaining({ code: 'token_cap_reached', cap: 120, used: 150 }),
    });
    expect(judges.get(JUDGE)!.log.at(-1)).toMatchObject({
      decision: 'denied',
      status: 429,
      reason: 'token cap reached: 150 of 120 tokens used',
    });
    expect(seen).toHaveLength(3);
  });

  it('honour the registration’s own maxTokens before egress’s default', async () => {
    expect(await register({ maxTokens: 50 })).toBe(204);
    expect((await complete()).status).toBe(200);
    expect((await complete()).json).toMatchObject({ error: { cap: 50, used: 50 } });
  });

  it('are refused once the registration expires, which is dropped after its retention', async () => {
    expect(await register({ expiresAt: clock + 1000 })).toBe(204);
    clock += 1000;
    expect(await complete()).toEqual({
      status: 403,
      json: {
        error: { message: 'this judge registration has expired', type: 'invalid_request_error' },
      },
    });
    expect(judges.get(JUDGE)).not.toBeNull();
    clock += JUDGE_EXPIRED_RETENTION_MS;
    expect(judges.size).toBe(0);
    expect(judges.get(JUDGE)).toBeNull();
  });

  it('relay an upstream 5xx and 4xx as the upstream’s status, never egress’s key', async () => {
    expect(await register()).toBe(204);
    behaviour = 'error500';
    expect((await complete()).json).toEqual({
      status: 500,
      body: { error: { message: 'upstream overloaded' } },
      usage: null,
    });
    behaviour = 'echoKey';
    const echoed = await complete();
    expect(echoed.json).toMatchObject({ status: 401 });
    expect(JSON.stringify(echoed.json)).not.toContain(KEYED_KEY);
    expect(JSON.stringify(echoed.json)).toContain('[redacted]');
    // Calls without reported usage still count as calls.
    expect(judges.usage(JUDGE)).toMatchObject({ calls: 2, totalTokens: 0 });
  });

  it('answer 504 when the upstream is slower than the path’s timeout, and 502 when it is down', async () => {
    expect(await register()).toBe(204);
    behaviour = 'slow';
    expect((await complete()).status).toBe(504);
    expect(judges.get(JUDGE)!.log.at(-1)).toMatchObject({
      status: 504,
      reason: 'upstream timed out',
    });

    expect(
      await register({ provider: 'custom', upstream: { baseUrl: 'http://127.0.0.1:1/v1' } }, OTHER),
    ).toBe(204);
    expect((await complete(chatBody(), OTHER)).status).toBe(502);
  });

  it('count the usage the upstream left out as zero tokens', async () => {
    expect(await register()).toBe(204);
    behaviour = 'noUsage';
    expect((await complete()).json).toMatchObject({ status: 200, usage: null });
    expect(judges.usage(JUDGE)).toEqual({
      calls: 1,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it('reach the scripted mock model end to end, as the judge’s tests and live check do', async () => {
    expect(
      await register({
        provider: 'custom',
        model: 'mock/judge',
        upstream: { baseUrl: `http://127.0.0.1:${mockPort}/v1` },
      }),
    ).toBe(204);
    const res = await complete(chatBody({ model: 'mock/judge' }));
    const reply = res.json as {
      status: number;
      body: { choices: Array<{ message: { content: string } }> };
      usage: { totalTokens: number };
    };
    expect(reply.status).toBe(200);
    expect(reply.body.choices[0]!.message.content).toBe('{"score":0.8,"comment":"mostly right"}');
    expect(reply.usage.totalTokens).toBeGreaterThan(0);
  });
});

describe('without a judge path', () => {
  it('answers 404 on /judges', async () => {
    const bare = createAdminServer(new Registry());
    const path = join(dir, 'bare.sock');
    await new Promise<void>((r) => bare.listen(path, r));
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ socketPath: path, method: 'PUT', path: `/judges/${JUDGE}` });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end(JSON.stringify(registration()));
    });
    bare.close();
    expect(status).toBe(404);
  });
});
