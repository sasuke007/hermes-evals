import { describe, expect, it, vi } from 'vitest';
import {
  STALE_BUILD_RELOAD_KEY,
  clearStaleBuildReload,
  isStaleBuildError,
  reloadForStaleBuild,
} from '../staleBuild';

function memoryStore() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const chromeError = new TypeError(
  'Failed to fetch dynamically imported module: http://localhost:8080/assets/ResourceLibraryPage-CwNyW0CD.js',
);

describe('stale build reload', () => {
  it('knows the browsers’ words for a lazy chunk that could not load, and nothing else', () => {
    expect(isStaleBuildError(chromeError)).toBe(true);
    expect(
      isStaleBuildError(new TypeError('error loading dynamically imported module: /a.js')),
    ).toBe(true);
    expect(isStaleBuildError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isStaleBuildError(new Error('GET /api/runs/x → 404'))).toBe(false);
    expect(isStaleBuildError('Failed to fetch dynamically imported module')).toBe(false);
  });

  it('loads the address again once, and not a second time for the same address', () => {
    const store = memoryStore();
    const navigate = vi.fn<(url: string) => void>();
    expect(reloadForStaleBuild(chromeError, '/resources/documents', navigate, store)).toBe(true);
    expect(navigate).toHaveBeenCalledWith('/resources/documents');
    expect(store.getItem(STALE_BUILD_RELOAD_KEY)).toBe('/resources/documents');

    expect(reloadForStaleBuild(chromeError, '/resources/documents', navigate, store)).toBe(false);
    expect(navigate).toHaveBeenCalledTimes(1);

    // Another address, or the same one after a navigation went through, may reload again.
    expect(reloadForStaleBuild(chromeError, '/suites', navigate, store)).toBe(true);
    clearStaleBuildReload(store);
    expect(reloadForStaleBuild(chromeError, '/suites', navigate, store)).toBe(true);
    expect(navigate).toHaveBeenCalledTimes(3);
  });

  it('leaves other navigation errors to the router', () => {
    const navigate = vi.fn<(url: string) => void>();
    expect(reloadForStaleBuild(new Error('boom'), '/system', navigate, memoryStore())).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});
