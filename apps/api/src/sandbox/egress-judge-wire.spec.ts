/**
 * The judge's wire contract, the worker's half (Phase 3 S2). Egress does not
 * depend on the shared package, so the two halves are held to one set of
 * example messages: packages/shared/fixtures/egress-judge-wire.json. Here the
 * real EgressClient and judge client, over a socket that answers with those
 * examples, must send requests in the examples' shape and read every example
 * answer; apps/egress/test/judge-wire.spec.ts holds the real admin socket to
 * the same file.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JUDGE_MAX_TOKENS, JudgeError, type JudgeRequest } from '../scoring/judge/contracts.js';
import { createEgressJudgeClient } from '../scoring/judge/egress-judge.js';
import { EgressClient } from './egress-client.js';

interface Wire {
  register: { named: unknown; custom: unknown };
  complete: {
    request: unknown;
    answered: { status: number; body: unknown; usage: unknown };
    unmetered: { status: number; body: unknown; usage: unknown };
    refused: { status: number; body: unknown };
  };
  remove: unknown;
}

const WIRE = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../packages/shared/fixtures/egress-judge-wire.json', import.meta.url),
    ),
    'utf8',
  ),
) as Wire;

/** A value's shape: its keys, all the way down, and each leaf's JSON type. */
function shapeOf(value: unknown): unknown {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.length === 0 ? [] : [shapeOf(value[0])];
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, shapeOf(v)]),
    );
  }
  return typeof value;
}

type Answer = { status: number; body?: unknown };
let answers: Answer[];
let seen: Array<{ method: string; url: string; body: unknown }>;
let server: http.Server;
let dir: string;
let egress: EgressClient;

beforeEach(async () => {
  seen = [];
  answers = [];
  dir = await mkdtemp(join(tmpdir(), 'egress-judge-wire-'));
  const socket = join(dir, 'admin.sock');
  server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body: text ? JSON.parse(text) : null });
      const { status, body } = answers.shift() ?? { status: 500 };
      if (body === undefined) res.writeHead(status).end();
      else res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  egress = new EgressClient(socket);
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const request = (over: Partial<JudgeRequest> = {}): JudgeRequest => ({
  provider: 'custom',
  model: 'mock/judge',
  baseUrl: 'http://mock-model:8090/v1',
  messages: { system: 'rules and facts', user: 'the response' },
  maxTokens: JUDGE_MAX_TOKENS,
  timeoutMs: 5_000,
  responseFormat: { type: 'json_object' },
  ...over,
});

const client = () => createEgressJudgeClient({ egress, retryDelayMs: 1 });

describe('the judge wire contract, worker side', () => {
  it('sends registrations and requests in the examples’ shape and reads the answers', async () => {
    answers = [
      { status: 204 },
      { status: 200, body: WIRE.complete.answered },
      { status: 200, body: WIRE.remove },
    ];
    const answer = await client().complete(request());
    const [register, complete, remove] = seen;
    expect(register).toMatchObject({ method: 'PUT', url: expect.stringMatching(/^\/judges\//) });
    expect(shapeOf(register!.body)).toEqual(shapeOf(WIRE.register.custom));
    expect(shapeOf(complete!.body)).toEqual(shapeOf(WIRE.complete.request));
    expect(remove).toMatchObject({ method: 'DELETE' });
    expect(answer).toMatchObject({
      text: '{"score": 0.9, "comment": "Meets the rubric."}',
      tokens: { input: 900, output: 30, total: 930 },
      finishReason: 'stop',
      calls: 1,
    });

    answers = [{ status: 204 }, { status: 200, body: WIRE.complete.answered }, { status: 404 }];
    await client().complete(request({ provider: 'openrouter', baseUrl: null }));
    expect(shapeOf(seen[3]!.body)).toEqual(shapeOf(WIRE.register.named));
  });

  it('reads every example answer of the chat path and the report', async () => {
    const body = WIRE.complete.request as Parameters<EgressClient['judgeComplete']>[1];
    for (const example of [WIRE.complete.answered, WIRE.complete.unmetered]) {
      answers = [{ status: 200, body: example }];
      expect(
        await egress.judgeComplete('01K8ZQ7M3V5X9C2B4N6P8R0W02', body, { timeoutMs: 5_000 }),
      ).toEqual(example);
    }
    answers = [{ status: 200, body: WIRE.remove }];
    expect(await egress.removeJudge('01K8ZQ7M3V5X9C2B4N6P8R0W02')).toEqual(WIRE.remove);
  });

  it('reads the example refusal as a refused judge call, quoting egress', async () => {
    answers = [{ status: 204 }, WIRE.complete.refused, { status: 200, body: WIRE.remove }];
    const err = await client()
      .complete(request())
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(JudgeError);
    expect(err).toMatchObject({
      kind: 'refused',
      message: expect.stringContaining("is not this judge registration's model"),
    });
  });
});
