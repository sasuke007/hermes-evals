/**
 * The model gateway's per-attempt token cap (Phase 2 question 2, Phase 3
 * S9 #2): egress's default (MODEL_TOKEN_CAP_PER_ATTEMPT) when the
 * registration names no maxTokens, the registration's own otherwise; past
 * it a 402 that Hermes does not retry (Phase 4 question 8), naming the cap,
 * and a connection-log entry whose reason the runner turns into a `network`
 * event and the platform classifies the run `limit` from.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGatewayServer } from '../src/gateway.js';
import { Registry } from '../src/registry.js';
import {
  DEFAULT_TOKEN_CAP_PER_ATTEMPT,
  TOKEN_CAP_CODE,
  TOKEN_CAP_REASON_PREFIX,
  TOKEN_CAP_STATUS,
  tokenCapRefusal,
} from '../src/upstream.js';

const ATTEMPT = '01K8ZQ7M3V5X9C2B4N6P8R0C01';
const TOKEN = 't'.repeat(64);

const upstream = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 },
      }),
    );
  });
});
const registry = new Registry();
let gateway: http.Server;
let gatewayPort = 0;

beforeAll(async () => {
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  gateway = createGatewayServer({
    registry,
    upstreams: { mock: { baseUrl: `http://127.0.0.1:${upstreamPort}/v1` } },
    tokenCapPerAttempt: 100,
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
  gatewayPort = (gateway.address() as AddressInfo).port;
});
afterAll(() => {
  upstream.close();
  gateway.close();
});
beforeEach(() => registry.remove(ATTEMPT));

const register = (maxTokens?: number) =>
  registry.register(ATTEMPT, {
    token: TOKEN,
    mode: 'allowlist',
    provider: 'mock',
    ...(maxTokens ? { maxTokens } : {}),
    expiresAt: Date.now() + 60_000,
  });

const chat = async () => {
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'mock/scripted', messages: [] }),
  });
  return {
    status: res.status,
    shouldRetry: res.headers.get('x-should-retry'),
    json: (await res.json()) as Record<string, unknown>,
  };
};

describe('token cap per attempt', () => {
  it('defaults to 2,000,000 total tokens', () => {
    expect(DEFAULT_TOKEN_CAP_PER_ATTEMPT).toBe(2_000_000);
  });

  it('applies egress’s cap when the registration names none, and answers 402 naming it', async () => {
    register();
    for (let i = 0; i < 3; i += 1) expect((await chat()).status).toBe(200);
    const refused = await chat();
    // A status Hermes does not retry, and the header that tells the OpenAI SDK not to either.
    expect(TOKEN_CAP_STATUS).toBe(402);
    expect(refused.status).toBe(402);
    expect(refused.shouldRetry).toBe('false');
    expect(refused.json).toEqual({
      error: {
        message:
          'This attempt reached its token cap of 100 tokens (120 used; MODEL_TOKEN_CAP_PER_ATTEMPT)',
        type: TOKEN_CAP_CODE,
        code: TOKEN_CAP_CODE,
        cap: 100,
        used: 120,
      },
    });
    // What Hermes's classifier reads in a 402 to call it a retryable usage window: none of it.
    const message = JSON.stringify(refused.json).toLowerCase();
    for (const word of ['usage limit', 'quota', 'limit exceeded', 'try again', 'retry', 'wait']) {
      expect(message).not.toContain(word);
    }
    const log = registry.get(ATTEMPT)!.log;
    expect(log.at(-1)).toMatchObject({
      kind: 'model',
      decision: 'denied',
      status: 402,
      reason: 'token cap reached: 120 of 100 tokens used',
    });
    expect(log.at(-1)!.reason!.startsWith(TOKEN_CAP_REASON_PREFIX)).toBe(true);
    // The refused call was not forwarded and is not metered.
    expect(registry.usage(ATTEMPT)).toMatchObject({ calls: 3, totalTokens: 120 });
  });

  it('applies the registration’s own maxTokens instead, above or below the default', async () => {
    register(40);
    expect((await chat()).status).toBe(200);
    expect((await chat()).json).toMatchObject({ error: { cap: 40, used: 40 } });
    registry.remove(ATTEMPT);
    register(200);
    for (let i = 0; i < 5; i += 1) expect((await chat()).status).toBe(200);
    expect((await chat()).status).toBe(402);
  });

  it('names the subject in its message', () => {
    expect(tokenCapRefusal(5, 4, 'judge registration').body.error.message).toMatch(
      /^This judge registration reached its token cap of 4 tokens/,
    );
  });
});
