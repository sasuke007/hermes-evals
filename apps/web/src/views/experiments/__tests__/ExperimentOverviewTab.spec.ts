import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { EXPERIMENT_IDS, getExperiment } from '@/api/experiments';
import FailedPanel from '@/components/overview/FailedPanel.vue';
import { routes } from '@/router';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import { useExperimentDetailStore } from '@/stores/experiment-detail';
import { useRunsStore } from '@/stores/runs';
import { mountExperimentRoute, settle } from './experimentPage';

const MVB = EXPERIMENT_IDS.mcpVsBaseline;
const SVN = EXPERIMENT_IDS.skillVsNoSkill;

let wrapper: VueWrapper | null = null;
async function open(id: string, scenario: string | null = null, tail = '') {
  const page = await mountExperimentRoute(`/experiments/${id}${tail}`, scenario);
  wrapper = page.wrapper;
  return page;
}
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const text = (w: VueWrapper, selector: string) => w.get(selector).text().replace(/\s+/g, ' ');
/** The words of an element, its leaf elements joined by single spaces (flex rows have none). */
function words(w: VueWrapper, selector: string): string {
  const leaves = [...w.get(selector).element.querySelectorAll('*')].filter(
    (el) => el.children.length === 0 && el.textContent?.trim(),
  );
  return leaves.map((el) => el.textContent!.trim()).join(' ');
}

describe('Overview · running (OverviewRunning)', () => {
  it('draws the header, the progress, the configurations and the feed', async () => {
    // The elapsed clock counts on from the fetch: a stopped clock keeps it at the record's value
    // however long the mount takes under load.
    vi.useFakeTimers({ toFake: ['Date'] });
    const { wrapper: w } = await open(MVB);
    expect(w.get('h1').text()).toBe('MCP vs baseline, invoices-v1');
    expect(w.get('[data-testid=experiment-status]').attributes('data-status')).toBe('running');
    expect(text(w, '[data-testid=experiment-meta]')).toBe(
      'baseline vs with-mcp · 12 tasks × 2 configurations × 5 repetitions · launched 23 Oct 14:52',
    );
    // The tab row: provisional comparison, 120 runs, live status.
    const tabs = w.get('nav[aria-label=Experiment]');
    expect(tabs.text()).toContain('provisional');
    expect(tabs.text()).toContain('Runs 120');
    expect(w.get('[data-testid=experiment-live]').text()).toBe('Live · updated 15:23:42');

    const progress = w.get('[data-testid=progress-panel]');
    expect(progress.get('[data-testid=scored-count]').text()).toBe('87');
    expect(progress.text()).toContain('/ 120 scored');
    expect(progress.text()).toContain('72.5%');
    expect(progress.get('[data-testid=elapsed]').text()).toBe('31m 12s');
    expect(progress.text()).toContain('≈ 10 min');
    expect(text(w, '[data-testid=spend]')).toBe('$1.21 of $2.00');
    expect(text(w, '[data-testid=spend-line]')).toBe(
      'Spend $1.21 of $2.00 ceiling · projected total ≈ $1.66',
    );
    const legend = progress.findAll('[data-testid=progress-legend] a');
    expect(
      legend.map((a) =>
        a
          .findAll('span')
          .map((s) => s.text())
          .filter(Boolean)
          .join(' '),
      ),
    ).toEqual([
      'scored 87',
      'execution_error 1',
      'scoring 1',
      'executed 0',
      'running 3',
      'queued 28',
    ]);
    expect(legend[5]!.attributes('href')).toBe(`/experiments/${MVB}/runs?status=queued`);
    expect(progress.get('[role=progressbar]').attributes('aria-label')).toBe(
      '87 of 120 runs scored',
    );

    expect(w.findAll('[data-testid=config-detail]').map((d) => d.text())).toEqual([
      '46 scored · 2 running · 12 queued · 0 execution errors · provisional pass rate 0.630',
      '41 scored · 1 execution_error · 1 running · 1 scoring · 16 queued · provisional pass rate 0.683',
    ]);
    const feed = w.findAll('[data-testid=latest-completions] tbody tr');
    expect(feed).toHaveLength(10);
    expect(feed[0]!.findAll('td').map((td) => td.text())).toEqual([
      '15:23:41',
      'per_vendor',
      'with-mcp',
      '4',
      'passed',
      '44 s',
    ]);
    expect(feed[4]!.text()).toContain('execution_error');
    expect(feed[4]!.text()).toContain('300 s');

    // The provisional verdict so far, and the frozen snapshot.
    const card = w.get('[data-testid=verdict-card]');
    expect(card.attributes('data-verdict')).toBe('provisional');
    expect(card.get('[data-testid=verdict-chip]').text()).toBe('Provisional');
    expect(card.text()).toContain(
      'Based on 87 of 120 runs scored so far. The interval will change.',
    );
    const strip = words(w, '[data-testid=snapshot-strip]');
    expect(strip).toContain('Frozen snapshot');
    expect(strip).toContain('Suite invoices-v1 v1 · 12 tasks 3f9c2a1 view v1');
    // The API sends the full commit; the strip shows its first 7 characters.
    expect(strip).toMatch(/Hermes hermes-agent v0\.22\.4 @ 4d04303(?![0-9a-f])/);
    expect(strip).toContain('Score keys primary per task');

    const controls = w.get('[data-testid=experiment-controls]');
    expect(controls.findAll('button').map((b) => b.text())).toEqual(['Pause', 'Cancel experiment']);
  });

  it('opens a feed row in the inspector over the Overview and orders J/K by the feed', async () => {
    const { wrapper: w, router, pinia } = await open(MVB);
    const row = w.findAll('[data-testid=latest-completions] tbody tr')[1]!;
    const runId = row.attributes('data-run-id')!;
    await row.findAll('td')[3]!.trigger('click');
    await settle();
    expect(router.currentRoute.value.name).toBe('experiment-overview');
    expect(router.currentRoute.value.query.run).toBe(runId);
    const order = useExperimentDetailStore(pinia).runOrder;
    expect(order).toHaveLength(10);
    expect(order[1]).toBe(runId);
  });

  it('asks before cancelling, then cancels', async () => {
    const { wrapper: w, pinia } = await open(MVB);
    await w.get('[data-testid=experiment-controls] button.danger').trigger('click');
    await settle();
    const group = w.get('[role=group][aria-label="Confirm cancel"]');
    expect(group.text()).toContain('Cancel 32 unfinished runs?');
    expect(group.text()).toContain('28 queued runs will not start.');
    // OverviewRunning: the title over the consequence, at most 820px, `cancelled` in mono.
    expect(group.attributes('data-layout')).toBe('columns');
    expect(group.get('[data-testid=confirm-text]').classes()).toContain('max-w-820');
    expect(group.get('[data-testid=confirm-consequence] .font-mono').text()).toBe('cancelled');
    expect(document.activeElement?.textContent?.trim()).toBe('Keep running');
    // The trigger is hidden while the panel is open.
    expect(w.find('[data-testid=experiment-controls] button.danger').exists()).toBe(false);
    await group.get('button.danger').trigger('click');
    await settle();
    expect(useExperimentDetailStore(pinia).records[MVB]!.status).toBe('completed');
    expect(w.get('[data-testid=experiment-status]').attributes('data-status')).toBe('completed');
  });

  it('gives focus to the page title once Cancel is done (its control is gone)', async () => {
    const { wrapper: w } = await open(MVB);
    await w.get('[data-testid=experiment-controls] button.danger').trigger('click');
    await settle();
    const confirm = w.get('[role=group][aria-label="Confirm cancel"] button.danger');
    (confirm.element as HTMLElement).focus();
    await confirm.trigger('click');
    await settle();
    expect(document.activeElement).toBe(w.get('[data-testid=experiment-header] h1').element);
    expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
  });

  it('gives focus to the current tab when the run a drawer showed is not on it', async () => {
    const { wrapper: w, router } = await open(MVB);
    const feed = w
      .findAll('[data-testid=latest-completions] tr[data-run-id]')
      .map((r) => r.attributes('data-run-id'));
    const runs = useRunsStore();
    await runs.load(MVB);
    const elsewhere = runs.rows.find((r) => !feed.includes(r.id))!.id;
    await router.push({ query: { run: elsewhere } });
    await settle();
    expect(w.find('[data-testid=run-inspector]').exists()).toBe(true);
    await w.get('[data-testid=close-inspector]').trigger('click');
    await settle();
    expect(router.currentRoute.value.query.run).toBeUndefined();
    expect(document.activeElement?.textContent).toContain('Overview');
    expect(document.activeElement?.getAttribute('aria-current')).toBe('page');
  });

  it('knows a cancelled experiment that is still finishing, after a reload too', async () => {
    const { wrapper: w, pinia } = await open(MVB);
    // As GET /experiments/:id answers after Cancel: still running, cancelledAt set.
    useExperimentDetailStore(pinia).records[MVB]!.cancelledAt = '2026-10-23T15:24:00';
    await settle();
    const controls = w.get('[data-testid=experiment-controls]');
    expect(controls.get('[data-testid=cancelling]').text()).toBe(
      'Cancelled · in-flight runs finishing',
    );
    expect(controls.find('button.danger').exists()).toBe(false);
    expect(controls.text()).not.toContain('Pause');
  });

  it('backs out of cancelling with Keep running', async () => {
    const { wrapper: w } = await open(MVB);
    await w.get('[data-testid=experiment-controls] button.danger').trigger('click');
    await settle();
    const keep = w
      .findAll('[aria-label="Confirm cancel"] button')
      .find((b) => b.text() === 'Keep running')!;
    await keep.trigger('click');
    await settle();
    expect(w.find('[aria-label="Confirm cancel"]').exists()).toBe(false);
    expect(w.find('[data-testid=experiment-controls] button.danger').exists()).toBe(true);
  });

  it('pauses: Resume replaces Pause and the live status says Paused', async () => {
    const { wrapper: w } = await open(MVB);
    await w.get('[data-testid=experiment-controls] button').trigger('click');
    await settle();
    expect(w.get('[data-testid=experiment-status]').attributes('data-status')).toBe('paused');
    const buttons = w.findAll('[data-testid=experiment-controls] button').map((b) => b.text());
    expect(buttons).toEqual(['Resume', 'Cancel experiment']);
    expect(w.get('[data-testid=experiment-live]').text()).toBe('Paused · in-flight runs finishing');
  });

  it('freezes the values while the live stream is lost', async () => {
    const { wrapper: w } = await open(MVB, 'stream-lost');
    expect(w.get('[data-testid=experiment-live]').text()).toContain('Reconnecting (attempt 3)');
    const progress = w.get('[data-testid=progress-panel]');
    expect(progress.text()).toContain('Reconnecting (attempt 3)');
    expect(progress.text()).toContain(
      'The experiment keeps running in the worker; only this page has lost its connection.',
    );
    expect(progress.get('[data-testid=scored-count]').text()).toBe('87');
  });

  it('shows no worker: the banner, frozen values and the worker_lost runs', async () => {
    const { wrapper: w } = await open(MVB, 'no-worker');
    const banner = w.get('[data-testid=no-worker-banner]');
    expect(banner.attributes('role')).toBe('alert');
    expect(banner.text()).toContain('No worker is connected. 28 queued runs will not start.');
    expect(banner.text()).toContain('last worker heartbeat 15:31:04');
    expect(text(w, '[data-testid=no-worker-banner]')).toContain(
      'Check the worker service: docker compose ps worker then docker compose logs worker',
    );
    expect(w.get('[data-testid=frozen-since]').text()).toBe('frozen since 15:31:04');
    expect(text(w, '[data-testid=worker-lost]')).toBe(
      '4 runs that were in flight are marked execution_error · worker_lost and can be retried.',
    );
    // Inside the progress block, under the frozen bar and its legend (ExperimentStates).
    const panel = w.get('[data-testid=progress-panel]');
    expect(panel.find('[data-testid=worker-lost]').exists()).toBe(true);
    expect(
      panel
        .get('[data-testid=progress-legend]')
        .element.compareDocumentPosition(panel.get('[data-testid=worker-lost]').element) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('just launched: nothing in the feed yet, no interval yet', async () => {
    const { wrapper: w } = await open(MVB, 'nothing-scored');
    expect(w.get('[data-testid=scored-count]').text()).toBe('0');
    expect(w.get('[data-testid=feed-empty]').text()).toContain('No run has finished yet.');
    expect(w.find('[data-testid=no-interval]').exists()).toBe(true);
  });

  it('one VerdictCard per candidate while two candidates run (Skill + MCP)', async () => {
    const { wrapper: w } = await open(EXPERIMENT_IDS.skillMcp);
    const cards = w.findAll('[data-testid=verdict-card]');
    expect(cards.map((c) => c.attributes('aria-label'))).toEqual([
      'Verdict for with-skill against baseline',
      'Verdict for with-mcp against baseline',
    ]);
    expect(text(w, '[data-testid=experiment-meta]')).toContain('baseline vs with-skill, with-mcp');
    // Provisional, between the per-configuration grid and the snapshot strip (Components 2,
    // UI_FLOWS 14.2; Phase 5 #7).
    expect(cards.map((c) => c.get('[data-testid=verdict-chip]').attributes('data-status'))).toEqual(
      ['provisional', 'provisional'],
    );
    const order = [
      w.get('[data-testid=per-configuration]').element,
      cards[0]!.element,
      cards[1]!.element,
      w.get('[data-testid=snapshot-strip]').element,
    ];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // Links carry the candidate when there is more than one.
    const link = cards[1]!.findAll('a').find((a) => a.text() === 'View comparison')!;
    expect(link.attributes('href')).toContain('candidate=');
  });
});

describe('Overview · paused', () => {
  it('by the spend ceiling: resume with a higher ceiling', async () => {
    const { wrapper: w, pinia } = await open(MVB, 'paused-ceiling');
    const panel = w.get('[data-testid=spend-ceiling-pause]');
    expect(panel.text()).toContain(
      'Paused at 15:08: spend reached the $2.00 ceiling (87 / 120 scored)',
    );
    expect(text(w, '[data-testid=spend-ceiling-pause] p')).toBe(
      'Runs that were already in flight finished before pausing; no run was cut off. 32 runs are waiting. Resume continues only if the ceiling is raised.',
    );
    expect(panel.get('[data-testid=remaining-cost]').text()).toBe(
      '≈ $0.45 more is needed to finish the remaining 32 runs',
    );
    const input = panel.get('input');
    expect((input.element as HTMLInputElement).value).toBe('3.00');
    // Resume in the header gives way to the form.
    expect(w.findAll('[data-testid=experiment-controls] button').map((b) => b.text())).toEqual([
      'Cancel experiment',
    ]);
    await input.setValue('1.50');
    await panel.get('form').trigger('submit');
    await settle();
    expect(panel.text()).toContain('Raise it above $2.00.');
    await input.setValue('3.00');
    await panel.get('form').trigger('submit');
    await settle();
    expect(useExperimentDetailStore(pinia).records[MVB]!.status).toBe('running');
  });

  it('by a disconnected provider: Resume waits for Reconnect', async () => {
    const { wrapper: w } = await open(MVB, 'paused-provider,nous-not-connected');
    expect(w.findAll('h1 ~ [data-kind]').map((c) => c.text())).toEqual([
      'paused',
      'provider disconnected',
    ]);
    const line = w.get('[data-testid=provider-pause]');
    expect(line.attributes('data-ready')).toBe('false');
    expect(line.text().replace(/\s+/g, ' ')).toBe(
      'Paused at 15:08: Nous Portal is not connected. In-flight runs finished; no attempts were used.',
    );
    const buttons = w.findAll('[data-testid=experiment-controls] button');
    const resume = buttons.find((b) => b.text() === 'Resume')!;
    expect(resume.attributes('disabled')).toBeDefined();
    expect(resume.attributes('title')).toBe('Connect Nous Portal first');
    expect(buttons.some((b) => b.text() === 'Reconnect')).toBe(true);
    expect(w.get('[data-testid=controls-reason]').text()).toBe('Connect Nous Portal first');
  });

  it('by a disconnected provider that is back: Resume to continue', async () => {
    const { wrapper: w } = await open(MVB, 'paused-provider');
    const line = w.get('[data-testid=provider-pause]');
    expect(line.attributes('data-ready')).toBe('true');
    expect(line.text()).toContain('Reconnected. Resume to continue.');
    const resume = w
      .findAll('[data-testid=experiment-controls] button')
      .find((b) => b.text() === 'Resume')!;
    expect(resume.classes()).toContain('primary');
    expect(resume.attributes('disabled')).toBeUndefined();
  });
});

describe('Overview · failed', () => {
  it('says why fewer runs ended in execution_error than attempts failed (Phase 5 #15)', async () => {
    useScenario(null);
    const detail = await getExperiment(EXPERIMENT_IDS.mcpFirstTry);
    const w = mount(FailedPanel, {
      props: {
        detail: {
          ...detail,
          counts: { ...detail.counts, execution_error: 0, queued: detail.counts.queued + 14 },
        },
        failure: detail.failure!,
      },
      global: { plugins: [createRouter({ history: createMemoryHistory(), routes })] },
    });
    expect(words(w, '[data-testid=failed-attempts]')).toBe('failed attempts in a row 14');
    expect(words(w, '[data-testid=execution-errors]')).toBe('execution_error 0');
    expect(w.text().replace(/\s+/g, ' ')).toContain(
      'Automatic retries count as failed attempts, so fewer runs end in execution_error than attempts failed: the retried ones are queued.',
    );
  });

  it('names the circuit breaker cause and offers Retry failed runs', async () => {
    const { wrapper: w, pinia } = await open(EXPERIMENT_IDS.mcpFirstTry);
    const panel = w.get('[data-testid=failed-panel]');
    const banner = panel.get('[role=alert]');
    expect(banner.attributes('data-tone')).toBe('violet');
    expect(banner.text()).toContain(
      'Stopped after 14 failed attempts in a row (setup): invoice-db failed to start',
    );
    expect(banner.text()).toContain('Error: INVOICE_DB_URL is not set');
    expect(banner.text()).toContain('first line of stderr, identical in all 14 runs');
    expect(banner.get('a').text()).toBe('check Secrets');
    expect(words(w, '[data-testid=failed-panel]')).toContain(
      'failed attempts in a row 14 execution_error 14 queued 106 0 scored · spend $0.02',
    );
    // Every failed attempt ended its run here, so nothing explains a gap.
    expect(text(w, '[data-testid=failed-panel]')).not.toContain('Automatic retries');
    expect(text(w, '[data-testid=failed-panel]')).toContain(
      '"Retry failed runs" re-queues the 14 errored runs and resumes the 106 queued ones.',
    );
    const controls = w.get('[data-testid=experiment-controls]');
    expect(controls.text()).toContain('Duplicate as new');
    await controls.get('button').trigger('click');
    await settle();
    expect(useExperimentDetailStore(pinia).records[EXPERIMENT_IDS.mcpFirstTry]!.status).toBe(
      'running',
    );
  });
});

describe('Overview · complete (OverviewComplete)', () => {
  it('draws the VerdictCard, what was tested and the aggregates', async () => {
    const { wrapper: w } = await open(SVN);
    expect(text(w, '[data-testid=experiment-meta]')).toBe(
      'baseline vs with-skill · 12 tasks × 2 configurations × 5 repetitions = 120 runs · concurrency 3 · finished 22 Oct 10:51, took 37m 04s',
    );
    expect(w.find('[data-testid=experiment-live]').exists()).toBe(false);
    expect(w.get('nav[aria-label=Experiment]').text()).not.toContain('provisional');
    const duplicate = w.get('[data-testid=experiment-controls] a');
    expect(duplicate.text()).toBe('Duplicate as new');
    expect(duplicate.attributes('href')).toBe(`/experiments/new?from=${SVN}`);

    const card = w.get('[data-testid=verdict-card]');
    expect(card.attributes('data-verdict')).toBe('better');
    expect(card.get('[data-testid=verdict-delta]').text()).toBe('+0.217');
    expect(card.text()).toContain('95% interval [+0.117, +0.333]');
    expect(card.get('[role=img]').attributes('aria-label')).toBe(
      'Difference +0.217, 95% interval +0.117 to +0.333, entirely above zero',
    );
    expect(card.text()).toContain('0.633');
    expect(card.text()).toContain('38 / 60 runs');
    expect(card.text()).toContain('0.850');
    expect(card.text()).toContain('8 improved');
    expect(card.text()).toContain('10,000 resamples over tasks');
    expect(card.get('[data-testid=verdict-sentence]').text()).toBe(
      'The interval lies entirely above zero, so with-skill is better on invoices-v1 at 95% confidence. Before acting on it, check the costs: the candidate is also 13 s slower and uses 39% more tokens per run.',
    );
    const improved = card.findAll('a').find((a) => a.text() === '8 improved')!;
    expect(improved.attributes('href')).toBe(`/experiments/${SVN}/comparison?show=improved`);

    const tested = words(w, '[data-testid=what-was-tested]');
    expect(tested).toContain(
      'Frozen when the experiment was created. Later edits to suites or configurations do not change this experiment.',
    );
    expect(tested).toContain('invoices-v1 v1 · all 12 tasks 3f9c2a1 view v1');
    expect(tested).toContain('skills: invoice-method@1.0.0 sha256:9c41e07d');
    expect(tested).toContain('baseline v1 · view as of this experiment');
    expect(tested).toMatch(/hermes-agent v0\.22\.4 @ 4d04303(?![0-9a-f])/);
    expect(tested).toContain('Primary key of each task');
    expect(tested).toContain('5 · concurrency 3 · no spend ceiling');

    const rows = w.findAll('[data-testid=aggregates] tbody tr');
    expect(rows).toHaveLength(2);
    expect(words(w, '[data-testid=aggregates] tbody tr:first-child')).toBe(
      'baseline baseline 0.633 0.671 48 s 14,200 $0.71 1 2',
    );
    expect(words(w, '[data-testid=aggregates] tbody tr:last-child')).toBe(
      'with-skill candidate 0.850 0.874 61 s 19,800 $0.98 0 0',
    );
    const errors = rows[0]!.findAll('a');
    expect(errors[0]!.attributes('href')).toBe(
      `/experiments/${SVN}/runs?config=baseline&exec_error=1`,
    );
    expect(errors[1]!.attributes('href')).toBe(
      `/experiments/${SVN}/runs?config=baseline&ungradable=1`,
    );
    expect(text(w, '[data-testid=aggregates]')).toContain(
      '60 runs each · cost estimated from token counts and the price table',
    );
  });

  it('carries the recomputed verdict line (Flow B)', async () => {
    const { wrapper: w } = await open(EXPERIMENT_IDS.mcpSmoke, 'verdict-updated');
    const card = w.get('[data-testid=verdict-card]');
    expect(card.attributes('data-verdict')).toBe('inconclusive');
    expect(card.get('[data-testid=verdict-history]').text()).toBe(
      'Updated 23 Oct 14:20 after 1 retry · previously +0.056 [−0.111, +0.250]',
    );
  });

  it('has no interval with one repetition, and a newer suite version', async () => {
    const { wrapper: w } = await open(EXPERIMENT_IDS.quickCheck, 'single-rep,newer-version');
    const card = w.get('[data-testid=verdict-card]');
    expect(card.get('[data-testid=verdict-chip]').text()).toBe('not computable');
    expect(card.get('[data-testid=no-interval]').text()).toBe(
      'Needs at least 2 repetitions per task to compute an interval.',
    );
    expect(card.find('[role=img]').exists()).toBe(false);
    const newer = w.get('[data-testid=newer-suite-version]');
    expect(newer.text().replace(/\s+/g, ' ')).toContain(
      'A newer version of invoices-v1 exists (v2): 1 task changed (total_due).',
    );
    expect(newer.get('a').text()).toBe('Duplicate on v2');
  });
});

describe('Overview · loading and load error', () => {
  it('draws skeletons while the experiment loads', async () => {
    const { wrapper: w } = await open(SVN, 'loading');
    expect(w.get('[data-testid=overview-loading]').attributes('aria-busy')).toBe('true');
    expect(w.find('h1').exists()).toBe(false);
    // The tab bar stays usable.
    expect(w.findAll('nav[aria-label=Experiment] a')).toHaveLength(3);
  });

  it('replaces the body with the error and Retry', async () => {
    const { wrapper: w } = await open(SVN, 'error');
    const banner = w.get('[data-testid=overview-error]');
    expect(banner.text()).toContain('Could not load this experiment');
    expect(banner.text()).toContain(
      `GET /api/experiments/${SVN} → 502 · upstream api:8080 connection refused`,
    );
    expect(banner.text()).toContain(
      'The tab bar stays usable. Check that the api service is running: docker compose ps api.',
    );
    expect(banner.get('button').text()).toBe('Retry');
  });
});
