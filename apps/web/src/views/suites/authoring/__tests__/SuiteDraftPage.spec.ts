/**
 * The suite in draft mode (SA.3, SA.12, SA.13) on fixtures: the header and bar, the task
 * table, Edit details with its empty-label problem, discarding, the empty draft of a new
 * suite, the conflict resolver and Combine, and the loading, error and no-draft states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { h } from 'vue';
import { createMemoryHistory, createRouter, RouterView, type Router } from 'vue-router';
import { routes } from '@/router';
import { resetDraftFixtures } from '@/api/drafts-fixtures';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { SUITE_V2_ID } from '@/fixtures/suites';
import { useDraftStore } from '@/stores/draft';
import { useSuitesStore } from '@/stores/suites';
import SuiteDraftPage from '../SuiteDraftPage.vue';

/** Lazy pages and debounced writes take longer while every package's tests run at once. */
const LAZY_MS = 10_000;

function makeRouter(): Router {
  return createRouter({
    history: createMemoryHistory(),
    routes,
  });
}

async function mountPage(folder = 'invoices-v1', query = '') {
  const router = makeRouter();
  await router.push(`/suites/${folder}/draft${query}`);
  // Inside a RouterView, as the app renders it, so the page's leave guard has its route.
  const pinia = createPinia();
  const root = mount(
    { render: () => h(RouterView) },
    { global: { plugins: [pinia, router] }, attachTo: document.body },
  );
  await flushPromises();
  return { w: root.findComponent(SuiteDraftPage), root, router, pinia };
}

beforeEach(() => {
  useScenario(null);
  resetDraftFixtures();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('SuiteDraftPage', () => {
  it('draws the draft: header, bar, task table and history', async () => {
    const { w, root } = await mountPage();
    expect(w.get('h1').text()).toBe('invoices-v1');
    expect(w.get('[data-testid="task-count"]').text()).toBe('13 tasks in the draft · v1 has 12');
    expect(w.get('[data-testid="suite-draft-bar"]').text()).toContain('Review and save as v2');
    expect(w.findAll('[data-testid="draft-task-table"] tbody tr[data-key]')).toHaveLength(13);
    expect(w.text()).toContain('History');
    expect(w.get('a[download]').attributes('download')).toBe('invoices-v1-v1.zip');
    root.unmount();
  });

  it('opens Edit details, and an empty label blocks Review and save', async () => {
    vi.useFakeTimers();
    const { w, root } = await mountPage('invoices-v1', '?details=1');
    const details = w.get('[data-testid="draft-details"]');
    expect(details.text()).toContain('Fixed after the first save.');
    await details.get('input').setValue('');
    expect(details.text()).toContain('Add a version label.');
    await vi.advanceTimersByTimeAsync(800);
    await flushPromises();
    expect(w.get('[data-testid="review-blocked"]').text()).toBe('Add a version label.');
    root.unmount();
  });

  it('adds a blank task and opens it in the editor', async () => {
    const { w, root, router } = await mountPage();
    await w.get('[data-testid="add-task"]').trigger('click');
    await w
      .findAll('[role="menuitem"]')
      .find((m) => m.text() === 'Blank task')!
      .trigger('click');
    // The editor's route loads its page lazily.
    await vi.waitFor(
      () =>
        expect(router.currentRoute.value.fullPath).toBe('/suites/invoices-v1/draft/tasks/new_task'),
      { timeout: LAZY_MS },
    );
    root.unmount();
  });

  it('discards the draft and goes back to the suite', async () => {
    const { w, root, router } = await mountPage();
    await w
      .findAll('button')
      .find((b) => b.text() === 'Discard draft')!
      .trigger('click');
    await w
      .get('[role="alertdialog"]')
      .findAll('button')
      .find((b) => b.text() === 'Discard')!
      .trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('suite'), {
      timeout: LAZY_MS,
    });
    root.unmount();
  });

  it('asks for the first task of a new suite', async () => {
    useScenario('draft-new-suite');
    resetDraftFixtures();
    const { w, root } = await mountPage('vendor-statements-v1');
    expect(w.text()).toContain('not saved yet');
    const empty = w.get('[data-testid="draft-empty"]');
    expect(empty.text()).toContain('Add your first task');
    expect(empty.text()).toContain('A suite needs at least one task before it can be saved as v1.');
    expect(empty.text()).toContain(
      'Saved as files in ./suites/vendor-statements-v1/ on this machine.',
    );
    expect(w.get('[data-testid="review-blocked"]').text()).toBe(
      'Add at least one task to save v1.',
    );
    root.unmount();
  });

  it('combines onto the newer version once each overlap has a choice', async () => {
    useScenario('draft-conflict-overlap');
    resetDraftFixtures();
    const { w, root } = await mountPage();
    await flushPromises();
    expect(w.find('[data-testid="conflict-resolver"]').exists()).toBe(true);
    // The header names the version now on disk, which the bar under it says the folder moved to.
    await vi.waitFor(() =>
      expect(w.get('[data-testid="task-count"]').text()).toBe('13 tasks in the draft · v2 has 12'),
    );
    expect(w.get('[data-testid="suite-strip"]').text()).toMatch(/· v2 · loaded \d+ \w+ 15:41$/);
    expect(w.get('a[download]').attributes('download')).toBe('invoices-v1-v2.zip');
    expect(w.get('[data-testid="combine"]').attributes('disabled')).toBeDefined();
    await w.get('[data-testid="conflict-resolver"] input[type="radio"]').setValue(true);
    await flushPromises();
    await w.get('[data-testid="combine"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="combine"]').exists()).toBe(false);
    expect(w.get('[data-testid="review-save"]').text()).toBe('Review and save as v3');
    root.unmount();
  });

  it("lists History from the conflict's newer version, fetched when the conflict shows", async () => {
    useScenario('draft-conflict-overlap');
    resetDraftFixtures();
    const { w, root, pinia } = await mountPage();
    const suites = useSuitesStore(pinia);
    const spy = vi.spyOn(suites, 'loadHistory');
    await vi.waitFor(() => expect(suites.histories[SUITE_V2_ID]).toBeDefined());
    expect(w.text()).toContain('History');
    // A later conflict (a save that found files edited on disk) fetches it again.
    const store = useDraftStore(pinia);
    const view = store.drafts['invoices-v1']!;
    store.drafts['invoices-v1'] = {
      ...view,
      conflict: { ...view.conflict!, current: { ...view.conflict!.current, suiteId: 'suite_v3' } },
    };
    await flushPromises();
    expect(spy).toHaveBeenCalledWith('suite_v3', true);
    root.unmount();
  });

  it('offers to start a draft when the folder has none', async () => {
    useScenario('draft-none');
    resetDraftFixtures();
    const { w, root } = await mountPage();
    expect(w.get('[data-testid="draft-missing"]').text()).toContain('No draft of invoices-v1');
    await w.get('[data-testid="draft-missing"] button').trigger('click');
    await flushPromises();
    expect(w.find('[data-testid="suite-draft-bar"]').exists()).toBe(true);
    root.unmount();
  });

  it('keeps the layout while loading and quotes a failed load with Retry', async () => {
    useScenario('loading');
    const loading = await mountPage();
    expect(loading.w.find('[data-testid="draft-loading"]').exists()).toBe(true);
    loading.root.unmount();
    useScenario('error');
    const failed = await mountPage();
    expect(failed.w.text()).toContain('Could not load the draft of invoices-v1');
    expect(failed.w.text()).toContain(
      'GET /api/suites/invoices-v1/draft → 502 · upstream api:8080 connection refused',
    );
    expect(failed.w.text()).toContain(
      'The draft is stored by the api service, not in this tab, so nothing is lost.',
    );
    failed.root.unmount();
  });
});
