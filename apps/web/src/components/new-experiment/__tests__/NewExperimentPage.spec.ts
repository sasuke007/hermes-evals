/**
 * New experiment in each designed state (NewExperiment, NewExperimentStates and the New
 * experiment frames of ExperimentStates), from fixtures: filling the form and launching,
 * Launch's reasons in order, the invalid task row, Duplicate (now invalid, changed since),
 * the provider and worker blockers, each refused launch, and the first-load states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import * as experimentsApi from '@/api/experiments';
import { EXPERIMENT_IDS, newExperimentOptionsFixture } from '@/fixtures/experiments';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { useExperimentsStore } from '@/stores/experiments';
import { useProvidersStore } from '@/stores/providers';
import { useSystemStore } from '@/stores/system';
import NewExperimentPage from '@/views/experiments/NewExperimentPage.vue';

let router: Router;

async function mountPage(
  duplicateOf?: string,
  repetitions?: number,
  suite?: string,
): Promise<VueWrapper> {
  const pinia = createPinia();
  setActivePinia(pinia);
  router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(duplicateOf ? `/experiments/new?from=${duplicateOf}` : '/experiments/new');
  const pending = new URLSearchParams(window.location.search).get('scenario') === 'loading';
  const ready = Promise.all([useProvidersStore().load(), useSystemStore().load()]);
  if (!pending) await ready;
  const w = mount(NewExperimentPage, {
    props: { duplicateOf, repetitions, suite },
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

const summary = (w: VueWrapper) => w.get('[data-testid="summary-panel"]');
const reason = (w: VueWrapper) => w.get('[data-testid="launch-reason"]').text();
const configRow = (w: VueWrapper, name: string) => w.get(`tr[data-config="${name}"]`);
const taskRow = (w: VueWrapper, key: string) => w.get(`tr[data-task="${key}"]`);

async function fillSample(w: VueWrapper, name = 'Skill vs no skill, invoices-v1') {
  await w.get('#ne-name').setValue(name);
  await configRow(w, 'baseline').get('input[type="checkbox"]').setValue(true);
  await configRow(w, 'with-skill').get('input[type="checkbox"]').setValue(true);
  await configRow(w, 'baseline').get('input[type="radio"]').trigger('change');
  await settle();
}

beforeEach(() => {
  useScenario(null);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('NewExperimentPage', () => {
  it('opens on the first suite with every valid task, nothing chosen yet', async () => {
    const w = await mountPage();
    expect(w.get('h1').text()).toBe('New experiment');
    expect(w.findAll('h2').map((h) => h.text())).toEqual([
      '1Name and description',
      '2Suite and tasks',
      '3ConfigurationsPick two or more. Mark one as the baseline; the others are candidates.',
      '4Repetitions',
      '5Limits',
    ]);
    expect(w.get('#ne-suite option').text()).toBe('invoices-v1 · v1 (12 tasks, 12 valid)');
    expect(w.get('[data-testid="suite-help"]').text()).toBe(
      'Loaded from ./suites/invoices-v1 · v1 3f9c2a1 · self-check 23 Oct 09:12',
    );
    expect(w.get('[data-testid="task-checklist"]').text()).toContain('12 of 12 tasks selected');
    expect(w.findAll('tr[data-config]').map((r) => r.attributes('data-role'))).toEqual([
      'not included',
      'not included',
      'not included',
    ]);
    expect(w.get('#ne-reps').element).toHaveProperty('value', '5');
    expect(w.get('#ne-conc').element).toHaveProperty('value', '3');
    expect(summary(w).get('[data-testid="summary-runs"]').text()).toBe('—');
    expect(reason(w)).toBe('Give the experiment a name.');
  });

  it('gives the first unmet requirement as Launch’s reason, in order', async () => {
    const w = await mountPage();
    await w.get('#ne-name').setValue('Try');
    expect(reason(w)).toBe('Pick at least two configurations.');
    await configRow(w, 'baseline').get('input[type="checkbox"]').setValue(true);
    await configRow(w, 'with-skill').get('input[type="checkbox"]').setValue(true);
    expect(reason(w)).toBe('Mark one of the chosen configurations as the baseline.');
    await w.get('[data-testid="task-checklist"] input').setValue(false);
    expect(reason(w)).toBe('Select at least one task.');
  });

  it('sizes, prices and compares the sample experiment, then launches it', async () => {
    const w = await mountPage();
    await fillSample(w);
    expect(configRow(w, 'baseline').get('[data-testid="role"]').text()).toBe('baseline');
    expect(configRow(w, 'with-skill').get('[data-testid="role"]').text()).toBe('candidate');
    expect(w.get('[data-testid="diff-line"]').text()).toBe('1 field differs: skills');
    expect(w.text()).toContain('This experiment is controlled: one variable changes.');
    expect(summary(w).get('[data-testid="summary-runs"]').text()).toBe('120');
    expect(summary(w).get('[data-testid="summary-duration"]').text()).toBe('≈ 36 min');
    expect(summary(w).get('[data-testid="summary-cost"]').text()).toBe('≈ $1.69');
    const launch = summary(w).get('[data-testid="launch"]');
    expect(launch.text()).toBe('Launch 120 runs');
    // The Overview itself is another page's; only where Launch goes is checked here.
    const push = vi.spyOn(router, 'push').mockResolvedValue(undefined);
    await launch.trigger('click');
    await settle();
    expect(push).toHaveBeenCalledWith({
      name: 'experiment-overview',
      params: { id: EXPERIMENT_IDS.mcpVsBaseline },
    });
  });

  it('launches once: the form stays locked until the Overview shows', async () => {
    const w = await mountPage();
    await fillSample(w);
    const store = useExperimentsStore();
    const post = vi.spyOn(store, 'launch');
    // The Overview's page is still loading.
    const push = vi.spyOn(router, 'push').mockReturnValue(new Promise(() => {}));
    await summary(w).get('[data-testid="launch"]').trigger('click');
    await settle();
    expect(post).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledTimes(1);
    expect(store.launching).toBe(false);
    expect(w.get('fieldset').attributes('disabled')).toBeDefined();
    await summary(w).get('[data-testid="launch"]').trigger('click');
    await w.get('form').trigger('submit');
    await settle();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('sends the per-run budget override to the estimate', async () => {
    const w = await mountPage();
    const spy = vi.spyOn(useExperimentsStore(), 'refreshEstimate');
    await fillSample(w);
    await w.get('#ne-budget').setValue('120');
    await settle();
    expect(spy).toHaveBeenLastCalledWith(
      expect.objectContaining({ taskCount: 12, repetitions: 5, concurrency: 3, budgetS: 120 }),
    );
    expect(w.text()).toContain(
      "Optional. Replaces each configuration's own budget in every run, so every configuration gets the same. Tasks in invoices-v1 declare 300 s.",
    );
  });

  it('checks the limits as the API would', async () => {
    const w = await mountPage();
    await fillSample(w);
    await w.get('#ne-ceil').setValue('abc');
    expect(w.text()).toContain('Enter an amount in dollars, such as 2.00.');
    expect(reason(w)).toBe('Spend ceiling: Enter an amount in dollars, such as 2.00.');
    await w.get('#ne-ceil').setValue('2');
    await w.get('#ne-budget').setValue('10');
    expect(reason(w)).toBe('Per-run time budget: the time budget override is 30 to 3600 seconds');
    await w.get('#ne-budget').setValue('');
    expect(w.text()).toContain('the worker count (4)');
    const more = w.get('button[aria-label="Higher concurrency"]');
    (more.element as HTMLElement).focus();
    await more.trigger('click');
    expect(w.get('#ne-conc').element).toHaveProperty('value', '4');
    // At the maximum it is aria-disabled, so it keeps focus, and a click does nothing.
    expect(more.attributes('aria-disabled')).toBe('true');
    expect(more.attributes('disabled')).toBeUndefined();
    expect(document.activeElement).toBe(more.element);
    await more.trigger('click');
    expect(w.get('#ne-conc').element).toHaveProperty('value', '4');
  });

  it('warns at one repetition and with fewer than three tasks', async () => {
    const w = await mountPage();
    await fillSample(w);
    for (let i = 0; i < 4; i++)
      await w.get('button[aria-label="Fewer repetitions"]').trigger('click');
    expect(w.get('[data-testid="single-rep-warning"]').text()).toContain(
      'A single repetition cannot produce a confidence interval.',
    );
    expect(summary(w).get('[data-testid="summary-runs"]').text()).toBe('24');
    await w.get('[data-testid="task-checklist"] input').setValue(false);
    await taskRow(w, 'total_due').get('input').setValue(true);
    await taskRow(w, 'vat_split').get('input').setValue(true);
    expect(w.get('[data-testid="task-checklist"]').text()).toContain('2 of 12 tasks selected');
    const warning = w.get('[data-testid="few-tasks-warning"]');
    expect(warning.text().replace(/\s+/g, ' ')).toContain(
      'An experiment on fewer than 3 tasks cannot reach a verdict.',
    );
    // A warning, not a block: Launch stays available.
    expect(warning.attributes('role')).toBe('status');
    expect(w.get('[data-testid="launch"]').attributes('disabled')).toBeUndefined();
  });

  it('shows the name error once the field is left empty', async () => {
    const w = await mountPage();
    expect(w.text()).not.toContain('Name is required.');
    await w.get('#ne-name').trigger('blur');
    expect(w.text()).toContain('Name is required.');
    expect(w.get('#ne-name').attributes('aria-invalid')).toBe('true');
  });

  it('lists an invalid task but cannot select it, and says why', async () => {
    useScenario('invalid-task');
    const w = await mountPage();
    expect(w.get('#ne-suite option').text()).toBe('invoices-v1 · v2 (12 tasks, 11 valid)');
    const row = taskRow(w, 'late_fees');
    const box = row.get('input');
    expect(box.attributes('disabled')).toBeDefined();
    expect(box.attributes('aria-label')).toBe('late_fees cannot be selected');
    const caption = row.get('[data-testid="invalid-caption"]');
    expect(box.attributes('aria-describedby')).toBe(caption.attributes('id'));
    expect(caption.text()).toContain('printed no result line on the reference answer');
    const card = row.get('[role="tooltip"]');
    expect(card.text()).toContain('late_fees cannot be selected');
    expect(card.get('a').text()).toBe('See the self-check output');
    expect(row.text()).toContain('self-check failed');
    expect(w.get('[data-testid="task-checklist"]').text()).toContain('11 of 12 tasks selected');
    await fillSample(w);
    expect(summary(w).get('[data-testid="summary-runs"]').text()).toBe('110');
  });

  it('duplicates onto the current suite version, leaving out a task now invalid', async () => {
    useScenario('invalid-task');
    const w = await mountPage(EXPERIMENT_IDS.skillVsNoSkill);
    const notice = w.get('[data-testid="duplicate-notice"]');
    expect(notice.text()).toContain(
      'Duplicated from Skill vs no skill, invoices-v1 (suite v1). Now using v2.',
    );
    expect(notice.get('a').attributes('href')).toBe(
      `/experiments/${EXPERIMENT_IDS.skillVsNoSkill}`,
    );
    expect(notice.get('[data-testid="left-out"]').text()).toBe(
      'late_fees: now invalid (self-check failed)',
    );
    expect(w.get('#ne-name').element).toHaveProperty(
      'value',
      'Skill vs no skill, invoices-v1 (v2)',
    );
    expect(configRow(w, 'baseline').attributes('data-role')).toBe('baseline');
    expect(configRow(w, 'with-skill').attributes('data-role')).toBe('candidate');
    expect(summary(w).get('[data-testid="summary-runs"]').text()).toBe('110');
    expect(reason(w)).toBe('Starts immediately. You can pause or cancel from the Overview.');
  });

  it('duplicates with the repetitions the link asks for (Duplicate with 5 repetitions)', async () => {
    const w = await mountPage(EXPERIMENT_IDS.quickCheck, 5);
    expect(w.get('#ne-reps').element).toHaveProperty('value', '5');
    expect(w.find('[data-testid="single-rep-warning"]').exists()).toBe(false);
  });

  it('starts on the suite version the link names (New experiment on v7)', async () => {
    const options = newExperimentOptionsFixture(() => false);
    const first = options.suites[0]!;
    const saved = {
      ...first,
      suiteId: 'suite_01JBNEWSAVED',
      name: 'zz-smoke-new',
      versionNumber: 1,
      path: './suites/zz-smoke-new',
      tasks: first.tasks.slice(0, 2),
      taskCount: 2,
      validCount: 2,
    };
    const twoSuites = { ...options, suites: [first, saved] };
    vi.spyOn(experimentsApi, 'getNewExperimentOptions').mockResolvedValue(twoSuites);
    const w = await mountPage(undefined, undefined, saved.suiteId);
    expect(w.get('#ne-suite').element).toHaveProperty('value', saved.suiteId);
    expect(w.get('[data-testid="task-checklist"]').text()).toContain('2 of 2 tasks selected');

    // A suite the options do not list (a stale link) leaves the first suite chosen.
    w.unmount();
    const stale = await mountPage(undefined, undefined, 'suite_gone');
    expect(stale.get('#ne-suite').element).toHaveProperty('value', first.suiteId);
  });

  it('marks the tasks that changed since the original', async () => {
    useScenario('newer-version');
    const w = await mountPage(EXPERIMENT_IDS.skillVsNoSkill);
    expect(w.get('[data-testid="duplicate-notice"]').text()).toContain(
      'Changed since then: total_due. Results on changed tasks are not comparable with the original.',
    );
    const tag = taskRow(w, 'total_due').get('[data-testid="changed-tag"]');
    expect(tag.text()).toBe('v2 · changed since v1');
    expect(tag.attributes('title')).toBe("Changed since the original experiment's suite v1");
  });

  it('Nous Portal not connected: tagged rows, the blocker, Launch disabled with Connect', async () => {
    useScenario('nous-not-connected');
    const w = await mountPage();
    expect(w.findAll('[data-testid="provider-tag"]').map((t) => t.text())).toEqual([
      'Nous Portal not connected',
      'Nous Portal not connected',
      'Nous Portal not connected',
    ]);
    await fillSample(w);
    const block = summary(w).get('[data-testid="launch-blocker"]');
    expect(block.text()).toContain("Can't launch yet: Nous Portal is not connected.");
    expect(block.get('button').text()).toBe('Connect Nous Portal');
    const launch = summary(w).get('[data-testid="launch"]');
    expect(launch.attributes('disabled')).toBeDefined();
    expect(summary(w).get('[data-testid="blocked-reason"]').text()).toBe(
      "Can't launch yet: Nous Portal is not connected. Connect",
    );
  });

  it('OpenRouter without a key: tagged rows and the .env step, no Connect', async () => {
    useScenario('openrouter-in-use');
    const w = await mountPage();
    expect(w.findAll('[data-testid="provider-tag"]').map((t) => t.text())).toEqual([
      'OpenRouter key missing',
      'OpenRouter key missing',
      'OpenRouter key missing',
    ]);
    await fillSample(w);
    const block = summary(w).get('[data-testid="launch-blocker"]');
    expect(block.text()).toContain("Can't launch yet: OpenRouter has no API key.");
    expect(block.text()).toContain('OPENROUTER_API_KEY');
    expect(block.findAll('button').map((b) => b.text())).not.toContain('Connect');
    expect(summary(w).get('[data-testid="launch"]').attributes('disabled')).toBeDefined();
  });

  it('no worker connected: the blocker with the command to start one', async () => {
    useScenario('no-worker');
    const w = await mountPage();
    await fillSample(w);
    const block = summary(w).get('[data-testid="launch-blocker"]');
    expect(block.text()).toContain("Can't launch yet: no worker is connected.");
    expect(block.get('[data-testid="copy-command"]').text()).toContain(
      'docker compose up -d worker',
    );
    expect(summary(w).get('[data-testid="launch"]').attributes('disabled')).toBeDefined();
  });

  it('a stale page: the refusal in the panel, Connect, the form unchanged', async () => {
    useScenario('launch-refused');
    const w = await mountPage();
    await fillSample(w);
    await summary(w).get('[data-testid="launch"]').trigger('click');
    await settle();
    const alert = summary(w).get('[data-testid="launch-failure"]');
    expect(alert.text()).toContain('Launch refused: Nous Portal is not connected.');
    expect(alert.get('code').text()).toBe(
      'POST /api/experiments → 409 · Nous Portal is not connected',
    );
    expect(alert.text()).toContain(
      'The login ended after this page loaded. Nothing was created and your form is unchanged.',
    );
    expect(alert.get('button').text()).toBe('Connect Nous Portal');
    expect(router.currentRoute.value.name).toBe('experiment-new');
    expect(w.get('#ne-name').element).toHaveProperty('value', 'Skill vs no skill, invoices-v1');
  });

  it('a configuration changed since the form loaded: reloads them for review', async () => {
    useScenario('launch-conflict');
    const w = await mountPage();
    await fillSample(w);
    const store = useExperimentsStore();
    // The API lists each configuration at its latest version only: with-skill is now v2.
    const previous = store.options!;
    const baseline = previous.configurations.find((c) => c.name === 'baseline')!;
    const skill = previous.configurations.find((c) => c.name === 'with-skill')!;
    const moved = {
      ...skill,
      versionId: 'cfv_with_skill_v2',
      version: 2,
      configHash: 'e'.repeat(64),
    };
    vi.spyOn(experimentsApi, 'getNewExperimentOptions').mockResolvedValueOnce({
      ...previous,
      configurations: previous.configurations.map((c) => (c === skill ? moved : c)),
    });
    const reload = vi.spyOn(store, 'loadOptions');
    await summary(w).get('[data-testid="launch"]').trigger('click');
    await settle();
    const alert = summary(w).get('[data-testid="launch-failure"]');
    expect(alert.text()).toContain('Launch failed');
    expect(alert.get('code').text()).toBe(
      'POST /api/experiments → 409 · configuration with-skill changed since you opened this form (now v2)',
    );
    expect(alert.text()).toContain('Review the comparison above, then launch again.');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(configRow(w, 'with-skill').attributes('data-role')).toBe('candidate');
    expect(configRow(w, 'baseline').attributes('data-role')).toBe('baseline');

    // Launch again: the new version and its hash go out.
    const post = vi.spyOn(store, 'launch').mockResolvedValue(EXPERIMENT_IDS.mcpVsBaseline);
    vi.spyOn(router, 'push').mockResolvedValue(undefined);
    await summary(w).get('[data-testid="launch"]').trigger('click');
    await settle();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        baselineVersionId: baseline.versionId,
        candidateVersionIds: [moved.versionId],
        expectedConfigHashes: {
          [baseline.versionId]: baseline.configHash,
          [moved.versionId]: moved.configHash,
        },
      }),
    );
  });

  it('with fewer than two configurations: how to make another', async () => {
    useScenario('first-launch');
    const w = await mountPage();
    const box = w.get('[data-testid="too-few-configurations"]');
    expect(box.text()).toContain(
      'An experiment compares a baseline with at least one candidate, and no configuration exists yet.',
    );
    expect(box.get('a').attributes('href')).toBe('/configurations/new');
    await w.get('#ne-name').setValue('First');
    expect(reason(w)).toBe('Pick at least two configurations.');
  });

  it('with no suite loaded: the way to load one, Launch waits for it', async () => {
    useScenario('empty');
    const w = await mountPage();
    expect(w.text()).toContain('No suites loaded');
    const none = w.get('[data-testid="no-suites"]');
    expect(none.text()).toContain('No suites found in ./suites');
    expect(none.get('a').attributes('href')).toBe('/suites');
    expect(reason(w)).toBe('Load a suite first.');
  });

  it('loading: a skeleton at the real layout', async () => {
    useScenario('loading');
    const w = await mountPage();
    const skeleton = w.get('[data-testid="new-experiment-skeleton"]');
    expect(skeleton.attributes('aria-busy')).toBe('true');
    expect(w.find('form').exists()).toBe(false);
  });

  it('load error: the request verbatim and Retry', async () => {
    useScenario('error');
    const w = await mountPage();
    const alert = w.get('[role="alert"]');
    expect(alert.text()).toContain('Could not load suites and configurations');
    expect(alert.get('code').text()).toBe(
      'GET /api/experiments/new-options → 502 · upstream api:8080 connection refused',
    );
    useScenario(null);
    await alert.get('button').trigger('click');
    await settle();
    expect(w.find('form').exists()).toBe(true);
  });
});
