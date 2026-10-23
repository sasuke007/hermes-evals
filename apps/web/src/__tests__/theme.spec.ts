import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useThemeStore } from '@/stores/theme';

/** Minimal Storage stand-in: Node 22+ ships a localStorage global that jsdom does not replace. */
function memoryStorage(): Storage {
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

describe('theme store', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    setActivePinia(createPinia());
  });

  it('toggles between light and dark and stamps the root element', () => {
    const store = useThemeStore();
    const start = store.theme;
    store.toggle();
    expect(store.theme).not.toBe(start);
    expect(document.documentElement.dataset.theme).toBe(store.theme);
    expect(localStorage.getItem('hermes-evals.theme')).toBe(store.theme);
  });

  it('restores a saved theme', () => {
    localStorage.setItem('hermes-evals.theme', 'dark');
    expect(useThemeStore().theme).toBe('dark');
  });
});
