/**
 * Whether a provider can take model calls right now, as the run and experiment controls ask it
 * (UI_FLOWS 7): Retry execution needs the run's provider, Re-score the judge's, Resume after a
 * provider pause every provider of the experiment. Read from the providers store, so it moves
 * with the AppShell banner.
 */
import type { Provider } from '@hermes-evals/shared';
import type { useProvidersStore } from '@/stores/providers';

type ProvidersStore = ReturnType<typeof useProvidersStore>;

export interface ProviderState {
  id: Provider;
  /** Display name: "Nous Portal", "OpenRouter". */
  name: string;
  ready: boolean;
  /** The fix is Connect in the UI (Nous); otherwise it is on the server (an API key). */
  connectable: boolean;
}

/** Nous states that the UI cannot fix with Connect: System shows the command instead. */
const NOT_CONNECTABLE = new Set(['host', 'host_unreachable', 'unavailable']);

/**
 * A provider's state. Unknown (the providers are still loading, or the provider is not listed,
 * such as `custom` for the mock model) counts as ready: the API refuses with its reason if not.
 */
export function providerState(providers: ProvidersStore, id: Provider): ProviderState {
  const info = providers.providers.find((p) => p.id === id);
  if (!providers.loaded || !info) {
    return { id, name: info?.name ?? id, ready: true, connectable: false };
  }
  if (info.authMethod === 'oauth-device') {
    return {
      id,
      name: info.name,
      ready: providers.nousConnected,
      connectable: !NOT_CONNECTABLE.has(providers.nousStatus),
    };
  }
  return { id, name: info.name, ready: info.status === 'configured', connectable: false };
}

/** The first of these providers that is not ready, or null when all are. */
export function firstBlocked(providers: ProvidersStore, ids: Provider[]): ProviderState | null {
  for (const id of new Set(ids)) {
    const state = providerState(providers, id);
    if (!state.ready) return state;
  }
  return null;
}
