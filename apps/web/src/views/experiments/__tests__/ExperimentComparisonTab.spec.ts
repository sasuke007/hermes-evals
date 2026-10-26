import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { getExperiment } from '@/api/experiments';
import { EXPERIMENT_IDS } from '@/fixtures/experiments';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { LIVE_REFRESH_MS, useComparisonStore } from '@/stores/comparison';
import { useExperimentDetailStore } from '@/stores/experiment-detail';
import ExperimentComparisonTab from '@/views/experiments/ExperimentComparisonTab.vue';

let pinia: Pinia;
let router: Router;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

async function mountTab(experimentId: string, query = '') {
  router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(`/experiments/${experimentId}/comparison${query}`);
  const w = mount(ExperimentComparisonTab, {
    props: { experimentId },
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

const taskOrder = (w: Awaited<ReturnType<typeof mountTab>>) =>
  w.findAll('tbody tr[data-task]').map((tr) => tr.attributes('data-task'));

describe('Comparison tab', () => {
  it('compares the candidate with the baseline, task by task (Skill vs no skill)', async () => {
    useScenario(null);
    const w = await mountTab(EXPERIMENT_IDS.skillVsNoSkill);
    expect(w.get('[data-testid=candidate]').text()).toContain('with-skill');
    expect(taskOrder(w)).toHaveLength(12);
    expect(taskOrder(w)[0]).toBe('dup_invoices');
    expect(w.get('[data-testid=statistics-panel]').attributes('data-verdict')).toBe('better');
    expect(w.find('[data-testid=secondary-metrics]').exists()).toBe(true);
    expect(w.find('[data-testid=provisional-banner]').exists()).toBe(false);
    expect(w.get('[data-testid=comparison-legend]').text()).not.toContain('queued');
  });

  it('filters the tasks through the URL and explains an empty filter', async () => {
    useScenario(null);
    const w = await mountTab(EXPERIMENT_IDS.skillVsNoSkill);
    const regressed = w.findAll('[aria-label="Filter tasks"] button')[2]!;
    expect(regressed.text()).toBe('Regressed 0');
    await regressed.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.show).toBe('regressed');
    const empty = w.get('[data-testid=empty-filter]');
    expect(empty.text()).toContain('No regressed tasks');
    expect(empty.text()).toContain(
      'with-skill did not do worse than baseline on any of the 12 tasks. The filter shows "Regressed 0", so this view is empty, not broken.',
    );
    // The statistics do not change with the filter.
    expect(w.find('[data-testid=statistics-panel]').exists()).toBe(true);
    await empty.get('button').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.show).toBeUndefined();
    expect(taskOrder(w)).toHaveLength(12);
  });

  it('sorts by suite order from the experiment, and by Δ again', async () => {
    useScenario(null);
    const detail = useExperimentDetailStore(pinia);
    const experiment = await getExperiment(EXPERIMENT_IDS.skillVsNoSkill);
    detail.records[EXPERIMENT_IDS.skillVsNoSkill] = experiment;
    const w = await mountTab(EXPERIMENT_IDS.skillVsNoSkill, '?show=improved');
    expect(taskOrder(w)).toHaveLength(8);
    await w.get('thead button').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.sort).toBe('task');
    const suiteOrder = experiment.suite.tasks.map((t) => t.key);
    const shown = taskOrder(w);
    expect(shown).toEqual(suiteOrder.filter((key) => shown.includes(key)));
    // Each task links to its task page in the experiment's suite version.
    expect(w.get('tbody tr a').attributes('href')).toBe(
      `/suites/${experiment.suite.suiteId}/tasks/${shown[0]}`,
    );
    await w.findAll('thead button')[1]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.sort).toBeUndefined();
    expect(taskOrder(w)[0]).toBe('dup_invoices');
  });

  it('opens a cell in the inspector and gives it the grid order for J/K', async () => {
    useScenario(null);
    const w = await mountTab(EXPERIMENT_IDS.skillVsNoSkill);
    const cell = w.get('tr[data-task=dup_invoices]').findAll('button[data-run-id]')[2]!;
    await cell.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.run).toBe(cell.attributes('data-run-id'));
    expect(router.currentRoute.value.name).toBe('experiment-comparison');
    const order = useExperimentDetailStore(pinia).runOrder;
    expect(order).toHaveLength(120);
    expect(order[2]).toBe(cell.attributes('data-run-id'));
  });

  it('is provisional while the experiment runs', async () => {
    useScenario(null);
    const w = await mountTab(EXPERIMENT_IDS.mcpVsBaseline);
    const banner = w.get('[data-testid=provisional-banner]');
    expect(banner.attributes('role')).toBe('status');
    expect(banner.text()).toMatch(/^Still running: \d+ of 120 runs scored\. Unscored cells show/);
    expect(w.get('[data-testid=statistics-panel]').attributes('data-verdict')).toBe('provisional');
    expect(w.find('[data-testid=secondary-metrics]').exists()).toBe(false);
    expect(w.get('[data-testid=comparison-legend]').text()).toContain('queued');
  });

  it('says there is nothing to compare before anything is scored', async () => {
    useScenario('nothing-scored');
    const w = await mountTab(EXPERIMENT_IDS.mcpVsBaseline);
    const panel = w.get('[data-testid=nothing-scored]');
    expect(panel.text()).toContain('Nothing to compare yet');
    expect(panel.text()).toContain('0 of 120 runs scored.');
    expect(w.find('[aria-label="Filter tasks"]').exists()).toBe(false);
    expect(w.find('[data-testid=delta]').exists()).toBe(false);
    expect(w.find('[data-testid=statistics-panel]').exists()).toBe(false);
    expect(w.find('[data-testid=provisional-banner]').exists()).toBe(false);
  });

  it('shows one cell per configuration with one repetition, and offers more', async () => {
    useScenario('single-rep');
    const w = await mountTab(EXPERIMENT_IDS.quickCheck);
    const panel = w.get('[data-testid=single-repetition]');
    expect(panel.get('table').classes()).toContain('h30');
    expect(panel.get('b').text()).toBe('No interval with 1 repetition.');
    expect(panel.text()).toContain('Pass rates: baseline 0.58, with-skill 0.75 on 12 tasks.');
    expect(panel.get('a.btn').text()).toBe('Duplicate with 5 repetitions');
    expect(panel.get('a.btn').attributes('href')).toBe(
      `/experiments/new?from=${EXPERIMENT_IDS.quickCheck}&repetitions=5`,
    );
    expect(w.find('[data-testid=delta]').exists()).toBe(false);
    expect(w.find('[data-testid=statistics-panel]').exists()).toBe(false);
  });

  it('switches the candidate and the score key through the URL', async () => {
    useScenario(null);
    const w = await mountTab(EXPERIMENT_IDS.skillMcp);
    const select = w.get('[data-testid=candidate-select]');
    expect(select.text()).toBe('with-skill');
    await select.trigger('click');
    await flushPromises();
    await w.findAll('[role=option]')[1]!.trigger('click');
    await flushPromises();
    const store = useComparisonStore(pinia);
    const record = store.records[EXPERIMENT_IDS.skillMcp]!;
    expect(router.currentRoute.value.query.candidate).toBe(record.view?.candidate.versionId);
    expect(record.view?.candidate.name).toBe('with-mcp');
    expect(w.get('[data-testid=candidate-select]').text()).toBe('with-mcp');

    await w.get('select#cmp-key').setValue('any_failed');
    await flushPromises();
    expect(router.currentRoute.value.query.key).toBe('any_failed');
    expect(store.records[EXPERIMENT_IDS.skillMcp]!.view?.scoreKey).toBe('any_failed');
  });

  it('draws skeletons while loading', async () => {
    useScenario('loading');
    const w = await mountTab(EXPERIMENT_IDS.skillVsNoSkill);
    const loading = w.get('[data-testid=comparison-loading]');
    expect(loading.attributes('aria-busy')).toBe('true');
    expect(loading.attributes('aria-label')).toBe('Loading the comparison');
    // The skeleton has no caption: ExperimentStates' captions are designer notes (Phase 5 #8).
    expect(loading.text()).toBe('');
  });

  it('says what failed and retries with the same selection', async () => {
    useScenario('error');
    const w = await mountTab(EXPERIMENT_IDS.skillVsNoSkill, '?key=answer');
    const alert = w.get('[role=alert]');
    expect(alert.text()).toContain('Could not load the comparison');
    expect(alert.text()).toContain(
      `GET /api/experiments/${EXPERIMENT_IDS.skillVsNoSkill}/comparison → 502`,
    );
    expect(alert.text()).toContain('The candidate select keeps its value; Retry reloads with it.');
    useScenario(null);
    await alert.get('button').trigger('click');
    await flushPromises();
    expect(w.find('[role=alert]').exists()).toBe(false);
    expect(w.get('select#cmp-key').element).toHaveProperty('value', 'answer');
  });

  it('patches cells from the live stream and refetches what moved', async () => {
    useScenario(null);
    const w = await mountTab(EXPERIMENT_IDS.mcpVsBaseline);
    vi.useFakeTimers();
    const queued = w.find('button[data-look=queued]');
    const runId = queued.attributes('data-run-id')!;
    const detail = useExperimentDetailStore(pinia);
    detail.apply({
      type: 'run',
      at: '2026-10-25T15:00:00Z',
      runId,
      status: 'running',
      attempt: 1,
      primaryScore: null,
      finishedAt: null,
      generation: null,
      rescorePending: false,
    });
    await flushPromises();
    expect(w.get(`button[data-run-id="${runId}"]`).attributes('data-look')).toBe('running');
    const store = useComparisonStore(pinia);
    const before = store.records[EXPERIMENT_IDS.mcpVsBaseline]!.view;
    const order = taskOrder(w);
    await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS);
    await flushPromises();
    // The fixture does not move, so the refetch puts the cell back; the rows stay in place.
    expect(store.records[EXPERIMENT_IDS.mcpVsBaseline]!.view).not.toBe(before);
    expect(taskOrder(w)).toEqual(order);
  });

  it('refetches when the experiment changes status', async () => {
    useScenario(null);
    const detail = useExperimentDetailStore(pinia);
    const experiment = await getExperiment(EXPERIMENT_IDS.mcpVsBaseline);
    detail.records[EXPERIMENT_IDS.mcpVsBaseline] = experiment;
    await mountTab(EXPERIMENT_IDS.mcpVsBaseline);
    const store = useComparisonStore(pinia);
    const before = store.records[EXPERIMENT_IDS.mcpVsBaseline]!.view;
    detail.records[EXPERIMENT_IDS.mcpVsBaseline]!.status = 'paused';
    await flushPromises();
    expect(store.records[EXPERIMENT_IDS.mcpVsBaseline]!.view).not.toBe(before);
  });

  it('refetches when the stream comes back after missing events', async () => {
    useScenario(null);
    await mountTab(EXPERIMENT_IDS.mcpVsBaseline);
    const store = useComparisonStore(pinia);
    const before = store.records[EXPERIMENT_IDS.mcpVsBaseline]!.view;
    useExperimentDetailStore(pinia).reconnects++;
    await flushPromises();
    expect(store.records[EXPERIMENT_IDS.mcpVsBaseline]!.view).not.toBe(before);
  });
});
