import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import IntervalChart from '../IntervalChart.vue';
import SecondaryMetricsPanel from '../SecondaryMetricsPanel.vue';
import StatisticsPanel from '../StatisticsPanel.vue';
import { getComparison } from '@/api/experiments';
import { EXPERIMENT_IDS } from '@/fixtures/experiments';
import type { ComparisonView } from '@/api/types/experiments';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';

beforeEach(() => useScenario(null));

const router = () => createRouter({ history: createMemoryHistory(), routes });

describe('StatisticsPanel', () => {
  it('shows the verdict, the difference, the interval and how to read it', async () => {
    const view = await getComparison(EXPERIMENT_IDS.skillVsNoSkill);
    const w = mount(StatisticsPanel, { props: { view } });
    expect(w.get('h2').text()).toBe('Statistics');
    expect(w.get('[data-kind=verdict]').text()).toBe('better');
    expect(w.get('[data-testid=observed-delta]').text()).toBe('+0.217');
    expect(w.get('[data-testid=interval]').text()).toBe('[+0.117, +0.333]');
    expect(w.text()).toContain('95% bootstrap interval');
    expect(w.text()).toContain('10,000');
    expect(w.get('[role=img]').attributes('aria-label')).toBe(
      'Difference +0.217, 95% interval +0.117 to +0.333, entirely above zero',
    );
    expect(w.text()).toContain('How to read this');
    expect(w.attributes('data-verdict')).toBe('better');
  });

  it('is dashed and says what it rests on while provisional', async () => {
    const view = await getComparison(EXPERIMENT_IDS.mcpVsBaseline);
    const w = mount(StatisticsPanel, { props: { view } });
    expect(w.get('[data-kind=verdict]').text()).toBe('Provisional');
    expect(w.attributes('data-verdict')).toBe('provisional');
    expect(w.text()).toContain(
      `Based on ${view.progress.scored} of 120 runs scored so far. The interval will change.`,
    );
    expect(w.get('[role=img]').attributes('aria-label')).toMatch(/^Provisional: difference /);
    expect(w.get('[role=img]').attributes('data-tone')).toBe('provisional');
  });

  it.each([
    [
      'too_few_tasks',
      'No interval with 2 tasks. Pass rates: baseline 0.25, with-mcp 0.75. A verdict needs at least 3 tasks: the interval resamples the tasks, and with fewer it cannot say how sure the difference is.',
      'No interval with 2 tasks.',
    ],
    [
      'not_enough_runs',
      'No interval: 2 tasks (task_2, task_3) counted fewer than 2 runs under a configuration, and cancelled runs do not count. A verdict needs at least 2 per task and configuration.',
      'No interval:',
    ],
  ] as const)(
    'keeps its place and says why without statistics (%s)',
    async (reason, message, lead) => {
      const base = await getComparison(EXPERIMENT_IDS.skillVsNoSkill);
      const view: ComparisonView = {
        ...base,
        statistics: null,
        statisticsUnavailable: { reason, message },
      };
      const w = mount(StatisticsPanel, { props: { view } });
      expect(w.get('[data-kind=verdict]').text()).toBe('not computable');
      const text = w.get('[data-testid=statistics-unavailable]');
      expect(text.get('b').text()).toBe(lead);
      expect(text.text().replace(/\s+/g, ' ')).toBe(message);
      expect(w.find('[role=img]').exists()).toBe(false);
    },
  );
});

describe('IntervalChart', () => {
  it('centres zero and widens the domain with the data', () => {
    const w = mount(IntervalChart, {
      props: { lo: -0.111, hi: 0.25, point: 0.056, verdict: 'inconclusive' },
    });
    expect(w.attributes('data-domain')).toBe('0.4');
    // Every tick reads its true value: −0.111 is drawn right of −0.2, left of 0.
    const ticks = w.findAll('.top-48').map((t) => t.text());
    expect(ticks).toEqual(['−0.4', '−0.2', '0', '+0.2', '+0.4']);
    const lo = Number(
      /left: ([\d.]+)%/.exec(w.get('[data-testid=interval-lo]').attributes('style') ?? '')?.[1],
    );
    expect(lo).toBeCloseTo(36.13, 1);
    expect(w.attributes('data-tone')).toBe('que');
    expect(w.attributes('aria-label')).toBe(
      'Difference +0.056, 95% interval −0.111 to +0.250, crosses zero',
    );
    expect(w.get('[data-testid=interval-lo]').text()).toBe('−0.111');
    expect(w.get('[data-testid=interval-hi]').text()).toBe('+0.250');
    expect(w.text()).toContain('no difference');
    const worse = mount(IntervalChart, {
      props: { lo: -0.267, hi: -0.033, point: -0.15, verdict: 'worse' },
    });
    expect(worse.attributes('data-tone')).toBe('fail');
    expect(worse.attributes('aria-label')).toMatch(/entirely below zero$/);
  });
});

describe('SecondaryMetricsPanel', () => {
  it('lists each configuration, the difference and the sensitivity line', async () => {
    const view = await getComparison(EXPERIMENT_IDS.skillVsNoSkill);
    const w = mount(SecondaryMetricsPanel, { props: { view }, global: { plugins: [router()] } });
    const rows = w.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => td.text()));
    expect(rows[0]).toEqual(['baseline', '48 s', '14,200', '$0.71', '1 timeout', '2']);
    expect(rows[1]?.[0]).toBe('with-skill');
    expect(rows[2]).toEqual(['Difference', '+13 s', '+39%', '+$0.27', '−1', '−2']);
    const links = w.findAll('a');
    expect(links.map((a) => a.attributes('href'))).toEqual([
      `/experiments/${EXPERIMENT_IDS.skillVsNoSkill}/runs?config=baseline&exec_error=1`,
      `/experiments/${EXPERIMENT_IDS.skillVsNoSkill}/runs?config=baseline&ungradable=1`,
    ]);
    expect(w.get('[data-testid=sensitivity]').text()).toMatch(
      /^Sensitivity: if the 3 baseline runs/,
    );
    expect(w.text()).toContain('Is the win really about answers, or about time and failures?');
  });
});
