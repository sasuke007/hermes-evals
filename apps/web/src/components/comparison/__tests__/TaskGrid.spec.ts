import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import RepetitionCells from '../RepetitionCells.vue';
import TaskGrid from '../TaskGrid.vue';
import { EXPERIMENT_IDS, getComparison } from '@/api/experiments';
import type { ComparisonRow, ComparisonView } from '@/api/types/experiments';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';

let view: ComparisonView;

beforeEach(async () => {
  useScenario(null);
  view = await getComparison(EXPERIMENT_IDS.skillVsNoSkill);
});
afterEach(() => {
  document.body.innerHTML = '';
});

function mountGrid(props: Partial<InstanceType<typeof TaskGrid>['$props']> = {}) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  return mount(TaskGrid, {
    props: {
      rows: view.rows,
      baseline: 'baseline',
      candidate: 'with-skill',
      repetitions: 5,
      ...props,
    },
    global: { plugins: [router] },
    attachTo: document.body,
  });
}

const cellsOf = (w: ReturnType<typeof mountGrid>) => w.findAll('button[data-run-id]');
const active = () => document.activeElement as HTMLElement | null;

describe('RepetitionCells', () => {
  it('draws one button per repetition, coloured by status, and opens the run', async () => {
    const row = view.rows.find((r) => r.taskKey === 'credit_notes')!;
    const w = mount(RepetitionCells, {
      props: { cells: row.baseline, taskKey: 'credit_notes', configuration: 'baseline' },
    });
    const buttons = w.findAll('button');
    expect(buttons.map((b) => b.attributes('data-look'))).toEqual([
      'failed',
      'ungradable',
      'failed',
      'passed',
      'failed',
    ]);
    expect(buttons[1]!.attributes('aria-label')).toBe(
      'credit_notes, baseline, repetition 2, ungradable. Open run.',
    );
    await buttons[3]!.trigger('click');
    expect(w.emitted('open')).toEqual([[row.baseline[3]!.runId]]);
  });

  it('draws the unscored statuses while running', async () => {
    useScenario(null);
    const running = await getComparison(EXPERIMENT_IDS.mcpVsBaseline);
    const looks = running.rows
      .flatMap((r) => [...r.baseline, ...r.candidate])
      .map((c) => c.runStatus);
    expect(new Set(looks)).toEqual(
      new Set(['scored', 'queued', 'running', 'scoring', 'execution_error']),
    );
    const row = running.rows.find((r) => r.candidate.some((c) => c.runStatus === 'scoring'))!;
    const w = mount(RepetitionCells, {
      props: { cells: row.candidate, taskKey: row.taskKey, configuration: 'with-mcp' },
    });
    expect(w.findAll('button').map((b) => b.attributes('data-look'))).toContain('scoring');
  });
});

describe('TaskGrid', () => {
  it('shows each task with its rates, Δ and change', () => {
    const w = mountGrid();
    const first = w.get('tbody tr');
    expect(first.attributes('data-task')).toBe('dup_invoices');
    expect(first.get('[data-testid=pass-baseline]').text()).toBe('0.20');
    expect(first.get('[data-testid=pass-candidate]').text()).toBe('0.80');
    expect(first.get('[data-testid=delta]').text()).toBe('+0.60');
    expect(first.get('[data-testid=change]').text()).toBe('improved');
    expect(w.get('th[aria-sort=descending]').text()).toBe('Δ ↓');
    const all = w.findAll('tbody tr');
    const last = all[all.length - 1]!;
    expect(last.get('[data-testid=delta]').text()).toBe('0.00');
    expect(last.get('[data-testid=change]').text()).toBe('unchanged');
  });

  it('keeps the sign of a change whose Δ rounds to zero', () => {
    const row: ComparisonRow = { ...view.rows[0]!, delta: 0, change: 'regressed' };
    const w = mountGrid({ rows: [row] });
    expect(w.get('[data-testid=delta]').text()).toBe('−0.00');
  });

  it('moves between cells with the arrow keys and opens one with Enter', async () => {
    const w = mountGrid();
    const cells = cellsOf(w);
    // Roving tabindex: one cell in the tab order.
    expect(cells.filter((c) => c.attributes('tabindex') === '0')).toHaveLength(1);
    (cells[0]!.element as HTMLElement).focus();
    const key = async (k: string, init: KeyboardEventInit = {}) => {
      active()!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }));
      await flushPromises();
    };
    await key('ArrowRight');
    expect(active()?.getAttribute('aria-label')).toBe(
      'dup_invoices, baseline, repetition 2, passed. Open run.',
    );
    await key('End');
    expect(active()?.getAttribute('aria-label')).toBe(
      'dup_invoices, with-skill, repetition 5, passed. Open run.',
    );
    await key('ArrowDown');
    expect(active()?.getAttribute('aria-label')).toBe(
      'credit_notes, with-skill, repetition 5, failed. Open run.',
    );
    await key('Home');
    expect(active()?.getAttribute('aria-label')).toBe(
      'credit_notes, baseline, repetition 1, failed. Open run.',
    );
    await key('End', { ctrlKey: true });
    expect(active()?.closest('tr')?.getAttribute('data-task')).toBe('total_due');
    await key('Enter');
    const lastRow = view.rows[view.rows.length - 1]!;
    const opened = w.emitted('open') ?? [];
    expect(opened[opened.length - 1]).toEqual([
      lastRow.candidate[lastRow.candidate.length - 1]!.runId,
    ]);
  });

  it('shows one tooltip for the focused cell and hides it with Esc', async () => {
    const w = mountGrid();
    const dup = w.get('tr[data-task=dup_invoices]');
    const sample = dup.findAll('button[data-run-id]')[2]!;
    await sample.trigger('focus');
    const tip = w.get('[data-testid=cell-tooltip]');
    expect(tip.attributes('role')).toBe('tooltip');
    expect(tip.text()).toMatch(/dup_invoices · baseline · rep\s3/);
    expect(tip.text()).toContain('failed');
    expect(tip.text()).toContain('scored · 52 s · attempt 1');
    expect(tip.text()).toContain(
      'expected 2 duplicate pairs, got 0; agent compared invoice numbers only',
    );
    expect(sample.attributes('aria-describedby')).toBe(tip.attributes('id'));
    expect(w.findAll('[data-testid=cell-tooltip]')).toHaveLength(1);
    await sample.trigger('keydown', { key: 'Escape' });
    expect(w.find('[data-testid=cell-tooltip]').exists()).toBe(false);
    // The pointer wins once it moves to another cell.
    await dup.findAll('button[data-run-id]')[0]!.trigger('mouseenter');
    expect(w.get('[data-testid=cell-tooltip]').text()).toMatch(/dup_invoices · baseline · rep\s1/);
  });

  it('asks to sort by suite order or by Δ', async () => {
    const w = mountGrid();
    await w.get('thead button').trigger('click');
    expect(w.emitted('sort')).toEqual([['task']]);
    await w.setProps({ sort: 'task' });
    expect(w.get('th[aria-sort=other]').text()).toBe('Task suite order');
  });

  it('drops Δ and the sort without a per-task difference, and adds fractions while provisional', async () => {
    useScenario('nothing-scored');
    const none = await getComparison(EXPERIMENT_IDS.mcpVsBaseline);
    view = none;
    const w = mountGrid({ rows: none.rows, showDelta: false, sortable: false, provisional: true });
    expect(w.findAll('th').map((th) => th.text())).toEqual([
      'Task',
      'baseline rep 1 → 5',
      'Pass',
      'with-skill rep 1 → 5',
      'Pass',
    ]);
    expect(w.get('[data-testid=pass-baseline]').text()).toBe('–');

    useScenario(null);
    const running = await getComparison(EXPERIMENT_IDS.mcpVsBaseline);
    const w2 = mountGrid({ rows: running.rows, provisional: true });
    expect(w2.get('[data-testid=pass-baseline]').text()).toMatch(/^\d\.\d\d \d\/\d$/);
  });
});
