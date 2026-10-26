/**
 * Whether New experiment can launch beyond the form itself (UI_FLOWS 7 and 11.1): each chosen
 * configuration's provider must be ready, the variables its MCP servers name must be set
 * (Phase 5 decision #13, Phase 6 S7), and a worker with a proven sandbox must be live. Also
 * how a refused launch reads in the summary panel (NewExperiment board, stale state;
 * ExperimentStates › launch failed). Pure functions over the providers' and the system's
 * state, so the panel and the configuration rows say the same thing.
 */
import {
  MISSING_SECRETS_HINT,
  missingSecretsReason,
  type MissingMcpSecret,
  type Provider,
} from '@hermes-evals/shared';
import { isApiError } from '@/api/client';
import type { ProviderInfo } from '@/api/types/system';

/** The providers store's view of model access, as the form needs it. */
export interface ProviderSnapshot {
  loaded: boolean;
  providers: ProviderInfo[];
  /** Nous status with a live login applied (providers.nousStatus). */
  nousStatus: ProviderInfo['status'];
  nousConnected: boolean;
}

export interface WorkerSnapshot {
  /** No worker has heartbeated in the last 60 s. */
  noWorker: boolean;
  sandboxProven: boolean;
}

/** Why runs on one provider cannot start, and the fix the panel offers. */
export interface LaunchBlocker {
  /** Launch's helper line: "Can't launch yet: Nous Portal is not connected." */
  reason: string;
  /**
   * connect / reconnect: a Connect Nous Portal button (ConnectDialog) · add-key: the .env step
   * with Copy and Open System · command: a command to copy (the host proxy, a worker) ·
   * system: a link to System · secrets: MCP variables to set in .env, the command that makes
   * the worker or egress read them, Check again and a link to Secrets.
   */
  fix: 'connect' | 'reconnect' | 'add-key' | 'command' | 'system' | 'secrets';
  provider: Provider | null;
  /** Display name: Nous Portal, OpenRouter. */
  providerName: string | null;
  /** The chosen configurations it blocks. */
  configurations: string[];
  /** A second line under the reason. */
  detail: string | null;
  envVar: string | null;
  command: string | null;
  /** secrets: the unset variables, in server then name order. */
  missing: MissingMcpSecret[];
}

/** A chosen configuration as the blockers read it. */
export interface ChosenConfiguration {
  name: string;
  provider: Provider;
  /** NewExperimentConfigOption.missingSecrets. */
  missingSecrets?: readonly MissingMcpSecret[];
}

const DEFAULT_APPLY = 'docker compose up -d egress worker';
const START_WORKER = 'docker compose up -d worker';

function infoOf(snapshot: ProviderSnapshot, provider: Provider): ProviderInfo | null {
  return snapshot.providers.find((p) => p.id === provider) ?? null;
}

/**
 * Is the provider ready to serve runs? Unknown counts as ready (the providers have not loaded,
 * or the API does not list it): the launch itself still checks, and answers 409 if not.
 */
export function providerReady(snapshot: ProviderSnapshot, provider: Provider): boolean {
  if (!snapshot.loaded || provider === 'custom') return true;
  if (provider === 'nous') return snapshot.nousConnected;
  const info = infoOf(snapshot, provider);
  return info === null || info.status === 'configured';
}

/** The amber tag on a configuration row whose provider is not ready, or null. */
export function providerTag(snapshot: ProviderSnapshot, provider: Provider): string | null {
  if (providerReady(snapshot, provider)) return null;
  if (provider === 'nous') {
    switch (snapshot.nousStatus) {
      case 'relogin_required':
        return 'Nous Portal needs renewing';
      case 'host_unreachable':
        return 'Nous Portal proxy not running';
      case 'unavailable':
        return 'Nous Portal login unavailable';
      default:
        return 'Nous Portal not connected';
    }
  }
  return `${infoOf(snapshot, provider)?.name ?? provider} key missing`;
}

function nousBlocker(snapshot: ProviderSnapshot, configurations: string[]): LaunchBlocker {
  const base = {
    provider: 'nous' as const,
    providerName: 'Nous Portal',
    configurations,
    detail: null,
    envVar: null,
    command: null,
    missing: [],
  };
  switch (snapshot.nousStatus) {
    case 'relogin_required':
      return {
        ...base,
        reason: "Can't launch yet: your Nous Portal login needs renewing.",
        fix: 'reconnect',
      };
    case 'host_unreachable':
      return {
        ...base,
        reason: "Can't launch yet: this machine's Hermes proxy is not running.",
        fix: 'command',
        detail: "This stack uses this machine's Hermes login. Start its proxy in a terminal:",
        command: infoOf(snapshot, 'nous')?.hostCommand ?? 'hermes proxy start --provider nous',
      };
    case 'unavailable':
      return {
        ...base,
        reason: "Can't launch yet: the Nous Portal login service is unavailable.",
        fix: 'system',
        detail:
          'Its startup check failed. System › Model access shows how to log in from a terminal.',
      };
    default:
      return { ...base, reason: "Can't launch yet: Nous Portal is not connected.", fix: 'connect' };
  }
}

/**
 * Which service has to be recreated to read the variables once they are in .env: the worker
 * for stdio servers, egress for http headers.
 */
export function secretsApplyCommand(missing: readonly MissingMcpSecret[]): string {
  const services = [
    ...(missing.some((m) => m.transport === 'http') ? ['egress'] : []),
    ...(missing.some((m) => m.transport === 'stdio') ? ['worker'] : []),
  ];
  return `docker compose up -d ${services.join(' ')}`;
}

/**
 * The MCP variables a configuration's servers name that are not set, or none while no worker
 * is live: then nothing vouches for any name, and the no-worker blocker says why.
 */
export function unsetSecrets(
  config: Pick<ChosenConfiguration, 'missingSecrets'>,
  workers: Pick<WorkerSnapshot, 'noWorker'>,
): readonly MissingMcpSecret[] {
  return workers.noWorker ? [] : (config.missingSecrets ?? []);
}

/**
 * Everything that keeps the chosen configurations from launching, provider by provider in the
 * order they are chosen, then each configuration's unset MCP variables, then the worker and
 * the sandbox.
 */
export function launchBlockers(
  snapshot: ProviderSnapshot,
  workers: WorkerSnapshot,
  chosen: ChosenConfiguration[],
): LaunchBlocker[] {
  const byProvider = new Map<Provider, string[]>();
  for (const config of chosen) {
    if (providerReady(snapshot, config.provider)) continue;
    byProvider.set(config.provider, [...(byProvider.get(config.provider) ?? []), config.name]);
  }
  const blockers: LaunchBlocker[] = [...byProvider].map(([provider, configurations]) => {
    if (provider === 'nous') return nousBlocker(snapshot, configurations);
    const info = infoOf(snapshot, provider);
    const name = info?.name ?? provider;
    return {
      reason: `Can't launch yet: ${name} has no API key.`,
      fix: 'add-key',
      provider,
      providerName: name,
      configurations,
      detail: null,
      envVar: info?.envVar ?? null,
      command: info?.applyCommand ?? DEFAULT_APPLY,
      missing: [],
    };
  });
  for (const config of chosen) {
    const missing = [...unsetSecrets(config, workers)];
    if (!missing.length) continue;
    blockers.push({
      reason: `${missingSecretsReason(config.name, missing)}.`,
      fix: 'secrets',
      provider: null,
      providerName: null,
      configurations: [config.name],
      detail: MISSING_SECRETS_HINT,
      envVar: null,
      command: secretsApplyCommand(missing),
      missing,
    });
  }
  const none = {
    provider: null,
    providerName: null,
    configurations: [],
    envVar: null,
    missing: [],
  };
  if (workers.noWorker) {
    blockers.push({
      ...none,
      reason: "Can't launch yet: no worker is connected.",
      fix: 'command',
      detail: 'Runs start only on a live worker. Start one with:',
      command: START_WORKER,
    });
  } else if (!workers.sandboxProven) {
    blockers.push({
      ...none,
      reason: "Can't launch yet: the sandbox self-test has not passed.",
      fix: 'system',
      detail: 'Runs cannot start until every isolation check passes (System › Sandbox).',
      command: null,
    });
  }
  return blockers;
}

/** How a refused or failed launch reads in the summary panel. */
export interface LaunchFailure {
  /**
   * conflict: a configuration changed (the form reloads them) · provider: Nous Portal, which
   * Connect fixes · judge: the LLM judge's model or provider · secrets: MCP variables not set
   * (the form reloads the configurations, which then name them) · invalid: a 400 with issues ·
   * refused: any other 409 (no worker, the sandbox, a key, Hermes revisions) · other.
   */
  kind: 'conflict' | 'provider' | 'judge' | 'secrets' | 'invalid' | 'refused' | 'other';
  title: string;
  /** The verbatim line: "POST /api/experiments → 409 · Nous Portal is not connected." */
  message: string;
  hint: string;
  /** provider: the button the alert offers, if any. */
  action: 'connect' | 'reconnect' | null;
}

const UNCHANGED = 'Nothing was created and your form is unchanged.';

export function launchFailure(err: unknown): LaunchFailure {
  const message = err instanceof Error ? err.message : String(err);
  if (!isApiError(err)) {
    return { kind: 'other', title: 'Launch failed', message, hint: UNCHANGED, action: null };
  }
  const detail = err.detail;
  if (err.status === 409 && /changed since you opened this form/.test(detail)) {
    return {
      kind: 'conflict',
      title: 'Launch failed',
      message,
      hint: 'Review the comparison above, then launch again.',
      action: null,
    };
  }
  if (err.status === 409 && detail.startsWith('Nous Portal is not connected')) {
    return {
      kind: 'provider',
      title: 'Launch refused: Nous Portal is not connected.',
      message,
      hint: `The login ended after this page loaded. ${UNCHANGED}`,
      action: 'connect',
    };
  }
  if (err.status === 409 && /Nous Portal login needs renewing/.test(detail)) {
    return {
      kind: 'provider',
      title: 'Launch refused: your Nous Portal login needs renewing.',
      message,
      hint: UNCHANGED,
      action: 'reconnect',
    };
  }
  if (err.status === 409 && detail.endsWith(MISSING_SECRETS_HINT)) {
    return {
      kind: 'secrets',
      title: "Launch refused: an MCP server's variables are not set.",
      message,
      hint: UNCHANGED,
      action: null,
    };
  }
  if (err.status === 409 && /judge/i.test(detail)) {
    return {
      kind: 'judge',
      title: 'Launch refused: the LLM judge is not ready.',
      message,
      hint: UNCHANGED,
      action: null,
    };
  }
  if (err.status === 400) {
    const issues = err.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
    return {
      kind: 'invalid',
      title: 'Launch failed',
      message,
      hint: issues ? `${issues}. ${UNCHANGED}` : UNCHANGED,
      action: null,
    };
  }
  return {
    kind: err.status === 409 ? 'refused' : 'other',
    title: err.status === 409 ? 'Launch refused' : 'Launch failed',
    message,
    hint: UNCHANGED,
    action: null,
  };
}
