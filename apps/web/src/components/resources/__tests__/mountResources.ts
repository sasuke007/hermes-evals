import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { Component } from 'vue';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { routes } from '@/router';
import { useResourcesStore } from '@/stores/resources';
import { useScenario } from '@/stores/__tests__/scenarioEnv';

/**
 * Mounts a resources component (or the page) on fixtures, under a memory router at `path`,
 * with a fresh store, attached to the document so focus and dialogs behave.
 */
export async function mountResources(
  component: Component,
  options: { path?: string; props?: Record<string, unknown>; scenario?: string | null } = {},
): Promise<{ w: VueWrapper; router: Router; store: ReturnType<typeof useResourcesStore> }> {
  useScenario(options.scenario ?? null);
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(options.path ?? '/resources/skills');
  await router.isReady();
  const w = mount(component, {
    props: options.props ?? {},
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  });
  await flushPromises();
  return { w, router, store: useResourcesStore() };
}

/** Picks a file in the dialog's hidden input, as the file picker would. */
export async function pickFile(w: VueWrapper, file: File): Promise<void> {
  const input = w.get('[data-testid="file-input"]');
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
  await input.trigger('change');
  await flushPromises();
}

/** A file whose size reads as `bytes` without allocating it. */
export function fileOfSize(name: string, bytes: number, type = ''): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
}

export const zip = (name = 'invoice-method.zip') =>
  new File(['PK'], name, { type: 'application/zip' });

/** The footer buttons' words. */
export const footerButtons = (w: VueWrapper) =>
  w.findAll('[data-testid="dialog-footer"] button').map((b) => b.text());
