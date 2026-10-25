/**
 * Whether a provider can serve a run right now (plan 6.1 and 7.3). One rule,
 * used by every place that leads to a model call: the launch check
 * (POST /experiments answers 409 with `reason`, E7), Resume and Retry, and the
 * worker's provider guard before each claim, which pauses the experiment with
 * `provider_disconnected` and spends no attempt when this says not ready.
 *
 * Inputs, none of which makes a network call to a provider:
 * - `nous`: the nous-login status (get_nous_auth_status_local, which reads
 *   the nous-home volume), unless the newest live worker's
 *   `workers.host_proxy` is set: then the development host login decides,
 *   `host` when its target answered, else `host_unreachable`.
 * - key providers (`nous-api`, `openrouter`, `openai`, `anthropic`): whether
 *   the route's key variable (PROVIDER_ROUTES[provider].apiKeyEnv,
 *   execution/providers-map.ts) is among the newest live worker's
 *   `workers.egress_env_names`, which egress reports by name only. With no
 *   live worker nobody can say, so the provider is not ready (and nothing
 *   could run anyway).
 * - `custom`: ready; its key is optional, and its base URL is on the
 *   configuration version.
 *
 * "Not ready" and "cannot check" stay apart: a check that cannot get an
 * answer throws. The worker's guard then defers the job (readiness_unknown)
 * instead of pausing the experiment, so a nous-login or egress restart does
 * not leave an experiment paused until someone clicks Resume; the API's
 * gate answers 409 with why. The worker's guard also asks its own egress,
 * live (egressEnvNames, egressHealth), rather than the newest worker's
 * heartbeat row: that row may be another worker's, or ten seconds old.
 */
import type { NousStatus, Provider, ProviderStatus } from '@hermes-evals/shared';
import type { AppDb } from '../database/types.js';
import {
  WorkerHostProxySchema,
  type WorkerHostProxy,
} from '../database/schema/worker-host-proxy.js';
import { PROVIDER_ROUTES } from '../execution/providers-map.js';
import { findLiveWorker, type WorkerRow } from '../queue/live-worker.js';
import type { EgressHealth } from '../sandbox/egress-client.js';
import type { NousLoginClient } from './nous-login.client.js';

/** The answer for one provider. */
export interface ProviderReadiness {
  /** True when a run on this provider can start: `connected`, `host` or `configured`. */
  ready: boolean;
  status: ProviderStatus;
  /**
   * Why it is not ready, in the words the UI and the 409 show, e.g. "Nous
   * Portal is not connected" or "OPENROUTER_API_KEY is not set in egress's
   * environment". Null when ready.
   */
  reason: string | null;
}

/** What providerReadiness needs beyond the database. */
export interface ProviderReadinessDeps {
  /**
   * nous-login's local status (GET NOUS_LOGIN_URL/status over the
   * provider-admin network). It never contacts the portal. Resolves
   * `unavailable` when the service answered that its startup check failed,
   * and throws when the service cannot be reached or understood.
   */
  nousStatus(): Promise<NousStatus>;
  /**
   * The worker guard's own egress, asked now: the names it holds. When set it
   * decides key providers instead of the newest worker's row; a rejection
   * propagates (readiness unknown).
   */
  egressEnvNames?: () => Promise<readonly string[]>;
  /**
   * The worker guard's own egress health, asked now: whether it forwards to
   * a development host login, and whether that answers. When set it decides
   * Nous's host mode instead of the newest worker's row; a null answer
   * (egress unreachable) throws.
   */
  egressHealth?: () => Promise<EgressHealth | null>;
}

/** The command that applies a changed .env to the services that read provider keys. */
export const APPLY_ENV_COMMAND = 'docker compose up -d egress worker';

/** The command that starts the development host login's proxy (NOUS_HOST_PROXY). */
export const NOUS_HOST_COMMAND = 'hermes proxy start --provider nous';

const READY_CONFIGURED: ProviderReadiness = { ready: true, status: 'configured', reason: null };

/** Why Nous is not ready, for each status that is not `connected`. */
export function nousNotReadyReason(status: NousStatus): string {
  switch (status) {
    case 'relogin_required':
      return 'Your Nous Portal login needs renewing. Reconnect Nous Portal.';
    case 'unavailable':
      return 'The Nous Portal login service is unavailable, so the login cannot be checked.';
    case 'host_unreachable':
      return `This stack uses this machine's Hermes login, but its proxy is not running. Start it with: ${NOUS_HOST_COMMAND}`;
    default:
      return 'Nous Portal is not connected.';
  }
}

/** The development host login the newest live worker reported, or null. */
export function hostProxyOf(worker: WorkerRow | null): WorkerHostProxy | null {
  if (!worker?.hostProxy) return null;
  const parsed = WorkerHostProxySchema.safeParse(worker.hostProxy);
  return parsed.success ? parsed.data : null;
}

/** Readiness of an API-key provider from the variable names egress holds. */
export function keyProviderReadiness(
  provider: Exclude<Provider, 'nous' | 'custom'>,
  egressEnvNames: readonly string[] | null,
): ProviderReadiness {
  const envVar = PROVIDER_ROUTES[provider].apiKeyEnv!;
  if (egressEnvNames === null) {
    return {
      ready: false,
      status: 'missing',
      reason: `No worker is connected, so whether egress has ${envVar} cannot be checked.`,
    };
  }
  if (egressEnvNames.includes(envVar)) return READY_CONFIGURED;
  return {
    ready: false,
    status: 'missing',
    reason: `${envVar} is not set in egress's environment. Add it to .env, then run: ${APPLY_ENV_COMMAND}`,
  };
}

export async function providerReadiness(
  db: AppDb,
  provider: Provider,
  deps: ProviderReadinessDeps,
): Promise<ProviderReadiness> {
  if (provider === 'custom') return READY_CONFIGURED;
  if (provider !== 'nous') {
    const names = deps.egressEnvNames
      ? await deps.egressEnvNames()
      : ((await findLiveWorker(db))?.egressEnvNames ?? null);
    return keyProviderReadiness(provider, names);
  }
  const host = deps.egressHealth
    ? await liveHostProxy(deps.egressHealth)
    : hostProxyOf(await findLiveWorker(db));
  if (host) {
    return host.reachable
      ? { ready: true, status: 'host', reason: null }
      : {
          ready: false,
          status: 'host_unreachable',
          reason: nousNotReadyReason('host_unreachable'),
        };
  }
  const status = await deps.nousStatus();
  return status === 'connected'
    ? { ready: true, status, reason: null }
    : { ready: false, status, reason: nousNotReadyReason(status) };
}

/** The host forward egress reports now; throws when egress does not answer. */
async function liveHostProxy(
  health: () => Promise<EgressHealth | null>,
): Promise<{ reachable: boolean } | null> {
  const report = await health();
  if (report === null) throw new Error('egress did not answer a health check');
  return report.hostProxy ? { reachable: report.hostProxy.reachable } : null;
}

/**
 * The deps the API and the worker wire to their nous-login client. Only what
 * the volume holds counts: a Reconnect waiting for approval does not stop
 * runs on a login that still works. A nous-login that cannot be reached
 * throws (checkedStatus), so it reads as unknown, never as disconnected.
 */
export function nousReadinessDeps(
  client: Pick<NousLoginClient, 'checkedStatus'>,
): ProviderReadinessDeps {
  return { nousStatus: async () => (await client.checkedStatus()).state };
}
