/**
 * "Run a sample experiment" (Phase 8 G4): the launch body built from New experiment's options
 * (SAMPLE_EXPERIMENT through the normal launch), each reason it is disabled with, and the
 * button on the empty Experiments page and the link on New experiment, from fixtures:
 * samples-seeded (a fresh clone after its first start), first-launch (no configurations) and
 * empty (no suite).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import {
  LaunchExperimentInputSchema,
  LaunchExperimentResultSchema,
  NewExperimentOptionsSchema,
  SAMPLE_EXPERIMENT,
  type NewExperimentOptions,
} from '@hermes-evals/shared';
import { ApiError } from '@/api/client';
import * as experimentsApi from '@/api/experiments';
import { EXPERIMENT_IDS, newExperimentOptionsFixture } from '@/fixtures/experiments';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { useProvidersStore } from '@/stores/providers';
import { useSystemStore } from '@/stores/system';
import ExperimentListPage from '@/views/experiments/ExperimentListPage.vue';
import NewExperimentPage from '@/views/experiments/NewExperimentPage.vue';
import { settle as settleRoute } from '@/views/experiments/__tests__/experimentPage';
import type { ProviderSnapshot, WorkerSnapshot } from '../../new-experiment/launchReadiness';
import { SAMPLE_DESCRIPTION, sampleExperimentPlan } from '../sampleExperiment';

const PROVIDERS: ProviderSnapshot = {
  loaded: true,
  providers: [],
  nousStatus: 'connected',
  nousConnected: true,
};
const WORKERS: WorkerSnapshot = { noWorker: false, sandboxProven: true };

/** The fixture options under a scenario, parsed with their contract. */
const optionsFor = (scenario: string): NewExperimentOptions =>
  NewExperimentOptionsSchema.parse(newExperimentOptionsFixture((n) => n === scenario));

describe('sampleExperimentPlan', () => {
  it('launches every valid task of invoices-v1, mock baseline against mock with-skill, twice', () => {
    const options = optionsFor('samples-seeded');
    const plan = sampleExperimentPlan(options, PROVIDERS, WORKERS);
    expect(plan.reason).toBe(null);
    const input = LaunchExperimentInputSchema.parse(plan.input);
    const suite = options.suites[0]!;
    const config = (name: string) => options.configurations.find((c) => c.name === name)!;
    const baseline = config(SAMPLE_EXPERIMENT.baseline);
    const candidate = config(SAMPLE_EXPERIMENT.candidate);
    expect(input).toEqual({
      name: 'Sample: invoices-v1, baseline against with-skill (mock model)',
      description: SAMPLE_DESCRIPTION,
      suiteId: suite.suiteId,
      taskKeys: suite.tasks.filter((t) => t.valid).map((t) => t.key),
      baselineVersionId: baseline.versionId,
      candidateVersionIds: [candidate.versionId],
      repetitions: 2,
      concurrency: 3,
      spendCeilingUsd: null,
      timeBudgetOverrideS: null,
      expectedConfigHashes: {
        [baseline.versionId]: baseline.configHash,
        [candidate.versionId]: candidate.configHash,
      },
    });
    expect(input.taskKeys).toHaveLength(12);
    expect([baseline.mockModel, candidate.mockModel]).toEqual([true, true]);
  });

  it('runs no more at once than the live workers allow', () => {
    const options = { ...optionsFor('samples-seeded'), maxConcurrency: 1 };
    expect(sampleExperimentPlan(options, PROVIDERS, WORKERS).input?.concurrency).toBe(1);
  });

  it('leaves out the tasks that fail their self-check', () => {
    const options = optionsFor('samples-seeded');
    const suite = options.suites[0]!;
    suite.tasks = suite.tasks.map((t) => (t.key === 'late_fees' ? { ...t, valid: false } : t));
    expect(sampleExperimentPlan(options, PROVIDERS, WORKERS).input?.taskKeys).not.toContain(
      'late_fees',
    );
    suite.tasks = suite.tasks.map((t) => ({ ...t, valid: false }));
    expect(sampleExperimentPlan(options, PROVIDERS, WORKERS)).toEqual({
      input: null,
      reason: 'invoices-v1 has no valid task: every task fails its self-check.',
      fix: 'suites',
    });
  });

  it('says which seeded configuration is missing', () => {
    expect(sampleExperimentPlan(optionsFor('first-launch'), PROVIDERS, WORKERS)).toEqual({
      input: null,
      reason:
        'The sample configurations invoices-v1-baseline-mock and invoices-v1-with-skill-mock do not exist. The API creates them when it starts, unless SEED_SAMPLES is off; System shows what it did.',
      fix: 'system',
    });
    const options = optionsFor('samples-seeded');
    options.configurations = options.configurations.filter(
      (c) => c.name !== SAMPLE_EXPERIMENT.candidate,
    );
    expect(sampleExperimentPlan(options, PROVIDERS, WORKERS).reason).toBe(
      'The sample configuration invoices-v1-with-skill-mock does not exist. The API creates them when it starts, unless SEED_SAMPLES is off; System shows what it did.',
    );
  });

  it('says when the suite is not loaded, or nothing has loaded yet', () => {
    expect(sampleExperimentPlan(optionsFor('empty'), PROVIDERS, WORKERS)).toEqual({
      input: null,
      reason:
        'The sample suite invoices-v1 is not loaded. It is read from ./suites; Reload on Suites reads it again.',
      fix: 'suites',
    });
    expect(sampleExperimentPlan(null, PROVIDERS, WORKERS).reason).toBe(
      'Loading the suites and configurations.',
    );
  });

  it('is blocked by what blocks any launch: the worker, the sandbox', () => {
    const options = optionsFor('samples-seeded');
    expect(
      sampleExperimentPlan(options, PROVIDERS, { noWorker: true, sandboxProven: true }),
    ).toEqual({ input: null, reason: "Can't launch yet: no worker is connected.", fix: 'system' });
    expect(
      sampleExperimentPlan(options, PROVIDERS, { noWorker: false, sandboxProven: false }).reason,
    ).toBe("Can't launch yet: the sandbox self-test has not passed.");
    // The mock arms need no provider login: Nous being down does not block them.
    const nousDown = { ...PROVIDERS, nousStatus: 'not_connected' as const, nousConnected: false };
    expect(sampleExperimentPlan(options, nousDown, WORKERS).reason).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// On the pages
// ---------------------------------------------------------------------------

let router: Router;
const mounted: VueWrapper[] = [];

async function mountOn(page: 'list' | 'new'): Promise<VueWrapper> {
  const pinia = createPinia();
  setActivePinia(pinia);
  router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(page === 'list' ? '/experiments' : '/experiments/new');
  await Promise.all([useProvidersStore(pinia).load(), useSystemStore(pinia).load()]);
  const w = mount(page === 'list' ? ExperimentListPage : NewExperimentPage, {
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  });
  mounted.push(w);
  await flushPromises();
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
  return w;
}

const sample = (w: VueWrapper) => w.get('[data-testid="sample-experiment"]');
const runButton = (w: VueWrapper) => w.get('[data-testid="sample-experiment-run"]');
const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Every text node, trimmed and joined by single spaces: block elements read apart. */
function spaced(node: { element: Element }): string {
  const walker = document.createTreeWalker(node.element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent?.trim();
    if (text) parts.push(text);
  }
  return flat(parts.join(' '));
}

beforeEach(() => {
  useScenario(null);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  for (const w of mounted.splice(0)) w.unmount();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('the empty Experiments page', () => {
  it('samples-seeded: launches the sample through the normal launch and opens it', async () => {
    useScenario('samples-seeded');
    const launch = vi.spyOn(experimentsApi, 'launchExperiment');
    const w = await mountOn('list');
    expect(w.text()).toContain('No experiments yet');
    expect(sample(w).attributes('data-state')).toBe('ready');
    expect(spaced(sample(w))).toBe(
      'Run a sample experiment invoices-v1, its baseline against its with-skill arm on the scripted mock model: every valid task, 2 repetitions.',
    );
    expect(w.text()).toContain('1 suite loaded · 2 configurations');
    await runButton(w).trigger('click');
    await settleRoute();
    expect(launch).toHaveBeenCalledTimes(1);
    const input = LaunchExperimentInputSchema.parse(launch.mock.calls[0]![0]);
    expect(input.name).toBe(SAMPLE_EXPERIMENT.name);
    expect(input.repetitions).toBe(2);
    const answer = LaunchExperimentResultSchema.parse(await launch.mock.results[0]!.value);
    // Both arms are the mock model: the launch has nothing to warn about.
    expect(answer).toEqual({ id: EXPERIMENT_IDS.mcpVsBaseline, warnings: [] });
    expect(router.currentRoute.value.fullPath).toBe(`/experiments/${answer.id}`);
  });

  it('launches once while the launch is pending: the button disabled and busy until it opens', async () => {
    // Pins the double-click guard as a whole, the button's disabled binding and run()'s busy
    // check together, not run()'s check alone: a second click would launch the sample twice
    // (2 x N more mock runs, and a second experiment in the list).
    useScenario('samples-seeded');
    const launch = vi
      .spyOn(experimentsApi, 'launchExperiment')
      .mockReturnValue(new Promise<never>(() => {}));
    const w = await mountOn('list');
    await runButton(w).trigger('click');
    await runButton(w).trigger('click');
    await flushPromises();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(runButton(w).attributes('disabled')).toBeDefined();
    expect(runButton(w).attributes('aria-busy')).toBe('true');
    expect(runButton(w).text()).toBe('Launching…');
    expect(router.currentRoute.value.fullPath).toBe('/experiments');
  });

  it('first-launch: disabled, with the missing configurations and a link to System', async () => {
    useScenario('first-launch');
    const w = await mountOn('list');
    expect(sample(w).attributes('data-state')).toBe('blocked');
    expect(runButton(w).attributes('disabled')).toBeDefined();
    const reason = w.get('[data-testid="sample-experiment-reason"]');
    expect(runButton(w).attributes('aria-describedby')).toBe(reason.attributes('id'));
    expect(flat(reason.text())).toBe(
      'The sample configurations invoices-v1-baseline-mock and invoices-v1-with-skill-mock do not exist. The API creates them when it starts, unless SEED_SAMPLES is off; System shows what it did. Open System',
    );
    expect(reason.get('a').attributes('href')).toBe('/system');
  });

  it('empty: disabled until invoices-v1 is loaded, with a link to Suites', async () => {
    useScenario('empty');
    const w = await mountOn('list');
    const reason = w.get('[data-testid="sample-experiment-reason"]');
    expect(reason.text()).toContain('The sample suite invoices-v1 is not loaded.');
    expect(reason.get('a').attributes('href')).toBe('/suites');
  });

  it('with no model connected, the setup card offers it too', async () => {
    useScenario('empty,nous-not-connected');
    const w = await mountOn('list');
    expect(
      w.get('[data-testid="setup-empty"]').find('[data-testid="sample-experiment"]').exists(),
    ).toBe(true);
  });

  it('a refused launch says why, keeps the button, and reads the options again', async () => {
    useScenario('samples-seeded');
    vi.spyOn(experimentsApi, 'launchExperiment').mockRejectedValue(
      new ApiError(409, 'POST /api/experiments', 'no live worker with a proven sandbox'),
    );
    const w = await mountOn('list');
    const options = vi.spyOn(experimentsApi, 'getNewExperimentOptions');
    await runButton(w).trigger('click');
    await flushPromises();
    const failure = w.get('[data-testid="sample-experiment-failure"]');
    expect(failure.attributes('role')).toBe('alert');
    expect(spaced(failure)).toBe(
      'Launch refused POST /api/experiments → 409 · no live worker with a proven sandbox',
    );
    expect(options).toHaveBeenCalled();
    expect(runButton(w).attributes('disabled')).toBeUndefined();
    expect(router.currentRoute.value.fullPath).toBe('/experiments');
  });
});

describe('New experiment', () => {
  it('samples-seeded: offers the sample under the title, and launches it', async () => {
    useScenario('samples-seeded');
    const launch = vi.spyOn(experimentsApi, 'launchExperiment');
    const w = await mountOn('new');
    expect(flat(sample(w).text())).toBe(
      'New here? Run a sample experiment: invoices-v1, its baseline against its with-skill arm on the scripted mock model: every valid task, 2 repetitions.',
    );
    await runButton(w).trigger('click');
    await settleRoute();
    expect(
      LaunchExperimentInputSchema.parse(launch.mock.calls[0]![0]).candidateVersionIds,
    ).toHaveLength(1);
    expect(router.currentRoute.value.name).toBe('experiment-overview');
  });

  it('without the seeded configurations: the link is disabled with the reason', async () => {
    const w = await mountOn('new');
    expect(runButton(w).attributes('disabled')).toBeDefined();
    expect(flat(sample(w).text())).toBe(
      'New here? Run a sample experiment. The sample configurations invoices-v1-baseline-mock and invoices-v1-with-skill-mock do not exist. The API creates them when it starts, unless SEED_SAMPLES is off; System shows what it did. Open System',
    );
  });
});
