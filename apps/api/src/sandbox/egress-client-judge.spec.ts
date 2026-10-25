/**
 * EgressClient's judge path (Phase 3 S2) against a stand-in for egress's
 * admin socket that answers the way apps/egress/src/judge-path.ts does:
 * 204 for a registration, a 200 envelope `{ status, body, usage }` when an
 * upstream answered, egress's own status and `{ error }` otherwise. The
 * real path is tested in apps/egress/test/judge-path.spec.ts.
 */
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EgressCallError,
  EgressClient,
  type EgressJudgeChatBody,
  type EgressJudgeRegistration,
} from './egress-client.js';

const JUDGE = '01K8ZQ7M3V5X9C2B4N6P8R0J10';

interface Seen {
  method: string;
  url: string;
  body: unknown;
}
let seen: Seen[];
let reply: (req: Seen, res: http.ServerResponse) => void;
let server: http.Server;
let dir: string;
let socket: string;

beforeEach(async () => {
  seen = [];
  dir = await mkdtemp(join(tmpdir(), 'egress-judge-client-'));
  socket = join(dir, 'admin.sock');
  server = http.createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      const entry = { method: req.method!, url: req.url!, body: text ? JSON.parse(text) : null };
      seen.push(entry);
      reply(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const send = (res: http.ServerResponse, status: number, body?: unknown) =>
  body === undefined
    ? res.writeHead(status).end()
    : res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

const registration: EgressJudgeRegistration = {
  kind: 'judge',
  provider: 'custom',
  upstream: { baseUrl: 'http://mock-model:8090/v1' },
  model: 'mock/judge',
  maxTokens: 100_000,
  expiresAt: Date.now() + 150_000,
};

const chatBody: EgressJudgeChatBody = {
  model: 'mock/judge',
  messages: [
    { role: 'system', content: 'rules' },
    { role: 'user', content: 'response' },
  ],
  temperature: 0,
  max_tokens: 1024,
  response_format: { type: 'json_object' },
};

const usage = { calls: 1, promptTokens: 40, completionTokens: 10, totalTokens: 50 };

describe('EgressClient.registerJudge', () => {
  it('puts the registration on /judges/:id and resolves on 204', async () => {
    reply = (_req, res) => send(res, 204);
    await new EgressClient(socket).registerJudge(JUDGE, registration);
    expect(seen).toEqual([{ method: 'PUT', url: `/judges/${JUDGE}`, body: registration }]);
  });

  it('rejects as `refused` with egress’s reason, in both of its refusal shapes', async () => {
    reply = (_req, res) =>
      send(res, 400, { message: 'mcp: a judge registration reaches no MCP server' });
    const refused = new EgressClient(socket).registerJudge(JUDGE, registration);
    await expect(refused).rejects.toMatchObject({
      name: 'EgressCallError',
      failure: 'refused',
      status: 400,
      message: expect.stringContaining('reaches no MCP server'),
    });
    reply = (_req, res) => send(res, 400, { message: ['expiresAt: Too small', 'model: Required'] });
    await expect(new EgressClient(socket).registerJudge(JUDGE, registration)).rejects.toThrow(
      /expiresAt: Too small; model: Required/,
    );
    reply = (_req, res) => send(res, 404, { message: 'the judge path is not configured' });
    await expect(new EgressClient(socket).registerJudge(JUDGE, registration)).rejects.toThrow(
      /\(404\): the judge path is not configured/,
    );
  });

  it('rejects as `unreachable` when egress is not there', async () => {
    const missing = new EgressClient(join(dir, 'missing.sock'));
    await expect(missing.registerJudge(JUDGE, registration)).rejects.toMatchObject({
      failure: 'unreachable',
      message: expect.stringContaining('ENOENT'),
    });
  });
});

describe('EgressClient.judgeComplete', () => {
  it('posts the body and returns the upstream’s answer egress relayed', async () => {
    const completion = { choices: [{ message: { content: '{"score":1,"comment":"ok"}' } }] };
    reply = (_req, res) => send(res, 200, { status: 200, body: completion, usage });
    const answer = await new EgressClient(socket).judgeComplete(JUDGE, chatBody, {
      timeoutMs: 5_000,
    });
    expect(answer).toEqual({ status: 200, body: completion, usage });
    expect(seen).toEqual([
      { method: 'POST', url: `/judges/${JUDGE}/chat/completions`, body: chatBody },
    ]);
  });

  it('resolves an upstream 5xx and egress’s own refusal alike, with their status', async () => {
    reply = (_req, res) => send(res, 200, { status: 503, body: null, usage: null });
    const client = new EgressClient(socket);
    expect(await client.judgeComplete(JUDGE, chatBody, { timeoutMs: 5_000 })).toEqual({
      status: 503,
      body: null,
      usage: null,
    });
    const capped = { error: { message: 'token cap', code: 'token_cap_reached', cap: 10 } };
    reply = (_req, res) => send(res, 429, capped);
    expect(await client.judgeComplete(JUDGE, chatBody, { timeoutMs: 5_000 })).toEqual({
      status: 429,
      body: capped,
      usage: null,
    });
  });

  it('rejects as `protocol` on an envelope it cannot read, or invalid JSON', async () => {
    const client = new EgressClient(socket);
    reply = (_req, res) => send(res, 200, { status: 200, body: {}, usage: { calls: -1 } });
    await expect(client.judgeComplete(JUDGE, chatBody, { timeoutMs: 5_000 })).rejects.toMatchObject(
      { failure: 'protocol' },
    );
    reply = (_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"st');
    await expect(client.judgeComplete(JUDGE, chatBody, { timeoutMs: 5_000 })).rejects.toMatchObject(
      { failure: 'protocol' },
    );
  });

  it('gives up as `timeout` after the whole call’s deadline, even while bytes trickle in', async () => {
    reply = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const drip = setInterval(() => res.write(' '), 50);
      res.on('close', () => clearInterval(drip));
    };
    const started = Date.now();
    await expect(
      new EgressClient(socket).judgeComplete(JUDGE, chatBody, { timeoutMs: 300 }),
    ).rejects.toMatchObject({ failure: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('stops as `aborted` when the caller’s signal aborts, before or during the call', async () => {
    reply = () => {}; // never answers
    const client = new EgressClient(socket);
    const before = new AbortController();
    before.abort();
    await expect(
      client.judgeComplete(JUDGE, chatBody, { timeoutMs: 5_000, signal: before.signal }),
    ).rejects.toMatchObject({ failure: 'aborted' });
    const during = new AbortController();
    setTimeout(() => during.abort(), 100);
    await expect(
      client.judgeComplete(JUDGE, chatBody, { timeoutMs: 5_000, signal: during.signal }),
    ).rejects.toBeInstanceOf(EgressCallError);
  });
});

describe('EgressClient.removeJudge', () => {
  it('deletes /judges/:id and returns the usage and log egress reports', async () => {
    const report = {
      usage,
      log: [
        {
          at: '2026-10-25T08:00:00.000Z',
          kind: 'model',
          model: 'mock/judge',
          decision: 'allowed',
          status: 200,
          ms: 12,
          promptTokens: 40,
          completionTokens: 10,
        },
      ],
    };
    reply = (_req, res) => send(res, 200, report);
    expect(await new EgressClient(socket).removeJudge(JUDGE)).toEqual(report);
    expect(seen).toEqual([{ method: 'DELETE', url: `/judges/${JUDGE}`, body: null }]);
  });

  it('is null for a registration egress did not have, and refuses a report it cannot read', async () => {
    const client = new EgressClient(socket);
    reply = (_req, res) => send(res, 404, { error: { message: 'unknown judge registration' } });
    expect(await client.removeJudge(JUDGE)).toBeNull();
    reply = (_req, res) => send(res, 200, { usage: 'lots', log: [] });
    await expect(client.removeJudge(JUDGE)).rejects.toMatchObject({ failure: 'protocol' });
  });
});
