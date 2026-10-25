/**
 * Mounting the run inspector on fixtures: a scenario, a fresh Pinia, a memory router on the
 * experiment-run route, and the drawer. runOf() finds a fixture run by its cell.
 */
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { EXPERIMENT_IDS } from '@/fixtures/experiments';
import { runDetailFixture, runIdOf } from '@/fixtures/inspector';
import type { RunDetail } from '@/api/types/runs';
import RunInspectorDrawer from '@/components/inspector/RunInspectorDrawer.vue';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { useProvidersStore } from '@/stores/providers';

export type ExperimentKey = keyof typeof EXPERIMENT_IDS;

/** The fixture run id of a task, configuration and repetition (with the scenario active). */
export function runOf(
  exp: ExperimentKey,
  task: string,
  config: string,
  rep: number,
  scenario: string | null = null,
): string {
  const active = (name: string) => scenario?.split(',').includes(name) ?? false;
  const id = runIdOf(active, EXPERIMENT_IDS[exp], task, config, rep);
  if (!id) throw new Error(`no run ${task} ${config} ${rep} in ${exp}`);
  return id;
}

/** A fixture run's detail, as GET /runs/:id serves it (no scenario unless given). */
export function detailOf(runId: string, scenario: string | null = null): RunDetail {
  const active = (name: string) => scenario?.split(',').includes(name) ?? false;
  const detail = runDetailFixture(active, runId);
  if (!detail) throw new Error(`no run ${runId}`);
  return JSON.parse(JSON.stringify(detail)) as RunDetail;
}

export interface Mounted {
  wrapper: VueWrapper;
  pinia: Pinia;
}

export async function mountDrawer(
  exp: ExperimentKey,
  runId: string,
  options: { scenario?: string | null; siblings?: string[]; providers?: boolean } = {},
): Promise<Mounted> {
  useScenario(options.scenario ?? null);
  const pinia = createPinia();
  setActivePinia(pinia);
  if (options.providers !== false) await useProvidersStore().load();
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(`/experiments/${EXPERIMENT_IDS[exp]}/runs/${runId}`);
  const wrapper = mount(RunInspectorDrawer, {
    props: { runId, experimentId: EXPERIMENT_IDS[exp], siblings: options.siblings },
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  });
  await flushPromises();
  return { wrapper, pinia };
}

/** Text with runs of whitespace collapsed, for comparing sentences split over lines. */
export const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The text of every text node, trimmed and joined by single spaces (cells and labels apart). */
export function spaced(node: { element: Element }): string {
  const walker = document.createTreeWalker(node.element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.trim();
    if (text) parts.push(text);
  }
  return squash(parts.join(' '));
}
