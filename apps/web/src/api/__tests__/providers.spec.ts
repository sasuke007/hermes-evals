/**
 * The model-access data layer. Live mode: every call goes to its endpoint, the state-changing
 * ones with the JSON body and X-Requested-With the API requires, and every answer is parsed
 * with its shared schema (a broken answer is a contract error, an API refusal quotes the API's
 * sentence). Fixtures mode: cancel and logout answer the login state after them, and the two
 * scenarios this file applies change the provider list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NousLogin, ProviderInfo } from '@hermes-evals/shared';
import { providersFixture, resetSystemFixtures } from '@/fixtures/system';
import { useScenario } from '@/stores/__tests__/scenarioEnv';

interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

const WAITING: NousLogin = {
  state: 'waiting_for_approval',
  userCode: 'K7QD-P2MX',
  verifyUrl: 'https://portal.nousresearch.com/device?user_code=K7QD-P2MX',
  expiresAt: '2026-10-25T15:15:00.000Z',
  error: null,
  billingUrl: null,
};
const ENDED: NousLogin = {
  state: 'not_connected',
  userCode: null,
  verifyUrl: null,
  expiresAt: null,
  error: null,
  billingUrl: null,
};

describe('providers data layer, live', () => {
  let sent: Sent[] = [];
  let answer: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(() => {
    vi.stubEnv('VITE_API_MODE', 'live');
    vi.resetModules();
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  beforeEach(() => {
    sent = [];
    vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
      sent.push({
        method: init.method ?? 'GET',
        path: new URL(input, 'http://localhost').pathname,
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const api = () => import('@/api/providers');
  const last = (): Sent => sent[sent.length - 1]!;

  it('lists the providers, parsed with the shared schema', async () => {
    const list: ProviderInfo[] = providersFixture();
    answer = { status: 200, body: list };
    const { listProviders } = await api();
    await expect(listProviders()).resolves.toEqual(list);
    expect(last()).toMatchObject({ method: 'GET', path: '/api/providers' });
  });

  it('starts a login with the CSRF header and a JSON body, and parses the code', async () => {
    answer = { status: 200, body: WAITING };
    const { startNousLogin } = await api();
    await expect(startNousLogin()).resolves.toEqual(WAITING);
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/providers/nous/login',
      body: {},
      headers: { 'x-requested-with': 'hermes-evals', 'content-type': 'application/json' },
    });
  });

  it('cancels and logs out with DELETE and POST, each answering the login state', async () => {
    answer = { status: 200, body: ENDED };
    const { cancelNousLogin, logoutNous } = await api();
    await expect(cancelNousLogin()).resolves.toEqual(ENDED);
    expect(last()).toMatchObject({ method: 'DELETE', path: '/api/providers/nous/login' });
    expect(last().headers['x-requested-with']).toBe('hermes-evals');
    await expect(logoutNous()).resolves.toEqual(ENDED);
    expect(last()).toMatchObject({ method: 'POST', path: '/api/providers/nous/logout' });
  });

  it('polls the login state', async () => {
    answer = { status: 200, body: WAITING };
    const { getNousLogin } = await api();
    await expect(getNousLogin()).resolves.toEqual(WAITING);
    expect(last()).toMatchObject({ method: 'GET', path: '/api/providers/nous/login' });
  });

  it('refuses an answer that breaks the contract: a waiting login without its code', async () => {
    answer = { status: 200, body: { ...WAITING, userCode: null } };
    const { startNousLogin } = await api();
    await expect(startNousLogin()).rejects.toMatchObject({
      kind: 'contract',
      message: expect.stringContaining('POST /api/providers/nous/login → 200 · the response'),
    });
  });

  it("quotes the API's refusal: a login in host mode is a 409", async () => {
    answer = {
      status: 409,
      body: {
        statusCode: 409,
        message:
          "This stack uses this machine's Hermes login (NOUS_HOST_PROXY), so Nous Portal is not connected from here.",
      },
    };
    const { startNousLogin } = await api();
    await expect(startNousLogin()).rejects.toMatchObject({
      status: 409,
      message:
        "POST /api/providers/nous/login → 409 · This stack uses this machine's Hermes login (NOUS_HOST_PROXY), so Nous Portal is not connected from here.",
    });
  });
});

describe('providers data layer, fixtures', () => {
  beforeEach(() => resetSystemFixtures());
  afterEach(() => vi.unstubAllGlobals());

  it('answers the login state after a cancel and after a logout', async () => {
    useScenario('nous-not-connected');
    const api = await import('@/api/providers');
    const started = await api.startNousLogin();
    expect(started.state).toBe('waiting_for_approval');
    await expect(api.cancelNousLogin()).resolves.toMatchObject({ state: 'not_connected' });

    useScenario(null);
    await expect(api.logoutNous()).resolves.toMatchObject({ state: 'not_connected' });
    const nous = (await api.listProviders()).find((p) => p.id === 'nous');
    expect(nous?.status).toBe('not_connected');
  });

  it('nous-unavailable: the login service failed its startup check', async () => {
    useScenario('nous-unavailable');
    const { listProviders } = await import('@/api/providers');
    const nous = (await listProviders()).find((p) => p.id === 'nous');
    expect(nous).toMatchObject({ status: 'unavailable', scope: null, login: null });
  });

  it('openrouter-in-use: the configurations use only OpenRouter', async () => {
    useScenario('openrouter-in-use');
    const { listProviders } = await import('@/api/providers');
    const list = await listProviders();
    expect(list.find((p) => p.id === 'nous')?.usedBy).toEqual([]);
    expect(list.find((p) => p.id === 'openrouter')).toMatchObject({
      status: 'missing',
      usedBy: ['or-baseline'],
    });
  });
});
