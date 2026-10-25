import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import DataTable from '@/components/ui/DataTable.vue';
import ErrorBanner from '@/components/ui/ErrorBanner.vue';
import EmptyState from '@/components/ui/EmptyState.vue';
import LiveIndicator from '@/components/ui/LiveIndicator.vue';
import SegmentedControl from '@/components/ui/SegmentedControl.vue';
import type { DataTableColumn } from '@/components/ui/types';
import { memoryStorage } from '@/stores/__tests__/scenarioEnv';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ErrorBanner', () => {
  it('error: role alert, title, verbatim mono detail, hint and Retry', async () => {
    const w = mount(ErrorBanner, {
      props: {
        title: 'Could not load experiments',
        detail: 'GET /api/experiments → 502 · upstream api:8080 connection refused',
        hint: 'Check that the api service is up: docker compose ps',
        retryLabel: 'Retry',
      },
    });
    expect(w.attributes('role')).toBe('alert');
    expect(w.find('[data-testid="error-banner-title"]').text()).toBe('Could not load experiments');
    expect(w.find('code').text()).toBe(
      'GET /api/experiments → 502 · upstream api:8080 connection refused',
    );
    expect(w.find('[data-testid="error-banner-hint"]').text()).toContain('docker compose ps');
    await w.find('button').trigger('click');
    expect(w.emitted('retry')).toHaveLength(1);
  });

  it('warning and info are status messages without mono', () => {
    const warn = mount(ErrorBanner, {
      props: { tone: 'warning', title: '1 task failed self-check after reload', detail: 'x' },
    });
    expect(warn.attributes('role')).toBe('status');
    expect(warn.find('code').exists()).toBe(false);
    expect(warn.attributes('data-tone')).toBe('warning');
    expect(mount(ErrorBanner, { props: { tone: 'info' } }).attributes('data-tone')).toBe('info');
    expect(mount(ErrorBanner, { props: { tone: 'violet' } }).attributes('role')).toBe('alert');
  });
});

describe('EmptyState', () => {
  it('says what is missing and offers the one action', () => {
    const w = mount(EmptyState, {
      props: { title: 'No experiments yet', body: 'An experiment runs every task…' },
      slots: { actions: '<button class="btn primary">New experiment</button>' },
    });
    expect(w.text()).toContain('No experiments yet');
    expect(w.find('button').text()).toBe('New experiment');
    expect(w.classes()).toContain('border');
    expect(w.classes()).toContain('text-center');
  });
});

describe('LiveIndicator', () => {
  it.each([
    ['live', {}, 'Live'],
    [
      'reconnecting',
      { attempt: 3, lastEventAt: new Date(2026, 9, 24, 15, 23, 42) },
      'Reconnecting (attempt 3) · last update 15:23:42',
    ],
    ['paused', {}, 'Paused'],
    ['offline', {}, 'Offline Retry'],
    ['finished', {}, 'Finished'],
  ] as const)('%s', (state, extra, text) => {
    const w = mount(LiveIndicator, { props: { state, ...extra } });
    expect(w.text().replace(/\s+/g, ' ')).toBe(text);
    expect(w.attributes('data-state')).toBe(state);
  });

  it('announces the state only, never the time that moves with each event', async () => {
    const w = mount(LiveIndicator, {
      props: { state: 'live', detail: 'updated 15:23:42' },
    });
    expect(w.text()).toBe('Live · updated 15:23:42');
    expect(w.attributes('role')).toBeUndefined();
    expect(w.get('[role=status]').text()).toBe('Live');
    await w.setProps({ detail: 'updated 15:23:43' });
    expect(w.get('[role=status]').text()).toBe('Live');
    await w.setProps({
      state: 'reconnecting',
      attempt: 2,
      lastEventAt: new Date(2026, 9, 24, 15, 23, 43),
    });
    expect(w.text()).toBe('Reconnecting (attempt 2) · last update 15:23:43');
    expect(w.get('[role=status]').text()).toBe('Reconnecting (attempt 2)');
  });

  it('uses a custom label while live, and hides "Finished" after 5 s', async () => {
    vi.useFakeTimers();
    const w = mount(LiveIndicator, { props: { state: 'live', label: '1 running · 87 / 120' } });
    expect(w.text()).toBe('1 running · 87 / 120');
    await w.setProps({ state: 'finished' });
    expect(w.text()).toBe('Finished');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.text()).toBe('');
  });
});

describe('SegmentedControl', () => {
  it('renders aria-pressed buttons with counts and updates the model', async () => {
    const w = mount(SegmentedControl, {
      props: {
        modelValue: 'all',
        label: 'Filter tasks',
        options: [
          { value: 'all', label: 'All', count: 12 },
          { value: 'improved', label: 'Improved', count: 8 },
        ],
      },
    });
    expect(w.attributes('role')).toBe('group');
    const [all, improved] = w.findAll('button');
    expect(all!.text().replace(/\s+/g, ' ')).toBe('All 12');
    expect(all!.attributes('aria-pressed')).toBe('true');
    await improved!.trigger('click');
    expect(w.emitted('update:modelValue')?.[0]).toEqual(['improved']);
    // The row clips its corners: the focus ring is drawn inside the button, above the next.
    expect(w.classes()).toContain('overflow-hidden');
    expect(all!.classes()).toEqual(
      expect.arrayContaining([
        'focus-visible:-outline-offset-2',
        'focus-visible:relative',
        'focus-visible:z-1',
      ]),
    );
  });
});

interface Run {
  id: string;
  task: string;
  duration: number;
  status: string;
}
const runs: Run[] = [
  { id: 'r1', task: 'total_due', duration: 31, status: 'scored' },
  { id: 'r2', task: 'disputed', duration: 300, status: 'execution_error' },
  { id: 'r3', task: 'dup_invoices', duration: 52, status: 'scored' },
];
const columns: DataTableColumn<Run>[] = [
  { key: 'task', label: 'Task', mono: true, sortable: true },
  { key: 'status', label: 'Status' },
  { key: 'duration', label: 'Duration', align: 'right', sortable: true, width: 90 },
];

describe('DataTable', () => {
  const tasks = (w: ReturnType<typeof mount>) =>
    w.findAll('tbody tr').map((tr) => tr.findAll('td[data-mono]')[0]?.text());

  it('sorts on a header button, numbers descending first', async () => {
    const w = mount(DataTable<Run>, { props: { columns, rows: runs } });
    const durationHeader = w.findAll('th')[2]!;
    expect(durationHeader.attributes('aria-sort')).toBe('none');
    await durationHeader.find('button').trigger('click');
    expect(tasks(w)).toEqual(['disputed', 'dup_invoices', 'total_due']);
    expect(w.findAll('th')[2]!.attributes('aria-sort')).toBe('descending');
    await w.findAll('th')[2]!.find('button').trigger('click');
    expect(tasks(w)).toEqual(['total_due', 'dup_invoices', 'disputed']);
  });

  it('selects rows and shows the bulk bar', async () => {
    const w = mount(DataTable<Run>, {
      props: { columns, rows: runs, selectable: true, selected: [] },
      slots: { bulk: '<button class="btn sm">Re-score</button>' },
    });
    await w.findAll('tbody input[type="checkbox"]')[0]!.trigger('change');
    const lastSelected = (): unknown => {
      const all = w.emitted('update:selected') ?? [];
      return all[all.length - 1]?.[0];
    };
    const selected = lastSelected() as string[];
    expect(selected).toEqual(['r1']);
    await w.setProps({ selected });
    expect(w.find('[role="region"][aria-label="Bulk actions"]').text()).toContain('1 selected');
    expect(w.find('tbody tr').attributes('data-selected')).toBe('true');
    await w.find('thead input[type="checkbox"]').trigger('change');
    expect(lastSelected()).toEqual(['r1', 'r2', 'r3']);
  });

  it('shows skeletons, then an empty state, then an error over dimmed rows', async () => {
    const w = mount(DataTable<Run>, { props: { columns, rows: [], loading: true } });
    expect(w.find('table').attributes('aria-busy')).toBe('true');
    expect(w.findAll('tbody tr[data-testid="skeleton-row"]')).toHaveLength(6);
    await w.setProps({ loading: false, emptyTitle: 'No runs match these filters' });
    expect(w.find('tbody').text()).toContain('No runs match these filters');
    expect(w.find('thead').exists()).toBe(true);
    await w.setProps({
      rows: runs,
      error: 'GET /api/runs → 502 · upstream api:8080 connection refused',
    });
    expect(w.find('[role="alert"]').text()).toContain('GET /api/runs → 502');
    expect(w.find('tbody').attributes('data-dimmed')).toBe('true');
  });

  it('draws skeleton bars at the widths and heights the columns give', () => {
    const w = mount(DataTable<Run>, {
      props: {
        columns: [
          { key: 'task', label: 'Task', skeleton: [120, 90] },
          { key: 'status', label: 'Status', skeleton: { width: 64, height: 16 } },
          { key: 'duration', label: 'Duration', align: 'right', width: 90 },
        ],
        rows: [],
        loading: true,
        skeletonRows: 2,
      },
    });
    const bars = w.findAll('tbody tr')[1]!.findAll('span');
    const style = (i: number) => (bars[i]!.element as HTMLElement).style;
    expect(style(0).width).toBe('90px');
    expect([style(1).width, style(1).height]).toEqual(['64px', '16px']);
    expect([style(2).width, style(2).marginLeft]).toEqual(['54px', 'auto']);
  });

  it('freezes the order while sorted on a live column', async () => {
    const w = mount(DataTable<Run>, {
      props: {
        columns,
        rows: runs,
        liveKeys: ['duration'],
        sort: { key: 'duration', dir: 'desc' },
      },
    });
    expect(tasks(w)).toEqual(['disputed', 'dup_invoices', 'total_due']);
    expect(w.text()).toContain('Sort is paused while live');
    await w.setProps({
      rows: runs.map((r) => (r.id === 'r1' ? { ...r, duration: 999 } : r)),
    });
    expect(tasks(w)).toEqual(['disputed', 'dup_invoices', 'total_due']);
  });

  it('remembers density per table', async () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const w = mount(DataTable<Run>, {
      props: { columns, rows: runs, tableId: 'runs', showDensity: true },
    });
    await w.find('[role="group"][aria-label="Row density"] button').trigger('click');
    expect(w.find('table').classes()).toContain('compact');
    expect(localStorage.getItem('hermes-evals.density.runs')).toBe('compact');
  });

  it('emits row-click for clickable rows, but not from controls inside them', async () => {
    const w = mount(DataTable<Run>, {
      props: { columns, rows: runs, clickable: true, selectable: true },
    });
    await w.find('tbody tr').trigger('click');
    expect(w.emitted('row-click')).toHaveLength(1);
    await w.find('tbody input').trigger('click');
    expect(w.emitted('row-click')).toHaveLength(1);
  });
});
