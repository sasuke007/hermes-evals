/**
 * The mock judge's warning (Phase 8 G2), from fixtures: under `judge-mock` the platform judge
 * is the scripted mock model, so New experiment warns, without blocking, once a chosen
 * configuration runs a real model and a selected task has an llm_judge check (credit_notes and
 * disputed do); the launch answer carries the same warning, which the Overview shows until
 * dismissed. With a real judge, or only mock models, nothing is said. A real model on either
 * side counts, the baseline as much as a candidate. Under `judge-mock-name` the judge's model
 * is the mock's name on an endpoint that is not the mock, so any selected llm_judge check
 * warns, whatever the configurations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import {
  LaunchExperimentResultSchema,
  MOCK_JUDGE_WARNING,
  MOCK_MODEL_NAME_JUDGE_WARNING,
  type NewExperimentOptions,
} from '@hermes-evals/shared';
import * as experimentsApi from '@/api/experiments';
import { EXPERIMENT_IDS } from '@/fixtures/experiments';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { useExperimentsStore } from '@/stores/experiments';
import { useProvidersStore } from '@/stores/providers';
import { useSystemStore } from '@/stores/system';
import NewExperimentPage from '@/views/experiments/NewExperimentPage.vue';
import {
  mountExperimentRoute,
  settle as settleRoute,
} from '@/views/experiments/__tests__/experimentPage';

let router: Router;
let pinia: Pinia;
const mounted: VueWrapper[] = [];

async function mountPage(): Promise<VueWrapper> {
  pinia = createPinia();
  setActivePinia(pinia);
  router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/experiments/new');
  await Promise.all([useProvidersStore().load(), useSystemStore().load()]);
  const w = mount(NewExperimentPage, {
    global: { plugins: [pinia, router] },
    attachTo: document.body,
  });
  mounted.push(w);
  await settle();
  return w;
}

async function settle(): Promise<void> {
  await flushPromises();
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
}

const configRow = (w: VueWrapper, name: string) => w.get(`tr[data-config="${name}"]`);
const warning = (w: VueWrapper) => w.find('[data-testid="judge-warning"]');
const launch = (w: VueWrapper) => w.get('[data-testid="launch"]');

async function choose(w: VueWrapper, baseline: string, candidate: string): Promise<void> {
  await w.get('#ne-name').setValue('Skill vs no skill');
  await configRow(w, baseline).get('input[type="checkbox"]').setValue(true);
  await configRow(w, candidate).get('input[type="checkbox"]').setValue(true);
  await configRow(w, baseline).get('input[type="radio"]').trigger('change');
  await settle();
}

/** The fixture options with these configurations on the mock model (no fixture mixes them). */
function onTheMock(...names: string[]) {
  const real = experimentsApi.getNewExperimentOptions;
  vi.spyOn(experimentsApi, 'getNewExperimentOptions').mockImplementation(
    async (): Promise<NewExperimentOptions> => {
      const o = await real();
      return {
        ...o,
        configurations: o.configurations.map((c) =>
          names.includes(c.name) ? { ...c, mockModel: true } : c,
        ),
      };
    },
  );
}

async function untick(w: VueWrapper, task: string): Promise<void> {
  await w.get(`tr[data-task="${task}"] input[type="checkbox"]`).setValue(false);
  await settle();
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

describe('New experiment with the mock model as judge (judge-mock)', () => {
  it('warns once a real model meets a selected llm_judge check, and never blocks', async () => {
    useScenario('judge-mock');
    const w = await mountPage();
    expect(warning(w).exists()).toBe(false);
    await choose(w, 'baseline', 'with-skill');
    expect(warning(w).attributes('role')).toBe('status');
    expect(warning(w).text()).toBe(MOCK_JUDGE_WARNING);
    expect(warning(w).text()).toBe(
      'The LLM judge is the mock model, so llm_judge checks will not mean anything on a real model. Set JUDGE_PROVIDER and JUDGE_MODEL in .env.',
    );
    expect(launch(w).attributes('disabled')).toBeUndefined();
    expect(launch(w).text()).toBe('Launch 120 runs');
  });

  it('goes away when no selected task has an llm_judge check', async () => {
    useScenario('judge-mock');
    const w = await mountPage();
    await choose(w, 'baseline', 'with-skill');
    await untick(w, 'credit_notes');
    expect(warning(w).exists()).toBe(true);
    await untick(w, 'disputed');
    expect(warning(w).exists()).toBe(false);
  });

  it('the launch answer carries it to the Overview, until dismissed', async () => {
    const sent = vi.spyOn(experimentsApi, 'launchExperiment');
    const page = await mountExperimentRoute('/experiments/new', 'judge-mock');
    mounted.push(page.wrapper);
    const w = page.wrapper;
    await settle();
    await choose(w, 'baseline', 'with-skill');
    await launch(w).trigger('click');
    await settle();
    await settleRoute();
    const answer = LaunchExperimentResultSchema.parse(await sent.mock.results[0]!.value);
    expect(answer).toEqual({ id: EXPERIMENT_IDS.mcpVsBaseline, warnings: [MOCK_JUDGE_WARNING] });
    expect(page.router.currentRoute.value.fullPath).toBe(`/experiments/${answer.id}`);
    const banner = w.get('[data-testid="launch-warnings"]');
    expect(banner.attributes('data-tone')).toBe('warning');
    expect(banner.text()).toContain('Launched with a warning');
    expect(banner.text()).toContain(MOCK_JUDGE_WARNING);
    await banner.get('button').trigger('click');
    expect(w.find('[data-testid="launch-warnings"]').exists()).toBe(false);
    expect(useExperimentsStore(page.pinia).launchWarnings[answer.id]).toBeUndefined();
  });
});

describe('a real model on one side only (judge-mock)', () => {
  it('warns for a real baseline against a mock candidate', async () => {
    useScenario('judge-mock');
    onTheMock('with-skill');
    const w = await mountPage();
    await choose(w, 'baseline', 'with-skill');
    expect(warning(w).text()).toBe(MOCK_JUDGE_WARNING);
    expect(launch(w).attributes('disabled')).toBeUndefined();
  });

  it('warns for a mock baseline against a real candidate', async () => {
    useScenario('judge-mock');
    onTheMock('baseline');
    const w = await mountPage();
    await choose(w, 'baseline', 'with-skill');
    expect(warning(w).text()).toBe(MOCK_JUDGE_WARNING);
  });
});

describe("the mock model's name on another endpoint (judge-mock-name)", () => {
  it('warns on a selected llm_judge check, even when every configuration runs the mock', async () => {
    useScenario('judge-mock-name');
    onTheMock('baseline', 'with-skill');
    const w = await mountPage();
    await choose(w, 'baseline', 'with-skill');
    expect(warning(w).text()).toBe(MOCK_MODEL_NAME_JUDGE_WARNING);
    expect(launch(w).attributes('disabled')).toBeUndefined();
    await untick(w, 'credit_notes');
    await untick(w, 'disputed');
    expect(warning(w).exists()).toBe(false);
  });

  it('the launch answer carries it', async () => {
    useScenario('judge-mock-name');
    const sent = vi.spyOn(experimentsApi, 'launchExperiment');
    const w = await mountPage();
    await choose(w, 'baseline', 'with-skill');
    await launch(w).trigger('click');
    await settle();
    expect(LaunchExperimentResultSchema.parse(await sent.mock.results[0]!.value).warnings).toEqual([
      MOCK_MODEL_NAME_JUDGE_WARNING,
    ]);
  });
});

describe('no warning', () => {
  it('with a real judge (the default fixtures)', async () => {
    const sent = vi.spyOn(experimentsApi, 'launchExperiment');
    const w = await mountPage();
    await choose(w, 'baseline', 'with-skill');
    expect(warning(w).exists()).toBe(false);
    await launch(w).trigger('click');
    await settle();
    expect(LaunchExperimentResultSchema.parse(await sent.mock.results[0]!.value).warnings).toEqual(
      [],
    );
    expect(useExperimentsStore(pinia).launchWarnings).toEqual({});
  });

  it('when every chosen configuration runs the mock model (samples-seeded)', async () => {
    useScenario('samples-seeded');
    const w = await mountPage();
    await choose(w, 'invoices-v1-baseline-mock', 'invoices-v1-with-skill-mock');
    expect(warning(w).exists()).toBe(false);
  });
});
