import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';

let mounted: VueWrapper | null = null;

const Root = defineComponent({ render: () => h(RouterView) });

/**
 * Mounts the app's own routes at `path` behind a RouterView, with a fresh store and a
 * fixture scenario (null: the default fixtures), so a page gets the props the router gives
 * it and follows navigation.
 */
export async function mountAt(
  path: string,
  scenario: string | null = null,
): Promise<{ w: VueWrapper; router: Router }> {
  useScenario(scenario);
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  await router.isReady();
  mounted = mount(Root, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await settle();
  return { w: mounted, router };
}

/** Lets lazy route components, fixtures and re-renders finish. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function unmountPage(): void {
  mounted?.unmount();
  mounted = null;
}
