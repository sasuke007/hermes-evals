import { vi } from 'vitest';
import { resetSystemFixtures } from '@/fixtures/system';

/** Minimal Storage stand-in: Node ships web-storage globals that jsdom does not replace. */
export function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, String(v)),
  };
}

/**
 * Activate a fixture scenario (or none) the way a user would, with ?scenario= in the URL,
 * on fresh storage, and rebuild the system fixture world from it.
 */
export function useScenario(name: string | null): void {
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
  window.history.replaceState({}, '', name ? `/?scenario=${name}` : '/');
  resetSystemFixtures();
}

/** Set document.visibilityState and fire visibilitychange. */
export function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}
