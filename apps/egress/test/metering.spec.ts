/**
 * Every call the model gateway forwards is metered (Phase 3 review): the
 * agent holds its attempt token and can call the gateway itself, so a call
 * metered as nothing would slip past the token cap and the spend guard.
 *
 * The upstream here behaves as OpenAI does: a streamed answer carries usage
 * only when the request sets `stream_options.include_usage`.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGatewayServer } from '../src/gateway.js';
import { Registry } from '../src/registry.js';
import { ESTIMATED_USAGE_REASON, estimatedUsage } from '../src/upstream.js';

const ATTEMPT = '01K8ZQ7M3V5X9C2B4N6P8R0C02';
const TOKEN = 'm'.repeat(64);
const USAGE = { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 };

/** Bodies the upstream received, as text. */
const received: string[] = [];

const sse = (res: http.ServerResponse, value: unknown) =>
  res.write(`data: ${JSON.stringify(value)}\n\n`);
const chunk = (content: string) => ({ choices: [{ delta: { content } }] });

const upstream = http.createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on('data', (part: Buffer) => parts.push(part));
  req.on('end', () => {
    const text = Buffer.concat(parts).toString('utf8');
    received.push(text);
    const body = JSON.parse(text) as {
      model: string;
      stream?: boolean;
      stream_options?: { include_usage?: boolean };
    };
    switch (body.model) {
      case 'stream': {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, chunk('hello'));
        if (body.stream_options?.include_usage) sse(res, { choices: [], usage: USAGE });
        res.end('data: [DONE]\n\n');
        return;
      }
      case 'slow-usage': {
        // The usage chunk comes late: a client that leaves first never sees it.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        sse(res, chunk('hello'));
        setTimeout(() => {
          if (res.destroyed) return;
          sse(res, { choices: [], usage: USAGE });
          res.end('data: [DONE]\n\n');
        }, 1000);
        return;
      }
      case 'no-total':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 10 } }),
        );
        return;
      case 'silent':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'no usage here' } }] }));
        return;
      default:
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'slow down' } }));
    }
  });
});

const registry = new Registry();
let gateway: http.Server;
let base = '';

beforeAll(async () => {
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  gateway = createGatewayServer({
    registry,
    upstreams: { mock: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } },
    tokenCapPerAttempt: 2000,
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`;
});
afterAll(() => {
  upstream.close();
  gateway.close();
});
beforeEach(() => {
  registry.remove(ATTEMPT);
  received.length = 0;
  registry.register(ATTEMPT, {
    token: TOKEN,
    mode: 'allowlist',
    provider: 'mock',
    expiresAt: Date.now() + 60_000,
  });
});

const post = (body: string | Record<string, unknown>, signal?: AbortSignal) =>
  fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal,
  });

/** Resolves once the gateway has logged `n` calls of the attempt. */
async function logged(n: number) {
  for (let i = 0; i < 200 && (registry.get(ATTEMPT)?.log.length ?? 0) < n; i += 1) await sleep(10);
  return registry.get(ATTEMPT)!.log;
}

describe('metering', () => {
  it('asks every streamed call for its usage, so streamed calls reach the cap', async () => {
    for (const options of [undefined, { include_usage: false }]) {
      const res = await post({
        model: 'stream',
        stream: true,
        messages: [],
        ...(options ? { stream_options: options } : {}),
      });
      expect(res.status).toBe(200);
      await res.text();
    }
    expect(received.map((r) => JSON.parse(r).stream_options)).toEqual([
      { include_usage: true },
      { include_usage: true },
    ]);
    expect(registry.usage(ATTEMPT)).toMatchObject({ calls: 2, totalTokens: 2000 });
    const refused = await post({ model: 'stream', stream: true, messages: [] });
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ error: { code: 'token_cap_reached' } });
  });

  it('forwards a streamed request that already asks for usage byte for byte', async () => {
    const text =
      '{"model":"stream",  "stream":true,"stream_options":{"include_usage":true},"messages":[]}';
    await (await post(text)).text();
    expect(received).toEqual([text]);
  });

  it('meters prompt plus completion when the upstream leaves the total out', async () => {
    await (await post({ model: 'no-total', messages: [] })).text();
    expect(registry.usage(ATTEMPT)).toMatchObject({ calls: 1, totalTokens: 40 });
    expect((await logged(1))[0]).toMatchObject({ promptTokens: 30, completionTokens: 10 });
  });

  it('charges max_tokens when the client leaves before the usage chunk', async () => {
    const leave = new AbortController();
    const res = await post(
      { model: 'slow-usage', stream: true, max_tokens: 500, messages: [] },
      leave.signal,
    );
    const reader = res.body!.getReader();
    await reader.read();
    leave.abort();
    const [entry] = await logged(1);
    const prompt = Math.ceil(Buffer.byteLength(received[0]!) / 4);
    expect(entry).toMatchObject({
      decision: 'allowed',
      promptTokens: prompt,
      completionTokens: 500,
      reason: ESTIMATED_USAGE_REASON,
    });
    expect(registry.usage(ATTEMPT)).toMatchObject({ calls: 1, totalTokens: prompt + 500 });
  });

  it('charges an answer without usage by its size, and an upstream refusal nothing', async () => {
    const answer = await (await post({ model: 'silent', messages: [] })).text();
    const charged = estimatedUsage({
      requestBytes: Buffer.byteLength(received[0]!),
      maxTokens: null,
      answerBytes: Buffer.byteLength(answer),
    });
    expect(charged.totalTokens).toBeGreaterThan(0);
    expect(registry.usage(ATTEMPT)).toMatchObject({ calls: 1, totalTokens: charged.totalTokens });

    const refused = await post({ model: 'refuses', messages: [] });
    expect(refused.status).toBe(429);
    await refused.text();
    const log = await logged(2);
    expect(log[1]).toMatchObject({ status: 429, decision: 'allowed' });
    expect(log[1]).not.toHaveProperty('promptTokens');
    expect(registry.usage(ATTEMPT)).toMatchObject({ calls: 2, totalTokens: charged.totalTokens });
  });
});
