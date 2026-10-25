import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import type { Component } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';

/** Mounted pages, unmounted by unmountAll() in afterEach. */
const mounted: VueWrapper[] = [];

/**
 * Mounts a configuration page at `path` on the real route table, with a fresh Pinia and the
 * fixture scenario active (fixtures mode, no latency). Props come from the route, as in the app.
 */
export async function mountPage(
  page: Component,
  path: string,
  scenario: string | null = null,
  /** Runs with the page's Pinia active, before it mounts (seed a store). */
  before?: () => void,
): Promise<{ w: VueWrapper; router: Router; pinia: Pinia }> {
  useScenario(scenario);
  const pinia = createPinia();
  setActivePinia(pinia);
  before?.();
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  await router.isReady();
  const route = router.currentRoute.value;
  const record = route.matched[route.matched.length - 1];
  const propsFn = record?.props.default;
  const props =
    typeof propsFn === 'function' ? (propsFn as (r: typeof route) => object)(route) : {};
  const w = mount(page, {
    props,
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  });
  mounted.push(w);
  await flushPromises();
  return { w, router, pinia };
}

export function unmountAll(): void {
  while (mounted.length) mounted.pop()?.unmount();
}
