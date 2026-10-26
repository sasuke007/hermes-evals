/**
 * New experiment and MCP variables that are not set (Phase 5 decision #13, Phase 6 S7), from
 * the fixtures: under `secret-not-set` with-mcp's invoice-db needs INVOICE_DB_URL, which the
 * worker lacks. Its row names the variable and the server, Launch is disabled with the
 * reason, Check again reloads the configurations, and a launch the API refuses for it reloads
 * them too. Also the Skills column's "on demand" (`skills-on-demand`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { missingSecretsConflictMessage, type NewExperimentOptions } from '@hermes-evals/shared';
import { ApiError } from '@/api/client';
import * as experimentsApi from '@/api/experiments';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { useProvidersStore } from '@/stores/providers';
import { useSystemStore } from '@/stores/system';
import NewExperimentPage from '@/views/experiments/NewExperimentPage.vue';

async function mountPage(): Promise<VueWrapper> {
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/experiments/new');
  await Promise.all([useProvidersStore().load(), useSystemStore().load()]);
  const w = mount(NewExperimentPage, {
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  });
  await settle();
  return w;
}

/** Past the estimate's 250 ms debounce, and every fixture answer. */
async function settle(): Promise<void> {
  await flushPromises();
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
}

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
const configRow = (w: VueWrapper, name: string) => w.get(`tr[data-config="${name}"]`);
const launch = (w: VueWrapper) => w.get('[data-testid="launch"]');

async function choose(w: VueWrapper, candidate: string): Promise<void> {
  await w.get('#ne-name').setValue('MCP vs baseline');
  await configRow(w, 'baseline').get('input[type="checkbox"]').setValue(true);
  await configRow(w, candidate).get('input[type="checkbox"]').setValue(true);
  await configRow(w, 'baseline').get('input[type="radio"]').trigger('change');
  await settle();
}

const REASON = 'with-mcp: INVOICE_DB_URL (invoice-db, read by the worker) is not set.';

beforeEach(() => {
  useScenario(null);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('a configuration whose MCP variables are not set (secret-not-set)', () => {
  it('names each variable and its server on the row', async () => {
    useScenario('secret-not-set');
    const w = await mountPage();
    const tag = configRow(w, 'with-mcp').get('[data-testid="secret-tag"]');
    expect(flat(tag.text())).toBe('INVOICE_DB_URL not set · invoice-db');
    expect(tag.attributes('title')).toBe(
      'INVOICE_DB_URL (invoice-db, read by the worker) is not set',
    );
    expect(configRow(w, 'baseline').find('[data-testid="secret-tag"]').exists()).toBe(false);
    expect(configRow(w, 'with-skill').find('[data-testid="secret-tag"]').exists()).toBe(false);
  });

  it('disables Launch with the reason and shows how to fix it', async () => {
    useScenario('secret-not-set');
    const w = await mountPage();
    await choose(w, 'with-mcp');
    expect(launch(w).attributes('disabled')).toBeDefined();
    expect(launch(w).attributes('title')).toBe(REASON);
    expect(flat(w.get('[data-testid="blocked-reason"]').text())).toBe(`${REASON} Open Secrets`);
    expect(w.get('[data-testid="blocked-reason"] a').attributes('href')).toBe('/resources/secrets');
    const block = w.get('[data-testid="launch-blocker"][data-fix="secrets"]');
    expect(flat(block.text())).toContain(REASON);
    expect(block.text()).toContain(
      'Set each in .env, then recreate the worker (stdio) or egress (http) so it reads them.',
    );
    expect(block.text()).toContain('docker compose up -d worker');
    expect(block.get('a').attributes('href')).toBe('/resources/secrets');
  });

  it('Check again reloads the configurations, and Launch enables once the variable is set', async () => {
    useScenario('secret-not-set');
    const w = await mountPage();
    await choose(w, 'with-mcp');
    const real = experimentsApi.getNewExperimentOptions;
    const options = vi
      .spyOn(experimentsApi, 'getNewExperimentOptions')
      .mockImplementation(async (): Promise<NewExperimentOptions> => {
        const o = await real();
        return {
          ...o,
          configurations: o.configurations.map((c) => ({ ...c, missingSecrets: [] })),
        };
      });
    await w.get('[data-testid="recheck-secrets"]').trigger('click');
    await settle();
    expect(options).toHaveBeenCalledTimes(1);
    expect(w.find('[data-testid="launch-blocker"]').exists()).toBe(false);
    expect(configRow(w, 'with-mcp').find('[data-testid="secret-tag"]').exists()).toBe(false);
    expect(launch(w).attributes('disabled')).toBeUndefined();
  });

  it('does not block a choice without that server', async () => {
    useScenario('secret-not-set');
    const w = await mountPage();
    await choose(w, 'with-skill');
    expect(w.find('[data-testid="launch-blocker"]').exists()).toBe(false);
    expect(launch(w).attributes('disabled')).toBeUndefined();
  });

  it('leaves the variables to the no-worker block while no worker is live', async () => {
    useScenario('secret-not-set,no-worker');
    const w = await mountPage();
    await choose(w, 'with-mcp');
    expect(w.find('[data-testid="secret-tag"]').exists()).toBe(false);
    const blocks = w.findAll('[data-testid="launch-blocker"]');
    expect(blocks.map((b) => b.attributes('data-fix'))).toEqual(['command']);
  });
});

describe('a launch the API refuses for unset variables', () => {
  const dbUrl = { server: 'invoice-db', name: 'INVOICE_DB_URL', transport: 'stdio' as const };
  const message = missingSecretsConflictMessage([{ configuration: 'with-mcp', missing: [dbUrl] }]);

  async function refuse(reloadNames: boolean): Promise<{ w: VueWrapper; reloads: number }> {
    const w = await mountPage();
    await choose(w, 'with-mcp');
    vi.spyOn(experimentsApi, 'launchExperiment').mockRejectedValue(
      new ApiError(409, 'POST /api/experiments', message),
    );
    const real = experimentsApi.getNewExperimentOptions;
    const options = vi
      .spyOn(experimentsApi, 'getNewExperimentOptions')
      .mockImplementation(async (): Promise<NewExperimentOptions> => {
        const o = await real();
        if (!reloadNames) return o;
        return {
          ...o,
          configurations: o.configurations.map((c) =>
            c.name === 'with-mcp' ? { ...c, missingSecrets: [dbUrl] } : c,
          ),
        };
      });
    await launch(w).trigger('click');
    await settle();
    return { w, reloads: options.mock.calls.length };
  }

  it('shows the refusal and reloads the configurations', async () => {
    const { w, reloads } = await refuse(false);
    expect(reloads).toBe(1);
    const failure = w.get('[data-testid="launch-failure"]');
    expect(failure.attributes('data-kind')).toBe('secrets');
    expect(failure.text()).toContain("Launch refused: an MCP server's variables are not set.");
    expect(failure.text()).toContain(`POST /api/experiments → 409 · ${message}`);
  });

  it('once the reloaded configurations name the variable, their block replaces the refusal', async () => {
    const { w } = await refuse(true);
    expect(w.find('[data-testid="launch-failure"]').exists()).toBe(false);
    expect(w.get('[data-testid="launch-blocker"]').attributes('data-fix')).toBe('secrets');
    expect(launch(w).attributes('title')).toBe(REASON);
  });

  it('the fixtures refuse the same way when the page is bypassed', async () => {
    useScenario('secret-not-set');
    const options = await experimentsApi.getNewExperimentOptions();
    const id = (name: string) => options.configurations.find((c) => c.name === name)!.versionId;
    const refused = experimentsApi.launchExperiment({
      name: 'x',
      description: '',
      suiteId: options.suites[0]!.suiteId,
      taskKeys: ['total_due', 'per_vendor', 'dup_invoices'],
      baselineVersionId: id('baseline'),
      candidateVersionIds: [id('with-mcp')],
      expectedConfigHashes: {},
      repetitions: 1,
      concurrency: 1,
      spendCeilingUsd: null,
      timeBudgetOverrideS: null,
    });
    await expect(refused).rejects.toMatchObject({ status: 409, detail: message });
  });
});

describe('skills loaded on demand (skills-on-demand)', () => {
  it('reads "1 · on demand" in the Skills column', async () => {
    useScenario('skills-on-demand');
    const w = await mountPage();
    const cells = configRow(w, 'with-skill').findAll('td');
    expect(flat(cells[4]!.text())).toBe('1 · on demand');
    expect(configRow(w, 'baseline').find('[data-testid="on-demand"]').exists()).toBe(false);
  });
});
