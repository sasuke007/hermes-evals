import { describe, expect, it } from 'vitest';
import { defineComponent, h, nextTick, type Component } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import {
  createMemoryHistory,
  createRouter,
  RouterView,
  type RouteLocationNormalized,
} from 'vue-router';
import { inspectedRunId, ROUTE_NAMES, routes } from '@/router';
import ExperimentListPage from '@/views/experiments/ExperimentListPage.vue';
import NewExperimentPage from '@/views/experiments/NewExperimentPage.vue';
import ExperimentDetailPage from '@/views/experiments/ExperimentDetailPage.vue';
import ExperimentOverviewTab from '@/views/experiments/ExperimentOverviewTab.vue';
import ExperimentComparisonTab from '@/views/experiments/ExperimentComparisonTab.vue';
import ExperimentRunsTab from '@/views/experiments/ExperimentRunsTab.vue';
import SuiteListPage from '@/views/suites/SuiteListPage.vue';
import SuiteDetailPage from '@/views/suites/SuiteDetailPage.vue';
import TaskDetailPage from '@/views/suites/TaskDetailPage.vue';
import ConfigurationListPage from '@/views/configurations/ConfigurationListPage.vue';
import ConfigurationFormPage from '@/views/configurations/ConfigurationFormPage.vue';
import ConfigurationDetailPage from '@/views/configurations/ConfigurationDetailPage.vue';
import ResourceLibraryPage from '@/views/resources/ResourceLibraryPage.vue';
import SystemPage from '@/views/system/SystemPage.vue';
import NotFoundPage from '@/views/NotFoundPage.vue';
import RunInspectorDrawer from '@/components/inspector/RunInspectorDrawer.vue';

function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes });
}

/** Loads the lazy components of every matched record, outermost first. */
async function componentsAt(path: string): Promise<{ name: unknown; components: Component[] }> {
  const router = makeRouter();
  await router.push(path);
  const route = router.currentRoute.value;
  const components = await Promise.all(
    route.matched.map(async (record) => {
      const c = record.components?.default as Component | (() => Promise<{ default: Component }>);
      return typeof c === 'function' && !('setup' in c) && !('render' in c)
        ? (await (c as () => Promise<{ default: Component }>)()).default
        : (c as Component);
    }),
  );
  return { name: route.name, components };
}

const EXP = 'exp_01JBB7SVNS';

describe('route table', () => {
  it.each([
    ['/experiments', ROUTE_NAMES.experiments, [ExperimentListPage]],
    ['/experiments/new', ROUTE_NAMES.experimentNew, [NewExperimentPage]],
    [
      `/experiments/${EXP}`,
      ROUTE_NAMES.experimentOverview,
      [ExperimentDetailPage, ExperimentOverviewTab],
    ],
    [
      `/experiments/${EXP}/comparison`,
      ROUTE_NAMES.experimentComparison,
      [ExperimentDetailPage, ExperimentComparisonTab],
    ],
    [
      `/experiments/${EXP}/runs`,
      ROUTE_NAMES.experimentRuns,
      [ExperimentDetailPage, ExperimentRunsTab],
    ],
    [
      `/experiments/${EXP}/runs/run_01JB7X4K2M`,
      ROUTE_NAMES.experimentRun,
      [ExperimentDetailPage, ExperimentRunsTab],
    ],
    ['/suites', ROUTE_NAMES.suites, [SuiteListPage]],
    ['/suites/suite_01JAT3F9C2A1', ROUTE_NAMES.suite, [SuiteDetailPage]],
    ['/suites/suite_01JAT3F9C2A1/tasks/dup_invoices', ROUTE_NAMES.task, [TaskDetailPage]],
    ['/configurations', ROUTE_NAMES.configurations, [ConfigurationListPage]],
    ['/configurations/new', ROUTE_NAMES.configurationNew, [ConfigurationFormPage]],
    [
      '/configurations/cfg_01JAX9SKILL/edit',
      ROUTE_NAMES.configurationEdit,
      [ConfigurationFormPage],
    ],
    ['/configurations/cfg_01JAX9SKILL', ROUTE_NAMES.configuration, [ConfigurationDetailPage]],
    ['/resources/skills', ROUTE_NAMES.resourcesTab, [ResourceLibraryPage]],
    ['/resources/documents', ROUTE_NAMES.resourcesTab, [ResourceLibraryPage]],
    ['/resources/mcp', ROUTE_NAMES.resourcesTab, [ResourceLibraryPage]],
    ['/resources/secrets', ROUTE_NAMES.resourcesTab, [ResourceLibraryPage]],
    ['/system', ROUTE_NAMES.system, [SystemPage]],
    ['/nowhere/at/all', ROUTE_NAMES.notFound, [NotFoundPage]],
    ['/resources/videos', ROUTE_NAMES.notFound, [NotFoundPage]],
  ] as [string, string, Component[]][])('%s → %s', async (path, name, expected) => {
    const resolved = await componentsAt(path);
    expect(resolved.name).toBe(name);
    expect(resolved.components).toEqual(expected);
  });

  it('gives every route a name', () => {
    const unnamed: string[] = [];
    const walk = (list: typeof routes) =>
      list.forEach((r) => {
        if (!r.name) unnamed.push(r.path);
        if (r.children) walk(r.children);
      });
    walk(routes);
    expect(unnamed).toEqual(['/']);
  });

  it('redirects /, /resources and the experiment parent', async () => {
    const router = makeRouter();
    await router.push('/');
    expect(router.currentRoute.value.name).toBe(ROUTE_NAMES.experiments);
    await router.push('/resources');
    expect(router.currentRoute.value.fullPath).toBe('/resources/skills');
    await router.push({ name: ROUTE_NAMES.experiment, params: { id: EXP }, query: { run: 'r1' } });
    expect(router.currentRoute.value.name).toBe(ROUTE_NAMES.experimentOverview);
    expect(router.currentRoute.value.query.run).toBe('r1');
  });

  it('marks the AppShell section on every routed page', () => {
    const router = makeRouter();
    expect(router.resolve('/experiments/new').meta.section).toBe('experiments');
    expect(router.resolve(`/experiments/${EXP}/runs`).meta.section).toBe('experiments');
    expect(router.resolve('/suites/x/tasks/y').meta.section).toBe('suites');
    expect(router.resolve('/configurations/x/edit').meta.section).toBe('configurations');
    expect(router.resolve('/resources/mcp').meta.section).toBe('resources');
    expect(router.resolve('/system').meta.section).toBe('system');
  });
});

describe('route props', () => {
  function propsAt(path: string): Record<string, unknown> {
    const router = makeRouter();
    const route = router.resolve(path) as unknown as RouteLocationNormalized;
    const record = route.matched[route.matched.length - 1]!;
    const props = record.props.default;
    return typeof props === 'function' ? (props(route) as Record<string, unknown>) : {};
  }

  it('maps params and query to page props', () => {
    expect(propsAt(`/experiments/${EXP}/comparison`)).toEqual({ experimentId: EXP });
    expect(propsAt('/experiments/new?from=exp_1')).toEqual({
      duplicateOf: 'exp_1',
      repetitions: undefined,
    });
    expect(propsAt('/experiments/new?from=exp_1&repetitions=5')).toEqual({
      duplicateOf: 'exp_1',
      repetitions: 5,
    });
    expect(propsAt('/experiments/new?repetitions=x')).toEqual({
      duplicateOf: undefined,
      repetitions: undefined,
    });
    expect(propsAt('/experiments/new')).toEqual({ duplicateOf: undefined, repetitions: undefined });
    expect(propsAt('/suites/s1/tasks/dup_invoices')).toEqual({
      suiteId: 's1',
      taskKey: 'dup_invoices',
    });
    expect(propsAt('/configurations/new')).toEqual({ mode: 'new', configurationId: undefined });
    expect(propsAt('/configurations/new?from=cfg_1')).toEqual({
      mode: 'duplicate',
      configurationId: 'cfg_1',
    });
    expect(propsAt('/configurations/cfg_1/edit')).toEqual({
      mode: 'edit',
      configurationId: 'cfg_1',
    });
    expect(propsAt('/configurations/cfg_1?version=1')).toEqual({
      configurationId: 'cfg_1',
      version: 1,
    });
    expect(propsAt('/configurations/cfg_1?version=x')).toEqual({
      configurationId: 'cfg_1',
      version: undefined,
    });
    expect(propsAt('/resources/secrets')).toEqual({ tab: 'secrets' });
  });

  it('finds the inspected run in the param or the query', () => {
    const router = makeRouter();
    const at = (p: string) =>
      inspectedRunId(router.resolve(p) as unknown as RouteLocationNormalized);
    expect(at(`/experiments/${EXP}/runs/run_a`)).toBe('run_a');
    expect(at(`/experiments/${EXP}/comparison?run=run_b`)).toBe('run_b');
    expect(at(`/experiments/${EXP}/runs`)).toBeNull();
  });
});

describe('run inspector drawer routing', () => {
  const Root = defineComponent({ render: () => h(RouterView) });

  async function mountAt(path: string) {
    const router = makeRouter();
    await router.push(path);
    await router.isReady();
    // The experiment page, its tabs and the drawer all read Pinia stores.
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = mount(Root, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await flushPromises();
    return { router, wrapper };
  }

  it('opens over the comparison tab from ?run= and closes back to it', async () => {
    const { router, wrapper } = await mountAt(
      `/experiments/${EXP}/comparison?run=run_b&key=answer`,
    );
    expect(wrapper.findComponent(ExperimentComparisonTab).exists()).toBe(true);
    const drawer = wrapper.findComponent(RunInspectorDrawer);
    expect(drawer.props()).toMatchObject({ runId: 'run_b', experimentId: EXP });
    await wrapper.get('button[aria-label="Close run inspector (Esc)"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe(`/experiments/${EXP}/comparison?key=answer`);
    expect(wrapper.findComponent(RunInspectorDrawer).exists()).toBe(false);
    wrapper.unmount();
  });

  it('opens over the Runs tab from its own route and closes on Esc', async () => {
    const { router, wrapper } = await mountAt(`/experiments/${EXP}/runs/run_a?exec_error=1`);
    expect(wrapper.findComponent(ExperimentRunsTab).exists()).toBe(true);
    expect(wrapper.findComponent(RunInspectorDrawer).props('runId')).toBe('run_a');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await flushPromises();
    expect(router.currentRoute.value.name).toBe(ROUTE_NAMES.experimentRuns);
    expect(router.currentRoute.value.query).toEqual({ exec_error: '1' });
    wrapper.unmount();
  });

  it('steps to another run the way the drawer was opened', async () => {
    const { router, wrapper } = await mountAt(`/experiments/${EXP}/runs/run_a`);
    wrapper.findComponent(RunInspectorDrawer).vm.$emit('navigate', 'run_c');
    await flushPromises();
    await nextTick();
    expect(router.currentRoute.value.params.runId).toBe('run_c');
    wrapper.unmount();
  });

  it('marks the current tab', async () => {
    const { wrapper } = await mountAt(`/experiments/${EXP}/runs`);
    const current = wrapper.findAll('nav[aria-label="Experiment"] a[aria-current="page"]');
    // The Runs tab carries its run count ('Runs 120').
    expect(current.map((a) => a.text())).toEqual([expect.stringMatching(/^Runs/)]);
    wrapper.unmount();
  });
});
