import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EgressClient } from './egress-client.js';

/** A stand-in for egress's admin socket that answers GET /env-names with `reply`. */
let reply: (res: http.ServerResponse) => void;
let server: http.Server;
let dir: string;
let socket: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'egress-client-'));
  socket = join(dir, 'admin.sock');
  server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/env-names') return reply(res);
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
