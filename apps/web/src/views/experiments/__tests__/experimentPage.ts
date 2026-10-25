import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { useProvidersStore } from '@/stores/providers';
// The pages the routes load lazily, compiled while this file loads rather than inside the first
// test's time: under turbo the whole repository's tests run at once.
import '@/views/experiments/ExperimentDetailPage.vue';
import '@/views/experiments/ExperimentOverviewTab.vue';
import '@/views/experiments/ExperimentRunsTab.vue';
import '@/views/experiments/ExperimentComparisonTab.vue';

const Root = defineComponent({ render: () => h(RouterView) });

export interface MountedPage {
  wrapper: VueWrapper;
  router: Router;
  pinia: Pinia;
}

/**
 * Mounts the route at `path` (the experiment page and its tab) on fixtures, in a scenario, the
 * way the app does: lazy route components resolved, the providers loaded as the AppShell
 * loads them.
 */
export async function mountExperimentRoute(
  path: string,
  scenario: string | null = null,
): Promise<MountedPage> {
  useScenario(scenario);
  const pinia = createPinia();
  setActivePinia(pinia);
  // Under ?scenario=loading nothing resolves: do not wait for the providers then.
  await Promise.race([
    useProvidersStore(pinia).load(),
    new Promise((resolve) => setTimeout(resolve, 50)),
  ]);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  await router.isReady();
  const wrapper = mount(Root, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await settle();
  return { wrapper, router, pinia };
}

/** Lets lazy imports, fixture promises and the router finish. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await vi.dynamicImportSettled();
    await flushPromises();
  }
}
