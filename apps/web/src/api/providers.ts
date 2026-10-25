/**
 * Model access (plan section 6.1): provider status and the Nous Portal device login.
 * Live mode calls the API through apiGet/apiSend and parses every answer with its shared
 * schema; fixtures mode serves src/fixtures/system.ts. Only a user code, a link, an expiry and
 * a state ever reach the browser; never a token. The state-changing calls go through apiSend,
 * which adds the JSON body and the X-Requested-With header the API requires.
 *
 * Two fixture scenarios are applied here, on top of src/fixtures/system.ts:
 *   nous-unavailable   the login service failed its startup check (status `unavailable`)
 *   openrouter-in-use  the configurations use only OpenRouter, which has no key: the
 *                      missing-key SetupCard, the no-key banner and ProviderNotice's step
 */
import { apiGet, apiSend } from './client';
import { apiMode, FIXTURE_LATENCY_MS, fixture, hasScenario } from './source';
import {
  NousLoginSchema,
  ProvidersResponseSchema,
  type NousLogin,
  type ProviderInfo,
} from './types/system';
import {
  cancelNousLoginFixture,
  logoutNousFixture,
  nousLoginFixture,
  providersFixture,
  simulateNousLoginFixture,
  startNousLoginFixture,
  type LoginOutcome,
} from '@/fixtures/system';

export type { LoginOutcome } from '@/fixtures/system';
export { LOGIN_OUTCOMES } from '@/fixtures/system';

/** The provider list of the fixture world, with this file's two scenarios applied. */
function providersOfScenario(): ProviderInfo[] {
  const list = providersFixture();
  for (const p of list) {
    if (p.id === 'nous' && hasScenario('nous-unavailable')) {
      Object.assign(p, { status: 'unavailable', scope: null, login: null });
    }
    if (hasScenario('openrouter-in-use')) {
      if (p.id === 'nous') p.usedBy = [];
      if (p.id === 'openrouter') p.usedBy = ['or-baseline'];
    }
  }
  return list;
}

/** GET /providers: every provider, how it authenticates, and its status. */
export function listProviders(): Promise<ProviderInfo[]> {
  if (apiMode === 'live') return apiGet('/providers', ProvidersResponseSchema);
  return fixture(providersOfScenario, { request: 'GET /api/providers' });
}

/**
 * POST /providers/nous/login: start a login (a pending one is replaced); returns the code, the
 * link and the expiry. The API answers 409 in host mode (NOUS_HOST_PROXY) and 503 when the
 * login service is unavailable; the providers store never sends it in those states.
 */
export function startNousLogin(): Promise<NousLogin> {
  if (apiMode === 'live') {
    return apiSend('POST', '/providers/nous/login', {}, NousLoginSchema);
  }
  // "Requesting" is usually under a second; long enough here to be seen.
  return fixture(startNousLoginFixture, {
    request: 'POST /api/providers/nous/login',
    latencyMs: FIXTURE_LATENCY_MS === 0 ? 0 : 700,
  });
}

/** GET /providers/nous/login: the current login state (polled every 2 s while waiting). */
export function getNousLogin(): Promise<NousLogin> {
  if (apiMode === 'live') return apiGet('/providers/nous/login', NousLoginSchema);
  return fixture(nousLoginFixture, { request: 'GET /api/providers/nous/login' });
}

/** DELETE /providers/nous/login: cancel a pending login; answers the login state after it. */
export function cancelNousLogin(): Promise<NousLogin> {
  if (apiMode === 'live') {
    return apiSend('DELETE', '/providers/nous/login', {}, NousLoginSchema);
  }
  return fixture(
    () => {
      cancelNousLoginFixture();
      return nousLoginFixture();
    },
    { request: 'DELETE /api/providers/nous/login' },
  );
}

/**
 * POST /providers/nous/logout: disconnect (what `hermes logout --provider nous` does);
 * answers the login state after it.
 */
export function logoutNous(): Promise<NousLogin> {
  if (apiMode === 'live') {
    return apiSend('POST', '/providers/nous/logout', {}, NousLoginSchema);
  }
  return fixture(
    () => {
      logoutNousFixture();
      return nousLoginFixture();
    },
    { request: 'POST /api/providers/nous/logout' },
  );
}

/** True when the dev-only login controls can work (fixtures only). */
export const canSimulateLogin = apiMode === 'fixtures';

/** Fixtures only: decide how the waiting login ends. A no-op against the live API. */
export function simulateNousLogin(outcome: LoginOutcome): void {
  if (apiMode === 'fixtures') simulateNousLoginFixture(outcome);
}
