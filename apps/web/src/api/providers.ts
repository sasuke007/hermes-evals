/**
 * Model access (plan section 6.1): provider status and the Nous Portal device login.
 * Serves fixtures by default (src/fixtures/system.ts); VITE_API_MODE=live calls the API.
 * Only a user code, a link, an expiry and a state ever reach the browser; never a token.
 */
import { z } from 'zod';
import { ApiError, apiGet } from './client';
import { apiMode, FIXTURE_LATENCY_MS, fixture } from './source';
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

/**
 * State-changing provider calls need a JSON body and X-Requested-With, so another site open in
 * the browser cannot log the user in or out (plan 6.1).
 */
async function send<T>(
  method: 'POST' | 'DELETE',
  path: string,
  schema: z.ZodType<T> | null,
): Promise<T | undefined> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'x-requested-with': 'hermes-evals-web',
    },
    body: '{}',
  });
  if (!res.ok) throw new ApiError(res.status, `${method} /api${path}`, (await res.text()).slice(0, 300));
  if (!schema || res.status === 204) return undefined;
  return schema.parse(await res.json());
}

/** GET /providers: every provider, how it authenticates, and its status. */
export function listProviders(): Promise<ProviderInfo[]> {
  if (apiMode === 'live') return apiGet('/providers', ProvidersResponseSchema);
  return fixture(providersFixture, { request: 'GET /api/providers' });
}

/** POST /providers/nous/login: start a login; returns the code, the link and the expiry. */
export async function startNousLogin(): Promise<NousLogin> {
  if (apiMode === 'live') {
    return (await send('POST', '/providers/nous/login', NousLoginSchema)) as NousLogin;
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

/** DELETE /providers/nous/login: cancel a pending login. */
export async function cancelNousLogin(): Promise<void> {
  if (apiMode === 'live') {
    await send('DELETE', '/providers/nous/login', null);
    return;
  }
  await fixture(cancelNousLoginFixture, { request: 'DELETE /api/providers/nous/login' });
}

/** POST /providers/nous/logout: disconnect (what `hermes logout --provider nous` does). */
export async function logoutNous(): Promise<void> {
  if (apiMode === 'live') {
    await send('POST', '/providers/nous/logout', null);
    return;
  }
  await fixture(logoutNousFixture, { request: 'POST /api/providers/nous/logout' });
}

/** True when the dev-only login controls can work (fixtures only). */
export const canSimulateLogin = apiMode === 'fixtures';

/** Fixtures only: decide how the waiting login ends. A no-op against the live API. */
export function simulateNousLogin(outcome: LoginOutcome): void {
  if (apiMode === 'fixtures') simulateNousLoginFixture(outcome);
}
