/**
 * The development host proxy check (UI_FLOWS 19 #7): a TCP connect with a
 * timeout, cached, and reported by admin /health only when NOUS_HOST_PROXY
 * is set.
 */
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAdminServer } from '../src/admin.js';
import type { HostPort } from '../src/host-forward.js';
import { formatHostPort, HostProxyProbe } from '../src/host-probe.js';
import { Registry } from '../src/registry.js';

const listener = net.createServer((socket) => socket.end());
let open: HostPort;
let closed: HostPort;

beforeAll(async () => {
  await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
  open = { host: '127.0.0.1', port: (listener.address() as net.AddressInfo).port };
  // A port that was free a moment ago: nothing listens there.
  const spare = net.createServer();
  await new Promise<void>((r) => spare.listen(0, '127.0.0.1', r));
  closed = { host: '127.0.0.1', port: (spare.address() as net.AddressInfo).port };
  await new Promise<void>((r) => spare.close(() => r()));
});
afterAll(() => listener.close());

describe('HostProxyProbe', () => {
  it('reports a listening target reachable and a closed one not', async () => {
    expect(await new HostProxyProbe(open).status()).toEqual({
      target: `127.0.0.1:${open.port}`,
      reachable: true,
      checkedAt: expect.any(String),
    });
    expect((await new HostProxyProbe(closed).status()).reachable).toBe(false);
  });

  it('gives up after the timeout when nothing answers', async () => {
    // A socket that never connects, as a firewalled host would.
    const probe = new HostProxyProbe(open, { timeoutMs: 50, connect: () => new net.Socket() });
    const started = Date.now();
    expect((await probe.status()).reachable).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('reuses an answer for the cache period, and shares one check among concurrent callers', async () => {
    let now = 1_000_000;
    let connects = 0;
    const probe = new HostProxyProbe(open, {
      now: () => now,
      cacheMs: 5000,
      connect: (t) => {
        connects += 1;
        return net.connect({ host: t.host, port: t.port });
      },
    });
    const [a, b] = await Promise.all([probe.status(), probe.status()]);
    expect(connects).toBe(1);
    expect(a).toBe(b);
    now += 4999;
    await probe.status();
    expect(connects).toBe(1);
    now += 1;
    await probe.status();
    expect(connects).toBe(2);
  });

  it('formats IPv6 targets in brackets', () => {
    expect(formatHostPort({ host: '::1', port: 8645 })).toBe('[::1]:8645');
    expect(formatHostPort({ host: 'host.docker.internal', port: 8645 })).toBe(
      'host.docker.internal:8645',
    );
  });
});

describe('admin /health', () => {
  const dir = mkdtempSync(join(tmpdir(), 'egress-health-'));
  const servers: http.Server[] = [];
  afterAll(() => {
    for (const s of servers) s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const health = async (probe: HostProxyProbe | null) => {
    const socket = join(dir, `admin-${servers.length}.sock`);
    const admin = createAdminServer(new Registry(), { hostProxy: probe });
    servers.push(admin);
    await new Promise<void>((r) => admin.listen(socket, r));
    return new Promise<unknown>((resolve, reject) => {
      http
        .get({ socketPath: socket, path: '/health' }, (res) => {
          let text = '';
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve(JSON.parse(text)));
        })
        .on('error', reject);
    });
  };

  it('reports the host proxy only when one is configured', async () => {
    expect(await health(null)).toEqual({ ok: true, attempts: 0 });
    expect(await health(new HostProxyProbe(closed))).toEqual({
      ok: true,
      attempts: 0,
      hostProxy: {
        target: `127.0.0.1:${closed.port}`,
        reachable: false,
        checkedAt: expect.any(String),
      },
    });
    expect(await health(new HostProxyProbe(open))).toMatchObject({
      hostProxy: { reachable: true },
    });
  });
});
