/**
 * GET /providers rows (System → Model access, UI_FLOWS 5.3), built from facts
 * the service gathers: the newest live worker (its egress env names and the
 * development host login it reported), nous-login's status, which
 * configurations use each provider, and the experiments paused because a
 * provider was not connected. Pure, so each rule is tested without a
 * database or a service.
 */
import type { NousLogin, NousStatus, Provider, ProviderInfo } from '@hermes-evals/shared';
import type { WorkerHostProxy } from '../database/schema/worker-host-proxy.js';
import { PROVIDER_ROUTES } from '../execution/providers-map.js';
import { DEFAULT_NOUS_BILLING_URL, type NousLoginStatus } from './nous-login.client.js';
import { APPLY_ENV_COMMAND, keyProviderReadiness, NOUS_HOST_COMMAND } from './readiness.js';

/** How Model access names each provider. */
export const PROVIDER_DISPLAY_NAMES: Record<Provider, string> = {
  nous: 'Nous Portal',
  'nous-api': 'Nous API',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  custom: 'Custom endpoint',
};

/** The key providers, always listed, in this order after Nous. */
const KEY_PROVIDERS = ['openrouter', 'nous-api', 'openai', 'anthropic'] as const;

/** Device-login endings that say more than the volume does while it holds no login. */
const ENDED_LOGIN_STATES: ReadonlySet<NousLogin['state']> = new Set([
  'expired',
  'denied',
  'needs_subscription',
  'failed',
]);

export interface ProviderFacts {
  /** Names of the configurations whose latest version uses each provider, sorted. */
  usedBy: ReadonlyMap<Provider, readonly string[]>;
  /** Experiments paused with provider_disconnected that use each provider. */
  paused: ReadonlyMap<Provider, number>;
  /** The newest live worker's egress env names; null when no worker is live. */
  egressEnvNames: readonly string[] | null;
  /** The development host login that worker reported, if any. */
  hostProxy: WorkerHostProxy | null;
  /** nous-login's answer; null in host mode, where it is not asked. */
  nous: NousLoginStatus | null;
}

/**
 * Nous's status from what the volume holds and the device login. A login
 * waiting for approval shows as waiting even over a working login (the user
 * is reconnecting); a failed attempt shows only while nothing works.
 */
export function nousDisplayStatus(nous: NousLoginStatus): NousStatus {
  if (nous.state === 'unavailable') return 'unavailable';
  const login = nous.login;
  if (login?.state === 'waiting_for_approval') return 'waiting_for_approval';
  if (nous.state === 'connected') return 'connected';
  if (login && ENDED_LOGIN_STATES.has(login.state)) return login.state as NousStatus;
  return nous.state;
}

export function nousRow(facts: ProviderFacts): ProviderInfo {
  const host = facts.hostProxy;
  const nous = facts.nous;
  const status: NousStatus = host
    ? host.reachable
      ? 'host'
      : 'host_unreachable'
    : nous
      ? nousDisplayStatus(nous)
      : 'unavailable';
  return {
    id: 'nous',
    name: PROVIDER_DISPLAY_NAMES.nous,
    authMethod: 'oauth-device',
    status,
    scope: status === 'connected' ? (nous?.scope ?? null) : null,
    envVar: null,
    applyCommand: null,
    hostCommand: host ? NOUS_HOST_COMMAND : null,
    billingUrl: nous?.billingUrl || DEFAULT_NOUS_BILLING_URL,
    usedBy: [...(facts.usedBy.get('nous') ?? [])],
    pausedExperiments: facts.paused.get('nous') ?? 0,
    login: host ? null : (nous?.login ?? null),
  };
}

/**
 * An API-key provider: configured or missing in egress, by name only. The
 * custom endpoint's key is optional (CUSTOM_API_KEY), so it always reads as
 * configured.
 */
export function keyRow(provider: Exclude<Provider, 'nous'>, facts: ProviderFacts): ProviderInfo {
  const status =
    provider === 'custom'
      ? 'configured'
      : keyProviderReadiness(provider, facts.egressEnvNames).status;
  return {
    id: provider,
    name: PROVIDER_DISPLAY_NAMES[provider],
    authMethod: 'env-key',
    status,
    scope: null,
    envVar: PROVIDER_ROUTES[provider].apiKeyEnv,
    applyCommand: APPLY_ENV_COMMAND,
    hostCommand: null,
    billingUrl: null,
    usedBy: [...(facts.usedBy.get(provider) ?? [])],
    pausedExperiments: facts.paused.get(provider) ?? 0,
    login: null,
  };
}

/** Every row: Nous, the key providers, and the custom endpoint when a configuration uses it. */
export function providerRows(facts: ProviderFacts): ProviderInfo[] {
  const rows = [nousRow(facts), ...KEY_PROVIDERS.map((p) => keyRow(p, facts))];
  if ((facts.usedBy.get('custom') ?? []).length > 0) rows.push(keyRow('custom', facts));
  return rows;
}
