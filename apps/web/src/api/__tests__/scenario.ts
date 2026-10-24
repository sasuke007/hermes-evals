import { vi } from 'vitest';

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

/** Activate a fixture scenario (or none) with ?scenario= in the URL, on fresh session storage. */
export function setScenario(name: string | null): void {
  vi.stubGlobal('sessionStorage', memoryStorage());
  window.history.replaceState({}, '', name ? `/?scenario=${name}` : '/');
}

/** Resolves to 'pending' when the promise has not settled within a few ticks. */
export async function settledWithin<T>(promise: Promise<T>, ms = 20): Promise<'pending' | T> {
  return Promise.race([promise, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))]);
}
