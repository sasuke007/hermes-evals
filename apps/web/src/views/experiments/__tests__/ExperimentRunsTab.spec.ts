import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import { EXPERIMENT_IDS } from '@/api/experiments';
import { useExperimentDetailStore } from '@/stores/experiment-detail';
import { mountExperimentRoute, settle } from './experimentPage';

const SVN = EXPERIMENT_IDS.skillVsNoSkill;

let wrapper: VueWrapper | null = null;
async function open(query = '', scenario: string | null = null) {
  const page = await mountExperimentRoute(`/experiments/${SVN}/runs${query}`, scenario);
  wrapper = page.wrapper;
  return page;
}
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
});

const bodyRows = (w: VueWrapper) => w.findAll('[data-testid=runs-table] tbody tr[data-run-id]');
const cells = (row: ReturnType<VueWrapper['find']>) => row.findAll('td').map((td) => td.text());

describe('Runs tab (Runs board)', () => {
  it('lists every run with the count line and the compact header', async () => {
    const { wrapper: w } = await open();
    // Comparison and Runs draw only the breadcrumb, the title and the chip.
    expect(w.get('h1').text()).toBe('Skill vs no skill, invoices-v1');
    expect(w.find('[data-testid=experiment-meta]').exists()).toBe(false);
    expect(w.find('[data-testid=experiment-controls]').exists()).toBe(false);

    expect(bodyRows(w)).toHaveLength(120);
    const count = w.get('[data-testid=runs-count-line]');
    expect(count.text()).toContain('120 of 120 runs');
    expect(count.text()).toContain('89 passed · 28 failed');
    expect(count.get('[data-testid=chip-exec-error]').text()).toBe('1 execution error');
    expect(count.get('[data-testid=chip-ungradable]').text()).toBe('2 ungradable');
    expect(w.text()).toContain(
      'Re-score re-runs scorers on the stored output; it never re-executes the agent.',
    );
    const first = bodyRows(w)[0]!;
    expect(cells(first).slice(1, 7)).toEqual([
      'total_due',
      'baseline',
      '1',
      '1',
      'scored',
      'passed',
    ]);
    expect(first.get('input').attributes('aria-label')).toBe('Select total_due baseline rep 1');
    // Sorted by task, ascending, by default.
    expect(w.get('th[aria-sort=ascending]').text()).toContain('Task');
  });

  it('mirrors the shortcut chips and the filters in the URL', async () => {
    const { wrapper: w, router } = await open();
    await w.get('[data-testid=chip-exec-error]').trigger('click');
    await settle();
    expect(router.currentRoute.value.query).toMatchObject({ exec_error: '1' });
    const rows = bodyRows(w);
    expect(rows).toHaveLength(1);
    expect(cells(rows[0]!).slice(1, 6)).toEqual([
      'disputed',
      'baseline',
      '4',
      '2',
      'execution_error',
    ]);
    expect(w.get('[data-testid=runs-count-line]').text()).toContain('1 of 120 runs');
    // The toggles exclude each other.
    await w.get('[data-testid=toggle-ungradable]').trigger('click');
    await settle();
    expect(router.currentRoute.value.query.exec_error).toBeUndefined();
    expect(router.currentRoute.value.query.ungradable).toBe('1');
    expect(bodyRows(w)).toHaveLength(2);
  });

  it('reads the filters and the sort from the URL', async () => {
    const { wrapper: w } = await open('?config=with-skill&score_status=failed&sort=-duration');
    expect((w.get('#runs-config').element as HTMLSelectElement).value).toBe('with-skill');
    expect((w.get('#runs-score').element as HTMLSelectElement).value).toBe('failed');
    const rows = bodyRows(w);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => cells(r)[2] === 'with-skill' && cells(r)[6] === 'failed')).toBe(true);
    const durations = rows.map((r) => Number.parseInt(cells(r)[7]!, 10));
    expect([...durations].sort((a, b) => b - a)).toEqual(durations);
    expect(w.get('th[aria-sort=descending]').text()).toContain('Duration');
  });

  it('sorts on a header click, in the URL', async () => {
    const { wrapper: w, router } = await open();
    await w.get('button[data-sort-key=tokens]').trigger('click');
    await settle();
    expect(router.currentRoute.value.query.sort).toBe('-tokens');
    await w.get('button[data-sort-key=tokens]').trigger('click');
    await settle();
    expect(router.currentRoute.value.query.sort).toBe('tokens');
  });

  it('explains an empty result and clears the filters', async () => {
    const { wrapper: w, router } = await open('?config=with-skill&exec_error=1');
    const empty = w.get('[data-testid=runs-empty]');
    expect(empty.text()).toContain('No runs match these filters');
    expect(empty.text()).toContain(
      'with-skill has no execution errors in this experiment. The one execution error is on baseline.',
    );
    expect(w.get('[data-testid=runs-count-line]').text()).toContain('0 of 120 runs');
    await empty.get('button').trigger('click');
    await settle();
    expect(router.currentRoute.value.query).toEqual({});
    expect(bodyRows(w)).toHaveLength(120);
  });

  it('retries an execution error from the bulk bar', async () => {
    const { wrapper: w } = await open('?exec_error=1');
    await bodyRows(w)[0]!.get('input').setValue(true);
    await settle();
    const bar = w.get('[data-testid=bulk-bar]');
    expect(bar.attributes('role')).toBe('toolbar');
    expect(bar.text()).toContain('1 selected');
    expect(bar.get('[data-testid=bulk-hint]').text()).toBe('Creates attempt 3 for each run.');
    expect(bar.get('[data-testid=bulk-rescore]').attributes('disabled')).toBeDefined();
    await bar.get('[data-testid=bulk-retry]').trigger('click');
    await settle();
    expect(w.get('[data-testid=bulk-queued]').text()).toContain(
      'Retry queued for 1 run. Each starts a new attempt in a fresh trial container.',
    );
    // The row stays where it is and turns queued.
    expect(cells(bodyRows(w)[0]!)[5]).toBe('queued');
    expect(w.find('[data-testid=bulk-bar]').exists()).toBe(false);
  });

  it('re-scores scored runs and marks them pending', async () => {
    const { wrapper: w } = await open('?task=total_due');
    await w.get('thead input').setValue(true);
    await settle();
    expect(w.get('[data-testid=bulk-bar]').text()).toContain('10 selected');
    await w.get('[data-testid=bulk-rescore]').trigger('click');
    await settle();
    expect(w.get('[data-testid=bulk-queued]').text()).toContain('Re-score queued for 10 runs.');
    expect(w.findAll('[data-testid=rescore-pending]')).toHaveLength(10);
  });

  it('names every run the API could not enqueue (bulk-refused)', async () => {
    const { wrapper: w } = await open('?task=total_due', 'bulk-refused');
    await bodyRows(w)[0]!.get('input').setValue(true);
    await settle();
    await w.get('[data-testid=bulk-rescore]').trigger('click');
    await settle();
    const banner = w.get('[data-testid=bulk-refused]');
    expect(banner.attributes('role')).toBe('alert');
    expect(banner.text()).toContain('1 of 1 run could not be re-scored');
    expect(banner.text()).toContain('total_due · baseline · rep 1');
    expect(banner.text()).toContain('evaluate-run job could not be enqueued: queue unavailable');
  });

  it('blocks Re-score of a judged task while Nous Portal is not connected', async () => {
    const { wrapper: w } = await open('?task=credit_notes', 'nous-not-connected');
    await bodyRows(w)[0]!.get('input').setValue(true);
    await settle();
    const rescore = w.get('[data-testid=bulk-rescore]');
    expect(rescore.attributes('disabled')).toBeDefined();
    expect(rescore.attributes('title')).toBe('Re-score needs Nous Portal for the method judge.');
    expect(w.get('[data-testid=bulk-hint]').text()).toBe(
      'Re-score needs Nous Portal for the method judge.',
    );
    expect(w.get('[data-testid=bulk-hint] code').text()).toBe('method');
    expect(w.find('[data-testid=bulk-connect]').exists()).toBe(true);
  });

  it('opens a run in the inspector over the table, keeping the filters, J/K in table order', async () => {
    const { wrapper: w, router, pinia } = await open('?config=baseline');
    const row = bodyRows(w)[2]!;
    const runId = row.attributes('data-run-id')!;
    await row.findAll('td')[3]!.trigger('click');
    await settle();
    expect(router.currentRoute.value.name).toBe('experiment-run');
    expect(router.currentRoute.value.params.runId).toBe(runId);
    expect(router.currentRoute.value.query).toEqual({ config: 'baseline' });
    const order = useExperimentDetailStore(pinia).runOrder;
    expect(order).toHaveLength(60);
    expect(order[2]).toBe(runId);
  });

  it('keeps Runs the current tab while its drawer is open', async () => {
    const { wrapper: w } = await open();
    const runId = bodyRows(w)[0]!.attributes('data-run-id')!;
    w.unmount();
    const page = await mountExperimentRoute(`/experiments/${SVN}/runs/${runId}`);
    wrapper = page.wrapper;
    const tabs = page.wrapper.findAll('nav[aria-label="Experiment"] a');
    expect(tabs.map((a) => a.attributes('aria-current') ?? null)).toEqual([null, null, 'page']);
  });

  it('gives focus to the run’s row when a drawer opened by its link closes', async () => {
    const { wrapper: w } = await open();
    const runId = bodyRows(w)[4]!.attributes('data-run-id')!;
    w.unmount();
    const page = await mountExperimentRoute(`/experiments/${SVN}/runs/${runId}`);
    wrapper = page.wrapper;
    expect(page.wrapper.find('[data-testid=run-inspector]').exists()).toBe(true);
    await page.wrapper.get('[data-testid=close-inspector]').trigger('click');
    await settle();
    expect(page.router.currentRoute.value.name).toBe('experiment-runs');
    expect(page.wrapper.find('[data-testid=run-inspector]').exists()).toBe(false);
    const link = page.wrapper.get(`tr[data-run-id="${runId}"] a`).element;
    expect(document.activeElement).toBe(link);
  });

  it('draws skeleton rows while loading and the error with Retry', async () => {
    const loading = await open('', 'loading');
    expect(loading.wrapper.findAll('[data-testid=skeleton-row]')).toHaveLength(6);
    loading.wrapper.unmount();
    wrapper = null;

    const { wrapper: w } = await open('?exec_error=1', 'error');
    const banner = w.get('[data-testid=runs-error]');
    expect(banner.text()).toContain('Could not load runs');
    expect(banner.text()).toContain(
      `GET /api/experiments/${SVN}/runs → 502 · upstream api:8080 connection refused`,
    );
    expect(banner.text()).toContain(
      'Filters and sort stay in the URL, so Retry loads the same view.',
    );
    // The filter bar stays.
    expect(w.find('#runs-config').exists()).toBe(true);
  });
});
