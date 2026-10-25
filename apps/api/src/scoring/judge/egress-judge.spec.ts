/**
 * The judge client over egress's judge path, with the real EgressClient on a
 * unix socket and a fake egress playing the provider: what it registers and
 * sends, the one retry, timeouts, refusals, readiness, and the tokens it
 * reports.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderReadiness } from '../../providers/readiness.js';
import { EgressCallError, EgressClient, type EgressJudgeApi } from '../../sandbox/egress-client.js';
import { JudgeError, type JudgeRequest } from './contracts.js';
import {
  createEgressJudgeClient,
  type EgressJudgeClientDeps,
  JUDGE_REGISTRATION_TOKEN_CAP,
  JudgeCallError,
} from './egress-judge.js';
import {
  chatCompletion,
  startFakeEgressJudge,
  usageOf,
  type FakeEgressJudge,
} from './fake-egress-judge.support-spec.js';

let fake: FakeEgressJudge;
let ids: number;

beforeEach(async () => {
  fake = await startFakeEgressJudge();
  ids = 0;
});
afterEach(() => fake.close());

const request = (over: Partial<JudgeRequest> = {}): JudgeRequest => ({
  provider: 'openrouter',
  model: 'judge/model',
  baseUrl: null,
  messages: { system: 'rules and facts', user: 'the response' },
  maxTokens: 1024,
  timeoutMs: 5_000,
  responseFormat: { type: 'json_object' },
  ...over,
});

const READY: ProviderReadiness = { ready: true, status: 'configured', reason: null };

const client = (over: Partial<EgressJudgeClientDeps> = {}) =>
  createEgressJudgeClient({
    egress: new EgressClient(fake.socket),
    readiness: async () => READY,
    newId: () => `01K8ZQ7M3V5X9C2B4N6P8R0J${String(ids++).padStart(2, '0')}`,
    retryDelayMs: 0,
    ...over,
  });

const rejection = async (promise: Promise<unknown>): Promise<JudgeError> => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof JudgeError) return err;
    throw err;
  }
  throw new Error('expected a JudgeError');
};

describe('createEgressJudgeClient', () => {
  it('registers a judge-only call, sends one chat completion, and removes it', async () => {
    fake.respond = () => ({
      upstream: 200,
      body: chatCompletion('{"score":1,"comment":"ok"}', { model: 'judge/model-2026' }),
      usage: usageOf(120, 30),
    });
    const before = Date.now();
    const answer = await client().complete(request());
    expect(answer).toEqual({
      text: '{"score":1,"comment":"ok"}',
      tokens: { input: 120, output: 30, total: 150 },
      model: 'judge/model-2026',
      finishReason: 'stop',
      calls: 1,
      latencyMs: expect.any(Number),
    });
    expect(fake.registrations).toEqual([
      {
        judgeId: '01K8ZQ7M3V5X9C2B4N6P8R0J00',
        body: {
          kind: 'judge',
          provider: 'openrouter',
          model: 'judge/model',
          maxTokens: JUDGE_REGISTRATION_TOKEN_CAP,
          expiresAt: expect.any(Number),
        },
      },
    ]);
    // Long enough for a call and its retry, far shorter than egress's 10-minute limit.
    const expiresAt = fake.registrations[0]!.body.expiresAt as number;
    expect(expiresAt - before).toBeGreaterThanOrEqual(2 * 5_000);
    expect(expiresAt - before).toBeLessThan(10 * 60_000);
    expect(fake.calls[0]!.body).toEqual({
      model: 'judge/model',
      messages: [
        { role: 'system', content: 'rules and facts' },
        { role: 'user', content: 'the response' },
      ],
      temperature: 0,
      max_tokens: 1024,
      response_format: { type: 'json_object' },
      stream: false,
    });
    expect(fake.removed).toEqual(['01K8ZQ7M3V5X9C2B4N6P8R0J00']);
  });

  it('routes each provider by its egress upstream name; custom brings its base URL', async () => {
    await client().complete(request({ provider: 'nous' }));
    await client().complete(
      request({ provider: 'custom', baseUrl: 'http://mock-model:8090/v1', model: 'mock/judge' }),
    );
    expect(fake.registrations.map((r) => [r.body.provider, r.body.upstream])).toEqual([
      ['nous', undefined],
      ['custom', { baseUrl: 'http://mock-model:8090/v1' }],
    ]);
    const missing = await rejection(client().complete(request({ provider: 'custom' })));
    expect([missing.kind, missing.message]).toEqual([
      'refused',
      'A custom judge needs JUDGE_BASE_URL: egress has no fixed upstream for custom.',
    ]);
    expect(fake.registrations).toHaveLength(2);
  });

  it('retries once after a 5xx and reports both calls’ tokens', async () => {
    fake.respond = (_body, n) =>
      n === 0
        ? { upstream: 503, body: { error: { message: 'overloaded' } }, usage: usageOf(10, 0) }
        : { upstream: 200, body: chatCompletion('{"score":0.5,"comment":"half"}') };
    const answer = await client().complete(request());
    expect(answer.calls).toBe(2);
    expect(answer.tokens).toEqual({ input: 50, output: 10, total: 60 });
    expect(fake.calls).toHaveLength(2);
  });

  it('gives up as transport after the retry also fails, still counting what it used', async () => {
    fake.respond = () => ({
      upstream: 502,
      body: { error: { message: 'bad gateway' } },
      usage: usageOf(7, 0),
    });
    const err = await rejection(client().complete(request()));
    expect(err).toBeInstanceOf(JudgeCallError);
    expect(err).toMatchObject({
      kind: 'transport',
      status: 502,
      message: "The judge's provider answered 502: bad gateway.",
      tokens: { input: 14, output: 0, total: 14 },
      calls: 2,
    });
    expect(fake.removed).toHaveLength(1);
  });

  it('retries once after a transport failure on the socket', async () => {
    const real = new EgressClient(fake.socket);
    let failures = 1;
    const flaky: EgressJudgeApi = {
      registerJudge: (id, r) => real.registerJudge(id, r),
      removeJudge: (id) => real.removeJudge(id),
      judgeComplete: (id, body, options) =>
        failures-- > 0
          ? Promise.reject(new EgressCallError('unreachable', 'socket hang up'))
          : real.judgeComplete(id, body, options),
    };
    const answer = await client({ egress: flaky }).complete(request());
    expect(answer.calls).toBe(2);
    expect(fake.calls).toHaveLength(1);
  });

  it('never retries a 4xx, egress’s token cap included', async () => {
    fake.respond = () => ({ upstream: 400, body: { error: { message: 'unknown model' } } });
    const bad = await rejection(client().complete(request()));
    expect(bad).toMatchObject({
      kind: 'refused',
      status: 400,
      message: 'The judge call was refused (400): unknown model.',
      calls: 1,
    });
    fake.respond = () => ({
      egress: 429,
      body: {
        error: {
          message: 'This judge registration reached its token cap',
          code: 'token_cap_reached',
        },
      },
    });
    const capped = await rejection(client().complete(request()));
    expect(capped).toMatchObject({ kind: 'refused', status: 429, calls: 1 });
    expect(capped.message).toContain('token cap');
    expect(fake.calls).toHaveLength(2);
  });

  it('reports a model’s refusal to grade as refused', async () => {
    fake.respond = () => ({
      upstream: 200,
      body: chatCompletion(null, { refusal: 'I can’t help with grading this.' }),
    });
    const err = await rejection(client().complete(request()));
    expect(err).toMatchObject({
      kind: 'refused',
      message: 'The judge declined to grade: I can’t help with grading this.',
    });
  });

  it('reads content given as text parts, and refuses a 200 that is not a chat completion', async () => {
    fake.respond = () => ({
      upstream: 200,
      body: {
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: '{"score":' },
                { type: 'text', text: '1}' },
              ],
            },
          },
        ],
      },
    });
    expect((await client().complete(request())).text).toBe('{"score":1}');
    fake.respond = () => ({ upstream: 200, body: { ok: true } });
    expect(await rejection(client().complete(request()))).toMatchObject({
      kind: 'transport',
      calls: 1,
    });
  });

  it('times out without a retry, and removes the registration', async () => {
    fake.respond = () => 'hang';
    const started = Date.now();
    const err = await rejection(client().complete(request({ timeoutMs: 200 })));
    expect(err).toMatchObject({
      kind: 'timeout',
      message: 'The judge did not answer within 0.2 s.',
      calls: 1,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(fake.removed).toHaveLength(1);
  });

  it('stops when the caller’s signal aborts', async () => {
    fake.respond = () => 'hang';
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 100);
    const err = await rejection(client().complete(request(), abort.signal));
    expect(err).toMatchObject({
      kind: 'timeout',
      message: 'The judge call was stopped before it answered.',
    });
  });

  it('makes no call while the judge provider is not ready, or cannot be checked', async () => {
    const notReady = client({
      readiness: async () => ({
        ready: false,
        status: 'not_connected',
        reason: 'Nous Portal is not connected.',
      }),
    });
    const err = await rejection(notReady.complete(request({ provider: 'nous' })));
    expect([err.kind, err.message]).toEqual([
      'provider_not_ready',
      "The judge's provider is not ready: Nous Portal is not connected.",
    ]);
    const unknown = client({
      readiness: async () => {
        throw new Error('egress did not answer a health check');
      },
    });
    expect(await rejection(unknown.complete(request({ provider: 'nous' })))).toMatchObject({
      kind: 'provider_not_ready',
      message: expect.stringContaining('could not be checked: egress did not answer'),
    });
    expect(fake.registrations).toEqual([]);
  });

  it('turns a refused registration into refused, and no egress into transport', async () => {
    fake.refuseRegistration = {
      status: 400,
      message: 'mcp: a judge registration reaches no MCP server',
    };
    expect(await rejection(client().complete(request()))).toMatchObject({
      kind: 'refused',
      status: 400,
      message: expect.stringContaining('reaches no MCP server'),
    });
    const gone = client({ egress: new EgressClient('/nonexistent/admin.sock') });
    expect(await rejection(gone.complete(request()))).toMatchObject({ kind: 'transport' });
  });
});
