/**
 * The Comparison tab's states the fixture scenarios do not draw: too few tasks, too few runs
 * once settled, a failed experiment, and a link naming a key the experiment does not have.
 * getComparison is wrapped so each test can bend the fixture's answer.
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import { ApiError } from '@/api/client';
import type { ComparisonQuery, ComparisonView } from '@/api/types/experiments';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import ExperimentComparisonTab from '@/views/experiments/ExperimentComparisonTab.vue';

type Bend = (view: ComparisonView, query: ComparisonQuery) => ComparisonView;
type Refuse = (id: string, query: ComparisonQuery) => Error | null;
const state = vi.hoisted(() => ({ bend: null as Bend | null, refuse: null as Refuse | null }));

vi.mock('@/api/experiments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/experiments')>();
  return {
    ...actual,
    getComparison: async (id: string, query: ComparisonQuery = {}) => {
      const refusal = state.refuse?.(id, query);
      if (refusal) throw refusal;
      const view = await actual.getComparison(id, query);
      return state.bend ? state.bend(view, query) : view;
    },
  };
});

const { EXPERIMENT_IDS } = await import('@/api/experiments');

beforeEach(() => {
  useScenario(null);
  state.bend = null;
  state.refuse = null;
});
afterEach(() => {
  document.body.innerHTML = '';
});

async function mountTab(experimentId: string, query = '') {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(`/experiments/${experimentId}/comparison${query}`);
  const w = mount(ExperimentComparisonTab, {
    props: { experimentId },
    global: { plugins: [createPinia(), router] },
    attachTo: document.body,
  });
  await flushPromises();
  return { w, router };
}

describe('Comparison tab without a verdict', () => {
  it('keeps Δ and the filter with too few tasks, and says why there is no interval', async () => {
    const message =
      'No interval with 2 tasks. Pass rates: baseline 0.25, with-mcp 0.75. A verdict needs at least 3 tasks: the interval resamples the tasks, and with fewer it cannot say how sure the difference is.';
    state.bend = (view) => ({
      ...view,
      statistics: null,
      statisticsUnavailable: { reason: 'too_few_tasks', message },
    });
    const { w } = await mountTab(EXPERIMENT_IDS.skillVsNoSkill);
    expect(w.findAll('[data-testid=delta]').length).toBeGreaterThan(0);
    expect(w.find('[aria-label="Filter tasks"]').exists()).toBe(true);
    const panel = w.get('[data-testid=statistics-panel]');
    expect(panel.attributes('data-verdict')).toBe('not_computable');
    expect(panel.get('[data-testid=statistics-unavailable] b').text()).toBe(
      'No interval with 2 tasks.',
    );
    expect(panel.find('[role=img]').exists()).toBe(false);
    // The sensitivity figure stays, without a verdict sentence.
    expect(w.get('[data-testid=sensitivity]').text()).not.toContain('verdict');
  });

  it('says why with too few runs once settled', async () => {
    state.bend = (view) => ({
      ...view,
      statistics: null,
      statisticsUnavailable: {
        reason: 'not_enough_runs',
        message:
          'No interval: 2 tasks (task_2, task_3) counted fewer than 2 runs under a configuration, and cancelled runs do not count. A verdict needs at least 2 per task and configuration.',
      },
    });
    const { w } = await mountTab(EXPERIMENT_IDS.skillVsNoSkill);
    expect(w.get('[data-testid=statistics-unavailable]').text()).toContain(
      'counted fewer than 2 runs under a configuration',
    );
  });

  it('reads provisional after a failure, which Retry failed runs can resume', async () => {
    state.bend = (view) => ({ ...view, experimentStatus: 'failed', provisional: true });
    const { w } = await mountTab(EXPERIMENT_IDS.mcpVsBaseline);
    expect(w.get('[data-testid=provisional-banner]').text()).toMatch(
      /^Stopped: \d+ of 120 runs scored\./,
    );
    expect(w.find('[data-testid=secondary-metrics]').exists()).toBe(false);
  });

  it('keeps a candidate whose load failed in the select, over the dimmed last view', async () => {
    const { w, router } = await mountTab(EXPERIMENT_IDS.skillMcp);
    state.refuse = (id, query) =>
      query.candidate
        ? new ApiError(502, `GET /api/experiments/${id}/comparison`, 'upstream api:8080 refused')
        : null;
    await w.get('[data-testid=candidate-select]').trigger('click');
    await flushPromises();
    await w.findAll('[role=option]')[1]!.trigger('click');
    await flushPromises();
    const chosen = router.currentRoute.value.query.candidate;
    expect(chosen).toBeTruthy();
    expect(w.get('[data-testid=candidate-select]').text()).toBe('with-mcp');
    const alert = w.get('[role=alert]');
    expect(alert.text()).toContain('Could not load the comparison');
    expect(alert.text()).toContain('The candidate select keeps its value; Retry reloads with it.');
    expect(alert.text()).not.toContain('Use the defaults');
    expect(w.find('.opacity-60[aria-busy=true]').exists()).toBe(true);

    state.refuse = null;
    await alert
      .findAll('button')
      .find((b) => b.text() === 'Retry')!
      .trigger('click');
    await flushPromises();
    expect(w.find('[role=alert]').exists()).toBe(false);
    expect(w.find('.opacity-60').exists()).toBe(false);
    expect(router.currentRoute.value.query.candidate).toBe(chosen);
    expect(w.get('[data-testid=candidate-select]').text()).toBe('with-mcp');
  });

  it('offers the defaults when a link to a key it does not have follows a loaded view', async () => {
    const { w, router } = await mountTab(EXPERIMENT_IDS.skillVsNoSkill);
    state.refuse = (id, query) =>
      query.key === 'tone'
        ? new ApiError(
            400,
            `GET /api/experiments/${id}/comparison`,
            'task total_due has no key tone',
          )
        : null;
    await router.push({ query: { key: 'tone' } });
    await flushPromises();
    const alert = w.get('[role=alert]');
    expect(alert.text()).toContain('Could not load the comparison');
    expect(alert.text()).toContain(
      'The link names a candidate or score key this experiment does not have.',
    );
    await alert
      .findAll('button')
      .find((b) => b.text() === 'Use the defaults')!
      .trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.key).toBeUndefined();
    expect(w.find('[role=alert]').exists()).toBe(false);
  });

  it('offers the defaults when the link names a key the experiment does not have', async () => {
    state.refuse = (id, query) =>
      query.key === 'tone'
        ? new ApiError(
            400,
            `GET /api/experiments/${id}/comparison`,
            'task total_due has no key tone',
          )
        : null;
    const { w, router } = await mountTab(EXPERIMENT_IDS.skillVsNoSkill, '?key=tone');
    const alert = w.get('[role=alert]');
    expect(alert.text()).toContain('400 · task total_due has no key tone');
    expect(alert.text()).toContain(
      'The link names a candidate or score key this experiment does not have.',
    );
    const reset = alert.findAll('button').find((b) => b.text() === 'Use the defaults')!;
    await reset.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.key).toBeUndefined();
    expect(w.find('[role=alert]').exists()).toBe(false);
    expect(w.findAll('tbody tr[data-task]')).toHaveLength(12);
  });
});
