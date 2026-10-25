/**
 * The Experiment list in each designed state (ExperimentList board, ExperimentStates list
 * frames), from fixtures: the rows with their chips, filters in the URL, loading, first-load
 * and refresh errors, empty (with and without a model), the setup cards, and live polling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, getActivePinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import * as experimentsApi from '@/api/experiments';
import { newExperimentOptionsFixture } from '@/fixtures/experiments';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { LIST_POLL_INTERVAL_MS, useExperimentsStore } from '@/stores/experiments';
import { useProvidersStore } from '@/stores/providers';
import ExperimentListPage from '@/views/experiments/ExperimentListPage.vue';

let router: Router;

async function mountPage(path = '/experiments') {
  const pinia = createPinia();
  setActivePinia(pinia);
  router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  const providers = useProvidersStore();
  // Under `loading` every fixture stays pending, the providers too.
  if (new URLSearchParams(window.location.search).get('scenario') === 'loading') {
    void providers.load();
  } else {
    await providers.load();
  }
  const w = mount(ExperimentListPage, {
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

const bodyRows = (w: Awaited<ReturnType<typeof mountPage>>) =>
  w.findAll('tbody tr').filter((tr) => tr.attributes('data-testid') !== 'skeleton-row');
const rowNamed = (w: Awaited<ReturnType<typeof mountPage>>, name: string) => {
  const row = bodyRows(w).find((tr) => tr.text().includes(name));
  if (!row) throw new Error(`no row ${name}`);
  return row;
};

beforeEach(() => useScenario(null));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('ExperimentListPage', () => {
  it('lists every experiment, newest first, with the board columns', async () => {
    const w = await mountPage();
    expect(w.get('h1').text()).toBe('Experiments');
    expect(w.text()).toContain('6 experiments');
    const names = bodyRows(w).map((tr) => tr.find('td a').text());
    expect(names).toEqual([
      'Skill + MCP, invoices-v1',
      'MCP vs baseline, invoices-v1',
      'MCP vs baseline, first try',
      'MCP smoke test, invoices-v1',
      'Skill vs no skill, invoices-v1',
      'Skill vs no skill, quick check',
    ]);
    const headers = w.findAll('thead th').map((th) => th.text());
    expect(headers).toEqual([
      'Name',
      'Suite',
      'Configurations baseline · candidates',
      'Reps',
      'Runs',
      'Progress',
      'Status',
      'Verdict',
      'Created',
      'Est. cost',
    ]);
    const mcp = rowNamed(w, 'MCP vs baseline, invoices-v1');
    expect(mcp.text()).toContain('invoices-v1 v1');
    expect(mcp.text()).toContain('baseline · with-mcp');
    expect(mcp.get('[role="progressbar"]').attributes()).toMatchObject({
      'aria-valuenow': '87',
      'aria-valuemax': '120',
      'aria-label': '87 of 120 runs scored',
    });
    expect(mcp.text()).toContain('87 / 120');
    expect(mcp.text()).toContain('$1.21');
    expect(mcp.get('[data-kind="experiment"]').attributes('data-status')).toBe('running');
  });

  it('shows verdict chips that open the comparison for that candidate', async () => {
    const w = await mountPage();
    const chip = rowNamed(w, 'Skill vs no skill, invoices-v1').get('[data-testid="verdict-chip"]');
    expect(chip.text()).toBe('with-skill better');
    expect(chip.attributes('title')).toBe('Δ +0.217, 95% CI [+0.117, +0.333]');
    expect(chip.attributes('href')).toBe(
      '/experiments/exp_01JBB7SVNS/comparison?candidate=cfgv_01JAX9SKIL1',
    );
    const smoke = rowNamed(w, 'MCP smoke test').get('[data-testid="verdict-chip"]');
    expect(smoke.text()).toBe('with-mcp inconclusive');
    expect(smoke.attributes('title')).toBe('Δ +0.056, 95% CI [−0.111, +0.250]');
  });

  it('says why a row has no verdict yet', async () => {
    const w = await mountPage();
    const noVerdict = (name: string) => rowNamed(w, name).get('[data-testid="no-verdict"]').text();
    expect(noVerdict('MCP vs baseline, invoices-v1')).toBe('Provisional');
    expect(noVerdict('quick check')).toBe('No interval (1 rep)');
    expect(noVerdict('first try')).toBe('–');
  });

  it("puts the failed experiment's reason on its status chip, on hover and focus", async () => {
    const w = await mountPage();
    const failed = rowNamed(w, 'first try');
    const trigger = failed.get('[data-testid="status-reason-trigger"]');
    expect(trigger.attributes('tabindex')).toBe('0');
    const tip = failed.get('[role="tooltip"]');
    expect(tip.text()).toBe('invoice-db failed to start (setup) in 14 of 14 runs');
    expect(trigger.attributes('aria-describedby')).toBe(tip.attributes('id'));
  });

  it("puts a user pause's reason on its chip, as the API words it", async () => {
    const w = await mountPage();
    const paused = rowNamed(w, 'quick check');
    const trigger = paused.get('[data-testid="status-reason-trigger"]');
    const tip = paused.get('[role="tooltip"]');
    expect(tip.text()).toBe('Paused by the user');
    expect(trigger.attributes('aria-describedby')).toBe(tip.attributes('id'));
    expect(trigger.findAll('[data-status]').map((c) => c.attributes('data-status'))).toEqual([
      'paused',
    ]);
  });

  it('draws a provider pause as paused plus the amber reason chip (Components 3)', async () => {
    useScenario('paused-provider');
    const w = await mountPage();
    const row = rowNamed(w, 'MCP vs baseline, invoices-v1');
    const chips = row.get('[data-testid="status-reason-trigger"]').findAll('[data-status]');
    expect(chips.map((c) => [c.text(), c.attributes('data-tone')])).toEqual([
      ['paused', 'que'],
      ['provider disconnected', 'ung'],
    ]);
    expect(chips[0]!.get('[data-dot]').attributes('data-dot')).toBe('hollow');
    expect(chips[1]!.get('[data-dot]').attributes('data-dot')).toBe('solid');
    expect(row.get('[role="tooltip"]').text()).toBe('Paused: Nous Portal is not connected');
  });

  it('opens the Overview when a row is clicked', async () => {
    const w = await mountPage();
    // The Overview itself is another page's; only where the row goes is checked here.
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined);
    await rowNamed(w, 'MCP smoke test').trigger('click');
    expect(push).toHaveBeenCalledWith({
      name: 'experiment-overview',
      params: { id: 'exp_01JBCMCPSM' },
    });
  });

  it('filters by status and by search, mirrored in the URL', async () => {
    const w = await mountPage();
    const group = w.get('[role="group"][aria-label="Status"]');
    expect(group.findAll('button').map((b) => b.text())).toEqual([
      'All 6',
      'running 2',
      'paused 1',
      'completed 2',
      'failed 1',
    ]);
    await group.findAll('button')[1]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.status).toBe('running');
    expect(bodyRows(w)).toHaveLength(2);

    await w.get('input[type="search"]').setValue('smoke');
    await flushPromises();
    expect(router.currentRoute.value.query.q).toBe('smoke');
    expect(w.text()).toContain('No experiments match these filters');
    await w
      .findAll('button')
      .find((b) => b.text() === 'Clear filters')!
      .trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({});
    expect(bodyRows(w)).toHaveLength(6);
  });

  it('reads the filters from the URL', async () => {
    const w = await mountPage('/experiments?status=completed&q=skill');
    expect(bodyRows(w).map((tr) => tr.find('td a').text())).toEqual([
      'Skill vs no skill, invoices-v1',
    ]);
  });

  it('sorts by Created, newest first by default', async () => {
    const w = await mountPage();
    const sortButton = w.get('button[aria-label="Created, sorted newest first"]');
    await sortButton.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.sort).toBe('createdAt');
    expect(bodyRows(w)[0]!.text()).toContain('Skill vs no skill, quick check');
    expect(w.find('button[aria-label="Created, sorted oldest first"]').exists()).toBe(true);
  });

  it('loading: skeleton rows at the real columns, the header and New experiment at once', async () => {
    useScenario('loading');
    const w = await mountPage();
    expect(w.findAll('[data-testid="skeleton-row"]')).toHaveLength(6);
    expect(w.get('table').attributes('aria-busy')).toBe('true');
    expect(w.text()).not.toContain('experiments ');
    expect(w.get('a.btn.primary').text()).toBe('New experiment');
  });

  it('loading for over 10 s says the API is slow', async () => {
    useScenario('loading');
    vi.useFakeTimers();
    const w = await mountPage();
    expect(w.text()).not.toContain('Still loading');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(w.text()).toContain('Still loading. The API is slow to respond');
  });

  it('first-load error: the API message verbatim and Retry, no table', async () => {
    useScenario('error');
    const w = await mountPage();
    const alert = w.get('[role="alert"]');
    expect(alert.text()).toContain('Could not load experiments');
    expect(alert.get('code').text()).toBe(
      'GET /api/experiments → 502 · upstream api:8080 connection refused',
    );
    expect(alert.text()).toContain('docker compose ps');
    expect(w.find('table').exists()).toBe(false);

    useScenario(null);
    await alert.get('button').trigger('click');
    await flushPromises();
    expect(bodyRows(w)).toHaveLength(6);
    expect(w.find('[role="alert"]').exists()).toBe(false);
  });

  it('refresh error: keeps the last rows under a banner with their time', async () => {
    const w = await mountPage();
    useScenario('error');
    await useExperimentsStore().loadList();
    await flushPromises();
    const alert = w.get('[role="alert"]');
    expect(alert.text()).toContain('Could not refresh experiments');
    expect(alert.text()).toMatch(/Showing data from \d\d:\d\d:\d\d\./);
    expect(bodyRows(w)).toHaveLength(6);
  });

  it('empty: what an experiment is, with what exists so far', async () => {
    useScenario('first-launch');
    const w = await mountPage();
    expect(w.text()).toContain('No experiments yet');
    expect(w.text()).toContain('You need a suite and at least two configurations to start.');
    expect(w.text()).toContain('1 suite loaded · 0 configurations');
    const links = w.get('[data-testid="empty-state"]').findAll('a');
    expect(links.map((a) => [a.text(), a.attributes('href')])).toEqual([
      ['New experiment', '/experiments/new'],
      ['Set up configurations', '/configurations'],
    ]);
  });

  it('empty: counts what exists again on a return visit (configurations made meanwhile)', async () => {
    useScenario('first-launch');
    const first = await mountPage();
    expect(first.text()).toContain('1 suite loaded · 0 configurations');
    first.unmount();
    // Flow A: the user went to Configurations and made the baseline and the candidate.
    const options = await experimentsApi.getNewExperimentOptions();
    const made = newExperimentOptionsFixture(() => false).configurations.slice(0, 2);
    vi.spyOn(experimentsApi, 'getNewExperimentOptions').mockResolvedValue({
      ...options,
      configurations: made,
    });
    const again = mount(ExperimentListPage, {
      global: { plugins: [getActivePinia()!, router] },
      attachTo: document.body,
    });
    await flushPromises();
    expect(again.text()).toContain('1 suite loaded · 2 configurations');
  });

  it('empty with no model connected: the setup card is the empty state', async () => {
    useScenario('empty,nous-not-connected');
    const w = await mountPage();
    expect(w.find('[data-testid="setup-empty"]').exists()).toBe(true);
    expect(w.find('[data-testid="setup-card"]').exists()).toBe(false);
    expect(w.text()).toContain('Connect a model.');
    expect(w.find('table').exists()).toBe(false);
  });

  it('no model connected: SetupCard above the list, which stays usable', async () => {
    useScenario('nous-not-connected');
    const w = await mountPage();
    expect(w.get('[data-testid="setup-card"]').text()).toContain(
      'Connect a model to run experiments',
    );
    expect(bodyRows(w)).toHaveLength(6);
  });

  it('only an API-key provider without its key: the .env step instead of Connect', async () => {
    const w = await mountPage();
    const providers = useProvidersStore();
    providers.providers = providers.providers.map((p) =>
      p.id === 'nous'
        ? { ...p, usedBy: [] }
        : p.id === 'openrouter'
          ? { ...p, status: 'missing', usedBy: ['or-baseline'] }
          : p,
    );
    await flushPromises();
    const card = w.get('[data-testid="key-setup-card"]');
    expect(card.text()).toContain('Add an OpenRouter API key to run experiments');
    expect(card.text()).toContain('Your configurations use openrouter');
    expect(card.text()).toContain(
      'Add OPENROUTER_API_KEY=… to .env, then run docker compose up -d egress worker',
    );
    expect(card.find('button[aria-label="Copy the command"]').exists()).toBe(true);
    expect(card.text()).not.toContain('Connect');
    expect(w.find('[data-testid="setup-card"]').exists()).toBe(false);
  });

  it('polls every 5 s while an experiment runs', async () => {
    vi.useFakeTimers();
    const w = await mountPage();
    const store = useExperimentsStore();
    const spy = vi.spyOn(store, 'refreshList');
    await vi.advanceTimersByTimeAsync(LIST_POLL_INTERVAL_MS);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LIST_POLL_INTERVAL_MS);
    expect(spy).toHaveBeenCalledTimes(2);
    w.unmount();
  });

  it('does not poll when nothing runs', async () => {
    useScenario('empty');
    vi.useFakeTimers();
    const w = await mountPage();
    const spy = vi.spyOn(useExperimentsStore(), 'refreshList');
    await vi.advanceTimersByTimeAsync(LIST_POLL_INTERVAL_MS * 3);
    expect(spy).not.toHaveBeenCalled();
    w.unmount();
  });
});
