/**
 * providerReadiness on PGlite: the one rule launch, Resume, Retry and the
 * worker's provider guard ask before a model call.
 */
import { HERMES_REVISION, type NousStatus } from '@hermes-evals/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { workers } from '../database/schema/index.js';
import type { WorkerHostProxy } from '../database/schema/worker-host-proxy.js';
import { FakeNousLogin } from './fake-nous-login.support-spec.js';
import { NousLoginClient } from './nous-login.client.js';
import { nousReadinessDeps, providerReadiness, type ProviderReadinessDeps } from './readiness.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase();
});

afterAll(() => t.close());

afterEach(async () => {
  await t.db.delete(workers);
});

const deps = (status: NousStatus): ProviderReadinessDeps & { asked: number } => {
  const d = {
    asked: 0,
    nousStatus: () => {
      d.asked += 1;
      return Promise.resolve(status);
    },
  };
  return d;
};

const HOST: WorkerHostProxy = {
  target: 'host.lima.internal:8645',
  reachable: true,
  checked_at: '2026-10-24T09:00:00.000Z',
};

async function worker(
  values: {
    egressEnvNames?: string[];
    hostProxy?: WorkerHostProxy | null;
    heartbeatAgoMs?: number;
  } = {},
) {
  await t.db.insert(workers).values({
    hostname: 'worker-1',
    concurrency: 3,
    hermesVersion: '0.22.4',
    hermesRevision: HERMES_REVISION,
    egressEnvNames: values.egressEnvNames ?? [],
    hostProxy: values.hostProxy ?? null,
    lastHeartbeatAt: new Date(Date.now() - (values.heartbeatAgoMs ?? 0)),
  });
}

describe('providerReadiness', () => {
  it('always lets the custom endpoint run, without asking anyone', async () => {
    const d = deps('unavailable');
    expect(await providerReadiness(t.db, 'custom', d)).toEqual({
      ready: true,
      status: 'configured',
      reason: null,
    });
    expect(d.asked).toBe(0);
  });

  it('asks nous-login for Nous', async () => {
    await worker();
    expect(await providerReadiness(t.db, 'nous', deps('connected'))).toEqual({
      ready: true,
      status: 'connected',
      reason: null,
    });
    expect(await providerReadiness(t.db, 'nous', deps('not_connected'))).toEqual({
      ready: false,
      status: 'not_connected',
      reason: 'Nous Portal is not connected.',
    });
    expect(await providerReadiness(t.db, 'nous', deps('relogin_required'))).toMatchObject({
      ready: false,
      reason: 'Your Nous Portal login needs renewing. Reconnect Nous Portal.',
    });
    expect(await providerReadiness(t.db, 'nous', deps('unavailable'))).toMatchObject({
      ready: false,
      status: 'unavailable',
    });
    // A pending device login is not a usable one.
    expect((await providerReadiness(t.db, 'nous', deps('waiting_for_approval'))).ready).toBe(false);
  });

  it('uses the development host login when the live worker reports one, and skips nous-login', async () => {
    await worker({ hostProxy: HOST });
    const d = deps('not_connected');
    expect(await providerReadiness(t.db, 'nous', d)).toEqual({
      ready: true,
      status: 'host',
      reason: null,
    });
    expect(d.asked).toBe(0);
    await t.db.delete(workers);
    await worker({ hostProxy: { ...HOST, reachable: false } });
    expect(await providerReadiness(t.db, 'nous', d)).toEqual({
      ready: false,
      status: 'host_unreachable',
      reason:
        "This stack uses this machine's Hermes login, but its proxy is not running. Start it with: hermes proxy start --provider nous",
    });
  });

  it("ignores a stale worker's host login", async () => {
    await worker({ hostProxy: HOST, heartbeatAgoMs: 5 * 60_000 });
    expect(await providerReadiness(t.db, 'nous', deps('not_connected'))).toMatchObject({
      ready: false,
      status: 'not_connected',
    });
  });

  it("checks a key provider's variable among egress's names", async () => {
    await worker({ egressEnvNames: ['OPENROUTER_API_KEY', 'VENDOR_API_TOKEN'] });
    expect(await providerReadiness(t.db, 'openrouter', deps('unavailable'))).toEqual({
      ready: true,
      status: 'configured',
      reason: null,
    });
    expect(await providerReadiness(t.db, 'anthropic', deps('connected'))).toEqual({
      ready: false,
      status: 'missing',
      reason:
        "ANTHROPIC_API_KEY is not set in egress's environment. Add it to .env, then run: docker compose up -d egress worker",
    });
    // nous-api reads NOUS_API_KEY, not the Portal login.
    expect((await providerReadiness(t.db, 'nous-api', deps('connected'))).status).toBe('missing');
  });

  it('reads the newest live worker', async () => {
    await worker({ egressEnvNames: ['OPENAI_API_KEY'], heartbeatAgoMs: 5 * 60_000 });
    expect(await providerReadiness(t.db, 'openai', deps('connected'))).toEqual({
      ready: false,
      status: 'missing',
      reason: 'No worker is connected, so whether egress has OPENAI_API_KEY cannot be checked.',
    });
    await worker({ egressEnvNames: ['OPENAI_API_KEY'] });
    expect((await providerReadiness(t.db, 'openai', deps('connected'))).ready).toBe(true);
  });
});

describe('nousReadinessDeps', () => {
  it('counts only what the volume holds: a waiting reconnect keeps a working login ready', async () => {
    const fake = await new FakeNousLogin().listen();
    try {
      const d = nousReadinessDeps(new NousLoginClient(fake.url));
      expect(await d.nousStatus()).toBe('not_connected');
      fake.approve();
      fake.login = {
        state: 'waiting_for_approval',
        userCode: 'FAKE-0002',
        verifyUrl: 'http://portal.test/device',
        expiresAt: new Date().toISOString(),
        error: null,
        billingUrl: null,
      };
      expect(await d.nousStatus()).toBe('connected');
      fake.unavailable = 'contract changed';
      expect(await d.nousStatus()).toBe('unavailable');
    } finally {
      await fake.close();
    }
  });

  it('throws, meaning unknown, when nous-login cannot be reached, never "not connected"', async () => {
    const fake = await new FakeNousLogin().listen();
    const url = fake.url;
    await fake.close();
    const d = nousReadinessDeps(
      new NousLoginClient(url, { statusMs: 300, startMs: 300, changeMs: 300 }),
    );
    await expect(providerReadiness(t.db, 'nous', d)).rejects.toThrow(/not reachable/);
  });

  describe("the worker guard's own egress, asked live", () => {
    it('decides key providers from what egress answers now, not the newest row', async () => {
      // The row says the key is missing (another worker, or a beat egress missed).
      await worker({ egressEnvNames: [] });
      const live = { ...deps('connected'), egressEnvNames: async () => ['OPENROUTER_API_KEY'] };
      expect(await providerReadiness(t.db, 'openrouter', live)).toMatchObject({ ready: true });
      const without = { ...deps('connected'), egressEnvNames: async () => [] };
      expect(await providerReadiness(t.db, 'openrouter', without)).toMatchObject({
        ready: false,
        status: 'missing',
      });
    });

    it('throws, meaning unknown, when egress does not answer', async () => {
      await worker({ egressEnvNames: ['OPENROUTER_API_KEY'] });
      const down = {
        ...deps('connected'),
        egressEnvNames: () => Promise.reject(new Error('egress GET /env-names timed out')),
        egressHealth: async () => null,
      };
      await expect(providerReadiness(t.db, 'openrouter', down)).rejects.toThrow(/timed out/);
      await expect(providerReadiness(t.db, 'nous', down)).rejects.toThrow(/did not answer/);
    });

    it("reads Nous's host mode from egress's health, ahead of the row", async () => {
      await worker({ hostProxy: null });
      const d = Object.assign(deps('not_connected'), {
        egressHealth: async () => ({
          ok: true,
          attempts: 0,
          hostProxy: { target: HOST.target, reachable: false, checkedAt: HOST.checked_at },
        }),
      });
      expect(await providerReadiness(t.db, 'nous', d)).toMatchObject({
        ready: false,
        status: 'host_unreachable',
      });
      expect(d.asked).toBe(0);
      const plain = { ...deps('connected'), egressHealth: async () => ({ ok: true, attempts: 0 }) };
      expect(await providerReadiness(t.db, 'nous', plain)).toMatchObject({ ready: true });
    });
  });
});
