import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { SAMPLE_RUN_ID } from '@/fixtures/experiments';
import { useInspectorStore } from '@/stores/inspector';
import { mountDrawer, runOf, spaced, squash } from './inspectorEnv';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('RunInspectorDrawer: the board run (dup_invoices · baseline · rep 3)', () => {
  it('draws the header of the board', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    const header = wrapper.get('header');
    expect(header.get('h1#ri-title').text()).toBe('dup_invoices');
    expect(header.get('[title="Task version"]').text()).toBe('v1');
    expect(header.text()).toContain('baseline');
    expect(header.get('[data-testid="tag"]').text()).toBe('rep 3 · attempt 1');
    expect(header.get('[data-testid="run-status"]').text()).toBe('scored');
    const result = header.get('[data-testid="run-result"]');
    expect(result.text()).toBe('answer failed');
    expect(result.attributes('data-tone')).toBe('fail');
    const figures = header.findAll('[data-testid="run-figures"] > div').map((d) => spaced(d));
    expect(figures).toEqual([
      'Duration 52 s',
      'Tokens 11,400 in · 1,900 out',
      'Est. cost $0.011',
      'Finished 22 Oct 10:21:07',
    ]);
    expect(header.get('[data-testid="ab-jump"]').text()).toBe('Same task under with-skill');
    expect(header.get('[data-testid="rescore"]').attributes('disabled')).toBeUndefined();
    expect(header.text()).toContain('Copy run id');
    expect(header.findAll('nav[aria-label="Sections"] a').map((a) => a.text())).toEqual([
      'Outcome',
      'Timeline',
      'Final response',
      'Artifacts',
      'Launch record',
    ]);
  });

  it('shows every score with its expected and observed values and comment', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    const outcome = wrapper.get('[data-testid="section-outcome"]');
    expect(outcome.findAll('th').map((th) => th.text())).toEqual([
      'Key',
      'Status',
      'Score',
      'Expected',
      'Observed',
      'Scorer comment',
    ]);
    const rows = outcome.findAll('[data-testid="score-row"]');
    expect(rows.map((r) => r.attributes('data-key'))).toEqual(['answer', 'reads_fixture']);
    const answer = rows[0]!;
    expect(answer.text()).toContain('primary');
    expect(answer.text()).toContain('json_match on duplicates, unordered');
    expect(answer.text()).toContain('0.00');
    expect(answer.text()).toContain('2 pairs');
    expect(answer.text()).toContain('[INV-1042, INV-1107]');
    expect(answer.text()).toContain(
      'expected 2 duplicate pairs, got 0; agent compared invoice numbers only',
    );
    // json_match with mismatches opens its evidence: "0 of 2 items match".
    expect(answer.get('[data-testid="evidence-toggle"]').text()).toContain('0 of 2 items match');
    expect(outcome.get('[data-testid="score-evidence"]').text()).toContain(
      'duplicates[0] does not match the reference',
    );
    expect(squash(outcome.text())).toContain(
      "Each check is scored on its own; there is no combined total. The primary check, answer, is this run's result.",
    );
  });

  it('draws the timeline with its count line, scrubber, first error open and legend', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    const timeline = wrapper.get('[data-testid="section-timeline"]');
    expect(squash(timeline.get('[data-testid="timeline-counts"]').text())).toBe(
      '9 events · 3 tool calls · 3 model calls · 1 refused connection · 1 error · Expand all',
    );
    expect(timeline.findAll('[data-testid="scrubber-tick"]')).toHaveLength(9);
    const events = timeline.findAll('[data-testid="timeline-event"]');
    expect(events).toHaveLength(9);
    // The background refusal is neutral and tagged; the KeyError call is the error, open.
    expect(events[0]!.attributes('data-look')).toBe('refused');
    expect(events[0]!.text()).toContain('Hermes background');
    expect(events[0]!.text()).toContain('+00:00.6');
    expect(events[3]!.attributes('data-look')).toBe('error');
    expect(events[3]!.get('button').attributes('aria-expanded')).toBe('true');
    expect(events[3]!.text()).toContain('Output · error');
    expect(events[3]!.text()).toContain("KeyError: 'vendor'");
    expect(events[3]!.text()).toContain('214 characters · not truncated.');
    expect(squash(timeline.get('[data-testid="legend"]').text())).toContain(
      "Model calls account for 46.8 s and tool calls for 2.7 s of the run's 52 s. Model-call tokens add up to the header: 11,400 in · 1,900 out.",
    );
  });

  it('expands and collapses every row', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    const toggleAll = wrapper.get('[data-testid="timeline-counts"] button');
    await toggleAll.trigger('click');
    expect(wrapper.findAll('[data-testid="event-detail"]')).toHaveLength(9);
    expect(toggleAll.text()).toBe('Collapse all');
    await toggleAll.trigger('click');
    expect(wrapper.findAll('[data-testid="event-detail"]')).toHaveLength(0);
  });

  it('seeks from a scrubber tick: the row opens', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    await wrapper.findAll('[data-testid="scrubber-tick"]')[2]!.trigger('click');
    const row = wrapper.get('[data-seq="3"]');
    expect(row.get('button').attributes('aria-expanded')).toBe('true');
    expect(row.text()).toContain('head invoices.csv');
    expect(row.text()).toContain('742 characters');
    expect(wrapper.findAll('[data-testid="scrubber-tick"]')[2]!.attributes('data-open')).toBe(
      'true',
    );
  });

  it('shows the final response with the extracted block and the reference', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    const final = wrapper.get('[data-testid="section-final"]');
    expect(final.get('[data-testid="json-highlight"]').text()).toContain('{"duplicates": []}');
    expect(spaced(final.get('[data-testid="parsed-answer"]'))).toContain(
      'Parsed answer duplicates : array(0)',
    );
    expect(spaced(final.get('[data-testid="reference-answer"]'))).toBe(
      'duplicates : array(2) ["INV-0988", "INV-1131"] ["INV-1042", "INV-1107"]',
    );
    expect(final.text()).toContain('Reference answer · hidden from the agent');
    expect(final.text()).toContain(
      'Each pair has the same vendor, amount and PO number under different invoice numbers.',
    );
    expect(final.find('[data-testid="extraction-banner"]').exists()).toBe(false);
  });

  it('lists the artifacts and says the agent wrote nothing', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    const artifacts = wrapper.get('[data-testid="section-artifacts"]');
    const rows = artifacts.findAll('[data-testid="artifact-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain('workspace/invoices.csv');
    expect(rows[0]!.text()).toContain('fixture · unchanged');
    expect(rows[0]!.text()).toMatch(/sha256:[0-9a-f]{8}…[0-9a-f]{4}/);
    expect(artifacts.get('[data-testid="artifacts-note"]').text()).toBe(
      'The agent wrote no files in its workspace during this run.',
    );
    // Fixture previews are closed by default; Preview opens the CSV table.
    expect(artifacts.find('[data-testid="artifact-preview"]').exists()).toBe(false);
    await rows[0]!.get('button').trigger('click');
    await flushPromises();
    const preview = artifacts.get('[data-testid="artifact-preview"]');
    expect(preview.text()).toContain('Preview · invoices.csv · CSV');
    expect(preview.findAll('th').length).toBeGreaterThan(1);
    expect(rows[0]!.get('button').attributes('aria-pressed')).toBe('true');
    expect(rows[0]!.get('a').attributes('href')).toMatch(
      new RegExp(`^/api/runs/${SAMPLE_RUN_ID}/artifacts/.+/content$`),
    );
  });

  it('keeps the launch record collapsed until opened', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    const launch = wrapper.get('[data-testid="section-launch"]');
    expect(launch.find('[data-testid="launch-record"]').exists()).toBe(false);
    await launch.get('h2 button').trigger('click');
    const record = spaced(launch.get('[data-testid="launch-record"]'));
    expect(record).toContain('Image nousresearch/hermes-agent:v0.22.4 (sha256:7a6920…)');
    expect(record).toContain('Hermes revision hermes-agent v0.22.4 @ 4d04303');
    expect(record).toContain('Limits 1.5 GB memory · 1 CPU · 1,024 processes · 512 MB /tmp');
    expect(record).toContain('Disk cap 2 GB · 50,000 files');
    expect(record).toContain('Worker worker-1 · started 10:20:15 · exit 0');
    expect(record).toContain(
      "Skills No added skills (Hermes' built-in hermes-agent skill is always loaded)",
    );
    expect(record).toContain('MCP servers None in this configuration');
    expect(record).toContain('--api-key ‹run token, revoked›');
    expect(record).toContain('Configuration file · /opt/data/config.yaml');
  });

  it("the header's Launch record link opens the collapsed section it jumps to", async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    const launch = wrapper.get('[data-testid="section-launch"]');
    expect(launch.find('[data-testid="launch-record"]').exists()).toBe(false);
    const link = wrapper
      .findAll('nav[aria-label="Sections"] a')
      .find((a) => a.text() === 'Launch record')!;
    await link.trigger('click');
    await flushPromises();
    expect(launch.find('[data-testid="launch-record"]').exists()).toBe(true);
    expect(launch.get('h2 button').attributes('aria-expanded')).toBe('true');
  });

  it('jumps to the same task under the other configuration and says so', async () => {
    const twin = runOf('skillVsNoSkill', 'dup_invoices', 'with-skill', 3);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    await wrapper.get('[data-testid="ab-jump"]').trigger('click');
    expect(wrapper.emitted('navigate')).toEqual([[twin]]);
    await wrapper.setProps({ runId: twin });
    await flushPromises();
    expect(wrapper.get('[data-testid="run-result"]').text()).toBe('answer passed');
    expect(spaced(wrapper.get('[data-testid="run-position"]'))).toMatch(
      /^Runs · A\/B jump from run \d+ \(baseline\)$/,
    );
  });
});

describe('RunInspectorDrawer: focus stays inside', () => {
  it('gives the A/B jump focus back once the other run is drawn', async () => {
    const twin = runOf('skillVsNoSkill', 'dup_invoices', 'with-skill', 3);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    const jump = wrapper.get('[data-testid="ab-jump"]');
    (jump.element as HTMLElement).focus();
    await jump.trigger('click');
    await wrapper.setProps({ runId: twin });
    // While the run loads, the drawer itself holds focus.
    expect(document.activeElement).toBe(wrapper.get('[data-testid="run-inspector"]').element);
    await flushPromises();
    expect(document.activeElement?.getAttribute('data-testid')).toBe('ab-jump');
    expect(document.activeElement?.textContent).toContain('Same task under baseline');
  });

  it('keeps focus on Next when it reaches the end of the list', async () => {
    const twin = runOf('skillVsNoSkill', 'dup_invoices', 'with-skill', 3);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID, {
      siblings: [SAMPLE_RUN_ID, twin],
    }));
    const next = wrapper.get('[data-testid="next-run"]');
    (next.element as HTMLElement).focus();
    await next.trigger('click');
    expect(wrapper.emitted('navigate')).toEqual([[twin]]);
    await wrapper.setProps({ runId: twin });
    await flushPromises();
    expect(next.attributes('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(next.element);
    // At the end, Next does nothing.
    await next.trigger('click');
    expect(wrapper.emitted('navigate')).toHaveLength(1);
  });
});

describe('RunInspectorDrawer: Prev and Next', () => {
  it('steps through the siblings with the buttons and J / K', async () => {
    const ids = ['run_a', SAMPLE_RUN_ID, 'run_c'];
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID, { siblings: ids }));
    expect(spaced(wrapper.get('[data-testid="run-position"]'))).toBe(
      'Runs · table order run 2 of 3',
    );
    await wrapper.get('[data-testid="next-run"]').trigger('click');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'J' }));
    expect(wrapper.emitted('navigate')).toEqual([['run_c'], ['run_a'], ['run_c']]);
  });

  it('ignores J while typing and with a modifier', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID, {
      siblings: [SAMPLE_RUN_ID, 'run_c'],
    }));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', metaKey: true }));
    input.remove();
    expect(wrapper.emitted('navigate')).toBeUndefined();
    expect(wrapper.get('[data-testid="prev-run"]').attributes('aria-disabled')).toBe('true');
  });

  it('uses the order the opening page registered', async () => {
    const { wrapper: w, pinia } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID);
    wrapper = w;
    const store = useInspectorStore(pinia);
    store.setOrder({
      experimentId: 'exp',
      source: 'Comparison',
      order: 'grid order',
      ids: [...Array.from({ length: 14 }, (_, i) => `run_${i}`), SAMPLE_RUN_ID, 'run_next'],
    });
    await flushPromises();
    expect(spaced(w.get('[data-testid="run-position"]'))).toBe(
      'Comparison · grid order run 15 of 16',
    );
    await w.get('[data-testid="prev-run"]').trigger('click');
    expect(w.emitted('navigate')).toEqual([['run_13']]);
  });

  it('falls back to the experiment runs in their default order', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    expect(spaced(wrapper.get('[data-testid="run-position"]'))).toMatch(
      /^Runs · all runs run \d+ of 120$/,
    );
    expect(wrapper.get('[data-testid="next-run"]').attributes('aria-disabled')).toBeUndefined();
  });

  it('closes on Esc from the A/B jump, which has no tooltip on a scored run', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    const jump = wrapper.get('[data-testid="ab-jump"]');
    (jump.element as HTMLElement).focus();
    await jump.trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('close')?.length ?? 0).toBeGreaterThan(0);
  });

  it('closes from the close button', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', SAMPLE_RUN_ID));
    await wrapper.get('[data-testid="close-inspector"]').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });
});
