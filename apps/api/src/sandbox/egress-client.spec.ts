import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EgressClient, newAttemptToken } from './egress-client.js';

/** A stand-in for egress's admin socket that answers GET /env-names and GET /health with `reply`. */
let reply: (res: http.ServerResponse) => void;
let server: http.Server;
let dir: string;
let socket: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'egress-client-'));
  socket = join(dir, 'admin.sock');
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/env-names' || req.url === '/health'))
      return reply(res);
    if (req.method === 'DELETE' && req.url?.startsWith('/attempts/')) return reply(res);
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

const json = (status: number, body: string) => (res: http.ServerResponse) =>
  res.writeHead(status, { 'content-type': 'application/json' }).end(body);

describe('newAttemptToken', () => {
  it('is 256 bits of hex, so it never begins with a dash argparse would read as an option', () => {
    // A base64url token began with `-` once in 64 and made `hermes chat --api-key <token>` exit 2.
    const tokens = Array.from({ length: 2000 }, () => newAttemptToken());
    for (const token of tokens) expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe('EgressClient.envNames', () => {
  it('returns the names egress reports', async () => {
    reply = json(200, JSON.stringify({ names: ['OPENROUTER_API_KEY', 'VENDOR_API_TOKEN'] }));
    expect(await new EgressClient(socket).envNames()).toEqual([
      'OPENROUTER_API_KEY',
      'VENDOR_API_TOKEN',
    ]);
  });

  it('rejects an answer that is not a list of variable names', async () => {
    reply = json(200, JSON.stringify({ names: ['lower-case'] }));
    await expect(new EgressClient(socket).envNames()).rejects.toThrow();
    reply = json(200, JSON.stringify({ VENDOR_API_TOKEN: 'value' }));
    await expect(new EgressClient(socket).envNames()).rejects.toThrow();
  });

  it('rejects, without crashing the process, on another status or invalid JSON', async () => {
    reply = json(404, JSON.stringify({ message: 'not found' }));
    await expect(new EgressClient(socket).envNames()).rejects.toThrow(/answered 404/);
    reply = json(200, '{"names": [');
    await expect(new EgressClient(socket).envNames()).rejects.toThrow(/invalid JSON/);
  });

  it('gives up after its timeout', async () => {
    reply = () => {}; // never answers
    const started = Date.now();
    await expect(new EgressClient(socket).envNames(200)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('rejects when egress is not there', async () => {
    await expect(new EgressClient(join(dir, 'missing.sock')).envNames()).rejects.toThrow(/ENOENT/);
  });
});

describe('EgressClient.remove', () => {
  const ATTEMPT = '01K8ZQ7M3V5X9C2B4N6P8R0T1W';

  it('returns the usage and log egress reports', async () => {
    const report = {
      usage: { calls: 2, promptTokens: 120, completionTokens: 30, totalTokens: 150 },
      log: [
        {
          at: '2026-10-25T09:00:00.000Z',
          kind: 'model',
          model: 'mock/scripted',
          decision: 'allowed',
          status: 200,
          ms: 12,
          promptTokens: 120,
          completionTokens: 30,
        },
      ],
    };
    reply = json(200, JSON.stringify(report));
    expect(await new EgressClient(socket).remove(ATTEMPT)).toEqual(report);
  });

  it('answers null for an attempt egress did not have, and refuses a report it cannot read', async () => {
    reply = json(404, JSON.stringify({ message: 'unknown attempt' }));
    expect(await new EgressClient(socket).remove(ATTEMPT)).toBeNull();
    reply = json(200, JSON.stringify({ usage: { calls: '2' }, log: [] }));
    await expect(new EgressClient(socket).remove(ATTEMPT)).rejects.toThrow(/unknown shape/);
    reply = json(
      200,
      JSON.stringify({
        usage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        log: [{ kind: 'teleport' }],
      }),
    );
    await expect(new EgressClient(socket).remove(ATTEMPT)).rejects.toThrow(/unknown shape/);
  });
});

describe('EgressClient.healthReport', () => {
  it('returns the host forward egress reports, and none when it has no forward', async () => {
    const hostProxy = {
      target: 'host.docker.internal:8645',
      reachable: false,
      checkedAt: '2026-10-24T12:00:00.000Z',
    };
    reply = json(200, JSON.stringify({ ok: true, attempts: 2, hostProxy }));
    expect(await new EgressClient(socket).healthReport()).toEqual({
      ok: true,
      attempts: 2,
      hostProxy,
    });
    reply = json(200, JSON.stringify({ ok: true, attempts: 0 }));
    expect(await new EgressClient(socket).healthReport()).toEqual({ ok: true, attempts: 0 });
  });

  it('is null, never a throw, for another status, a bad body or no egress', async () => {
    reply = json(500, JSON.stringify({ ok: false }));
    expect(await new EgressClient(socket).healthReport()).toBeNull();
    reply = json(200, JSON.stringify({ ok: true, attempts: 0, hostProxy: { target: 'x' } }));
    expect(await new EgressClient(socket).healthReport()).toBeNull();
    reply = json(200, '{"ok": tr');
    expect(await new EgressClient(socket).healthReport()).toBeNull();
    expect(await new EgressClient(join(dir, 'missing.sock')).healthReport()).toBeNull();
  });
});
