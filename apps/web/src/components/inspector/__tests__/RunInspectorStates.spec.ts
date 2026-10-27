/**
 * The drawer in each state the Run inspector states board draws, from the fixtures:
 * execution error, running (live), cancelled, ungradable, scorer error, scored after a
 * retry, an MCP run, a skill run, a refusal on the agent's own call, the controls blocked by
 * model access, and loading and load error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import * as runsApi from '@/api/runs';
import { mountDrawer, runOf, spaced, squash } from './inspectorEnv';

let wrapper: VueWrapper | null = null;
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const figuresOf = (w: VueWrapper): string[] =>
  w.findAll('[data-testid="run-figures"] > div').map((d) => spaced(d));

describe('execution_error (disputed · baseline · rep 4)', () => {
  const id = () => runOf('skillVsNoSkill', 'disputed', 'baseline', 4);

  it('puts the category and reason in the header and Retry execution first', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id()));
    expect(wrapper.get('[data-testid="tag"]').text()).toBe('rep 4 · attempt 2 of 2');
    expect(wrapper.get('[data-testid="run-status"]').text()).toBe('execution_error · timeout');
    expect(wrapper.get('[data-testid="execution-reason"]').text()).toContain(
      'No final response within the 300 s time budget.',
    );
    expect(figuresOf(wrapper)[0]).toBe('Duration 300 s (budget)');
    const retry = wrapper.get('[data-testid="retry"]');
    expect(retry.text()).toBe('Retry execution');
    expect(retry.classes()).toContain('primary');
    expect(wrapper.find('[data-testid="rescore"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ab-jump"]').exists()).toBe(false);
  });

  it('replaces the scores with the banner, the attempts and the stderr tail', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id()));
    const banner = wrapper.get('[data-testid="execution-error"]');
    expect(banner.attributes('role')).toBe('alert');
    expect(banner.text()).toContain('Not scored: execution failed');
    expect(banner.get('[data-current="true"]').text()).toBe('timeout');
    expect(banner.findAll('.chip').map((c) => c.text())).toEqual([
      'provider',
      'timeout',
      'setup',
      'worker_lost',
      'limit',
      'other',
    ]);
    expect(banner.text()).toContain('Both attempts timed out at the same step');
    const attempts = wrapper.findAll('[data-testid="attempt-row"]');
    expect(attempts.map((r) => spaced(r))).toEqual([
      '1 of 2 execution_error timeout 22 Oct 10:37:10 300 s platform time limit',
      '2 of 2 shown execution_error timeout 22 Oct 10:46:20 300 s platform time limit',
    ]);
    expect(squash(wrapper.get('[data-testid="stderr-caption"]').text())).toBe(
      'stderr · last 6 of 1,204 lines',
    );
    expect(wrapper.get('[data-testid="stderr-tail"]').text()).toContain(
      'hermes: exit 124 (timeout)',
    );
    expect(wrapper.find('[data-testid="score-row"]').exists()).toBe(false);
  });

  it('folds the timeline to one line until Show timeline', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id()));
    const folded = wrapper.get('[data-testid="section-timeline"]');
    expect(folded.attributes('data-folded')).toBe('true');
    expect(folded.text()).toContain('23 events before the timeout');
    await folded.get('button').trigger('click');
    expect(wrapper.get('[data-testid="section-timeline"]').attributes('data-folded')).toBe(
      undefined,
    );
    expect(wrapper.findAll('[data-testid="timeline-event"]').length).toBeGreaterThan(0);
  });

  it('says why there is no final response', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id()));
    expect(wrapper.get('[data-testid="final-absent"]').text()).toBe(
      'No final response: the run stopped before Hermes wrote one.',
    );
  });

  it('retries: the header reports the attempt the API created', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id()));
    await wrapper.get('[data-testid="retry"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="action-done"]').text()).toBe('Retry queued as attempt 3.');
  });

  it('quotes a refused retry verbatim', async () => {
    vi.spyOn(runsApi, 'retryRun').mockRejectedValue(
      new Error('POST /api/runs/x/retry → 409 · run is scored, not execution_error'),
    );
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id()));
    await wrapper.get('[data-testid="retry"]').trigger('click');
    await flushPromises();
    const banner = wrapper.get('[data-testid="action-error"]');
    expect(banner.text()).toContain('The action was refused');
    expect(banner.text()).toContain('409 · run is scored, not execution_error');
  });

  it('draws the silent timeout with the stop line', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id(), { scenario: 'timeout-silent' }));
    expect(wrapper.get('[data-testid="execution-reason"]').text()).toContain(
      'Stopped at the time limit (300 s budget plus grace). The run printed nothing, and was still stopped on time',
    );
    expect(wrapper.get('[data-testid="execution-reason"]').text()).toContain('stopped at 310 s');
  });
});

describe('the other execution_error categories', () => {
  it('disk limit (other)', async () => {
    const id = runOf('skillVsNoSkill', 'summary_file', 'with-skill', 2, 'disk-limit');
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id, { scenario: 'disk-limit' }));
    expect(wrapper.get('[data-testid="run-status"]').text()).toBe('execution_error · other');
    expect(spaced(wrapper.get('[data-testid="execution-reason"]'))).toBe(
      'Stopped: the run wrote more than 2 GB to its workspace (disk limit) after 41 s · workspace 2.0 GB, 1,318 files',
    );
  });

  it('token cap (limit)', async () => {
    const id = runOf('mcpSmoke', 'vat_split', 'with-mcp', 3, 'token-cap');
    ({ wrapper } = await mountDrawer('mcpSmoke', id, { scenario: 'token-cap' }));
    expect(wrapper.get('[data-testid="run-status"]').text()).toBe('execution_error · limit');
    expect(wrapper.get('[data-testid="execution-error"] [data-current="true"]').text()).toBe(
      'limit',
    );
    expect(wrapper.get('[data-testid="execution-error"]').text()).toContain(
      'A limit is never retried automatically',
    );
  });

  it('provider lapse: the attempts not counted against the run', async () => {
    const id = runOf('skillVsNoSkill', 'late_fees', 'with-skill', 3, 'provider-lapsed');
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id, { scenario: 'provider-lapsed' }));
    expect(wrapper.get('[data-testid="run-status"]').text()).toBe('execution_error · provider');
    const rows = wrapper.findAll('[data-testid="attempt-row"]');
    expect(rows.every((r) => r.text().includes('not counted'))).toBe(true);
  });
});

describe('running (currency_mix · with-mcp · rep 5)', () => {
  const id = () => runOf('mcpVsBaseline', 'currency_mix', 'with-mcp', 5);

  it('offers Cancel run instead of Re-score and the A/B jump, with the live figures', async () => {
    ({ wrapper } = await mountDrawer('mcpVsBaseline', id()));
    expect(wrapper.get('[data-testid="run-status"]').text()).toBe('running');
    expect(wrapper.get('[data-testid="elapsed"]').text()).toBe('00:38 elapsed');
    expect(figuresOf(wrapper)).toEqual([
      'Tokens so far 9,840 in · 1,120 out',
      'Budget 300 s · 20 turns',
      'Turn 6 of 20',
    ]);
    const actions = wrapper.get('[data-testid="run-actions"]');
    expect(actions.text()).toContain('Cancel run');
    expect(wrapper.find('[data-testid="rescore"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="ab-jump"]').exists()).toBe(false);
    expect(squash(wrapper.get('[data-testid="outcome-note"]').text())).toBe(
      'Not scored yet. Scores appear here when execution finishes and the scorers for this task complete.',
    );
  });

  it('shows the live timeline with the open call still running', async () => {
    ({ wrapper } = await mountDrawer('mcpVsBaseline', id()));
    expect(squash(wrapper.get('[data-testid="timeline-live"]').text())).toBe('14 events · live');
    const rows = wrapper.findAll('[data-testid="timeline-event"]');
    expect(rows).toHaveLength(14);
    const last = rows[13]!;
    expect(last.attributes('data-look')).toBe('running');
    expect(last.text()).toContain('invoice-db');
    expect(last.text()).toContain('get_invoice');
    expect(last.text()).toContain('running');
    // Nothing opens by default while live.
    expect(wrapper.findAll('[data-testid="event-detail"]')).toHaveLength(0);
    expect(wrapper.get('[data-testid="final-absent"]').text()).toBe(
      'No final response yet: the run has not finished.',
    );
    expect(wrapper.get('[data-testid="artifacts-note"]').text()).toBe(
      'Artifacts are collected when the run ends.',
    );
  });

  it('polls the events every second and the detail every 5 s while live', async () => {
    vi.useFakeTimers();
    const events = vi.spyOn(runsApi, 'listRunEvents');
    const detail = vi.spyOn(runsApi, 'getRun');
    ({ wrapper } = await mountDrawer('mcpVsBaseline', id()));
    const loads = detail.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toHaveBeenCalledWith(id(), 14);
    // The elapsed time counts on between loads.
    expect(wrapper.get('[data-testid="elapsed"]').text()).toBe('00:39 elapsed');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(events.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(detail.mock.calls.length).toBeGreaterThan(loads);
  });

  it('cancels after confirming in place', async () => {
    ({ wrapper } = await mountDrawer('mcpVsBaseline', id()));
    const trigger = wrapper
      .findAll('[data-testid="run-actions"] button')
      .find((b) => b.text() === 'Cancel run')!;
    await trigger.trigger('click');
    const group = wrapper.get('[role="group"][aria-label="Cancel this run?"]');
    expect(group.text()).toContain('A cancelled run is not scored');
    // The title over its long consequence, buttons right (Phase 5 #22).
    expect(group.attributes('data-layout')).toBe('columns');
    await group
      .findAll('button')
      .find((b) => b.text() === 'Cancel run')!
      .trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="action-done"]').text()).toBe(
      'Cancel requested: the worker stops the run.',
    );
  });
});

describe('focus inside the drawer when Cancel run takes the controls away', () => {
  it('moves to the drawer’s start, never to the page behind', async () => {
    const id = runOf('mcpVsBaseline', 'currency_mix', 'with-mcp', 5);
    ({ wrapper } = await mountDrawer('mcpVsBaseline', id));
    const before = await runsApi.getRun(id);
    vi.spyOn(runsApi, 'getRun').mockResolvedValue({ ...before, status: 'cancelled' });
    await wrapper
      .findAll('[data-testid="run-actions"] button')
      .find((b) => b.text() === 'Cancel run')!
      .trigger('click');
    const confirm = wrapper
      .get('[role="group"][aria-label="Cancel this run?"]')
      .findAll('button')
      .find((b) => b.text() === 'Cancel run')!;
    (confirm.element as HTMLElement).focus();
    await confirm.trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="group"][aria-label="Cancel this run?"]').exists()).toBe(false);
    expect(document.activeElement?.getAttribute('data-testid')).toBe('close-inspector');
  });
});

describe('cancelled (summary_file · with-mcp · rep 5)', () => {
  it('says it is not scored and keeps what the agent wrote', async () => {
    const id = runOf('mcpVsBaseline', 'summary_file', 'with-mcp', 5, 'cancelled');
    ({ wrapper } = await mountDrawer('mcpVsBaseline', id, { scenario: 'cancelled' }));
    expect(wrapper.get('[data-testid="run-status"]').text()).toBe('cancelled');
    expect(figuresOf(wrapper)[0]).toBe('Ran for 31 s');
    expect(figuresOf(wrapper)[2]).toMatch(/^Cancelled by experiment cancel, \d\d:\d\d:\d\d$/);
    expect(squash(wrapper.get('[data-testid="outcome-note"]').text())).toBe(
      'No scores. Cancelled runs are not scored and do not count toward pass rates or the interval.',
    );
    expect(wrapper.get('[data-testid="cancel-marker"]').text()).toContain(
      'Cancelled at 00:31 · experiment cancelled by user',
    );
    const artifacts = wrapper.get('[data-testid="section-artifacts"]');
    expect(artifacts.get('h2').text()).toContain('partial · written before the cancel');
    expect(artifacts.get('[data-testid="artifact-row"]').text()).toContain('written by agent');
    // The agent's file opens its preview by default.
    const preview = artifacts.get('[data-testid="artifact-preview"]');
    expect(preview.text()).toContain('Preview · summary.csv · CSV');
    expect(preview.text()).toContain('3 rows');
    expect(preview.text()).toContain('Brightline Freight');
    expect(wrapper.get('[data-testid="run-actions"]').text()).toBe('Copy run id');
  });
});

describe('ungradable (credit_notes · baseline · rep 2)', () => {
  it('puts the reason above the scores and highlights nothing', async () => {
    const id = runOf('skillVsNoSkill', 'credit_notes', 'baseline', 2);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id));
    const notice = wrapper.get('[data-testid="outcome-notice"]');
    expect(notice.attributes('data-tone')).toBe('warning');
    expect(notice.text()).toContain('no fenced JSON block found in final response');
    expect(notice.find('code').text()).toBe('```json');
    const rows = wrapper.findAll('[data-testid="score-row"]');
    expect(rows.map((r) => r.attributes('data-status'))).toEqual(['ungradable', 'passed']);
    expect(rows[0]!.text()).toContain('–');
    expect(wrapper.get('[data-testid="extraction-banner"]').text()).toBe(
      'No fenced JSON block found · score status ungradable',
    );
    expect(wrapper.find('[data-testid="json-highlight"]').exists()).toBe(false);
    expect(squash(wrapper.get('[data-testid="parsed-answer"]').text())).toContain(
      'Nothing parsed. The scorer needs a fenced ```json block, or a reply that is one JSON object.',
    );
  });
});

describe('scorer error (credit_notes · with-skill · rep 4)', () => {
  const id = () => runOf('skillVsNoSkill', 'credit_notes', 'with-skill', 4);

  it('draws the violet notice with the failed request and Re-score as the action', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id()));
    const notice = wrapper.get('[data-testid="outcome-notice"]');
    expect(notice.attributes('data-tone')).toBe('violet');
    expect(notice.text()).toContain('Scorer error: llm_judge could not reach the provider');
    expect(notice.text()).toContain(
      'POST https://inference-api.nousresearch.com/v1/chat/completions → 503 after 3 attempts',
    );
    expect(spaced(notice)).toContain(
      "Key method · the agent's output is stored · Re-score runs only the scorers",
    );
    const rescore = wrapper.get('[data-testid="rescore"]');
    expect(rescore.classes()).toContain('primary');
    const error = wrapper.findAll('[data-testid="score-row"]')[1]!;
    expect(error.attributes('data-status')).toBe('error');
    expect(error.get('[data-tone="err"]').text()).toBe('error');
  });

  it("opens the judge's evidence: model, calls, tokens and grading cost", async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id()));
    const toggle = wrapper
      .findAll('[data-testid="evidence-toggle"]')
      .find((t) => t.text().includes('judge'))!;
    expect(toggle.text()).toContain('Evidence · judge openai/gpt-6.1-sol · 0 tokens');
    await toggle.trigger('click');
    const judge = spaced(wrapper.get('[data-testid="judge-evidence"]'));
    expect(judge).toContain('Judge model openai/gpt-6.1-sol on nous');
    expect(judge).toContain('Calls 2 · 503 in 1.2 s, then 503 in 1.2 s');
    expect(judge).toContain('Grading cost');
  });

  it('re-scores: the header says which generation is queued', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id()));
    await wrapper.get('[data-testid="rescore"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="action-done"]').text()).toMatch(
      /^Re-score queued as generation \d+\. The scores below stay current until it publishes\.$/,
    );
  });
});

describe('scored after a retry (multi-attempt)', () => {
  it('shows attempt 2 of 2 and folds the earlier attempt into "Attempts (2)"', async () => {
    const id = runOf('skillVsNoSkill', 'disputed', 'baseline', 4, 'multi-attempt');
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id, { scenario: 'multi-attempt' }));
    expect(wrapper.get('[data-testid="tag"]').text()).toBe('rep 4 · attempt 2 of 2');
    expect(wrapper.get('[data-testid="run-status"]').text()).toBe('scored');
    expect(figuresOf(wrapper)[0]).toBe('Duration 1m 11s (attempt 2)');
    const toggle = wrapper.get('[data-testid="attempts-toggle"]');
    expect(squash(toggle.text())).toBe('Attempts (2) · attempt 1 execution_error · timeout');
    expect(wrapper.find('[data-testid="attempt-row"]').exists()).toBe(false);
    await toggle.trigger('click');
    expect(wrapper.findAll('[data-testid="attempt-row"]')).toHaveLength(2);
    expect(wrapper.get('[data-testid="section-outcome"] h2').text()).toContain('attempt 2');
  });
});

describe('an MCP run and a skill run', () => {
  it('tags the MCP tool calls and says where the server ran', async () => {
    const id = runOf('mcpVsBaseline', 'per_vendor', 'with-mcp', 4);
    ({ wrapper } = await mountDrawer('mcpVsBaseline', id));
    const mcp = wrapper.findAll('[data-testid="timeline-event"][data-look="mcp"]');
    expect(mcp.length).toBeGreaterThan(0);
    expect(mcp[0]!.get('.tag').text()).toBe('invoice-db');
    expect(wrapper.get('[data-testid="legend"]').text()).toContain('MCP tool');
    expect(wrapper.get('[data-testid="legend"]').text()).toContain(
      'MCP tool calls carry the server name and an accent tick.',
    );
    await wrapper.get('[data-testid="section-launch"] h2 button').trigger('click');
    const record = spaced(wrapper.get('[data-testid="launch-record"]'));
    expect(record).toContain("invoice-db v1 · stdio · started fresh inside this run's container");
    expect(record).toContain('INVOICE_DB_URL: <from env INVOICE_DB_URL>');
  });

  it('names the added skill with its content hash', async () => {
    const id = runOf('skillVsNoSkill', 'dup_invoices', 'with-skill', 3);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id));
    await wrapper.get('[data-testid="section-launch"] h2 button').trigger('click');
    const record = spaced(wrapper.get('[data-testid="launch-record"]'));
    expect(record).toMatch(/Skills invoice-method 1\.0\.0 · content hash sha256:[0-9a-f]{8}…/);
    expect(record).toContain("added on top of Hermes' built-in hermes-agent skill");
    expect(record).toContain('-s invoice-method');
  });
});

describe("a refusal on the agent's own call (currency_mix · with-skill · rep 2)", () => {
  it('hangs the red refusal under the terminal row', async () => {
    const id = runOf('skillVsNoSkill', 'currency_mix', 'with-skill', 2);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id));
    const row = wrapper.get('[data-testid="refusal-row"]');
    expect(spaced(row)).toBe('Refused by sandbox: example.com:443 , not on the allowlist');
    const event = wrapper
      .findAll('[data-testid="timeline-event"]')
      .find((e) => e.find('[data-testid="refusal-row"]').exists())!;
    expect(event.attributes('data-look')).toBe('error');
  });
});

describe('controls blocked by model access (nous-not-connected)', () => {
  it('disables Re-score with the judge it needs and a Connect link', async () => {
    const id = runOf('skillVsNoSkill', 'credit_notes', 'with-skill', 4);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id, { scenario: 'nous-not-connected' }));
    const rescore = wrapper.get('[data-testid="rescore"]');
    expect(rescore.attributes('disabled')).toBeDefined();
    expect(rescore.attributes('aria-description')).toBe(
      'Re-score needs Nous Portal for the method judge.',
    );
    const reason = wrapper.get('[data-testid="blocked-reason"]');
    expect(squash(reason.text())).toBe('Re-score needs Nous Portal for the method judge. Connect');
    expect(reason.get('code').text()).toBe('method');
  });

  it('disables Retry execution: Retry needs Nous Portal', async () => {
    const id = runOf('skillVsNoSkill', 'disputed', 'baseline', 4);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id, { scenario: 'nous-not-connected' }));
    expect(wrapper.get('[data-testid="retry"]').attributes('disabled')).toBeDefined();
    expect(squash(wrapper.get('[data-testid="blocked-reason"]').text())).toBe(
      'Retry needs Nous Portal. Connect',
    );
  });

  it('leaves Re-score alone when the task has no judge', async () => {
    const id = runOf('skillVsNoSkill', 'dup_invoices', 'baseline', 3);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id, { scenario: 'nous-not-connected' }));
    expect(wrapper.get('[data-testid="rescore"]').attributes('disabled')).toBeUndefined();
  });
});

describe('loading and load error', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('draws skeletons while the run loads', async () => {
    const id = runOf('skillVsNoSkill', 'dup_invoices', 'baseline', 3);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id, {
      scenario: 'loading',
      providers: false,
    }));
    expect(wrapper.get('[data-testid="inspector-loading"]').attributes('aria-busy')).toBe('true');
    expect(wrapper.find('[data-testid="section-outcome"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="close-inspector"]').exists()).toBe(true);
  });

  it('quotes the failed request, keeps Prev and Next, and retries', async () => {
    const id = runOf('skillVsNoSkill', 'dup_invoices', 'baseline', 3);
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id, {
      scenario: 'error',
      providers: false,
      siblings: ['run_a', id, 'run_c'],
    }));
    const banner = wrapper.get('[data-testid="inspector-error"]');
    expect(banner.text()).toContain('Could not load this run');
    expect(banner.text()).toContain(
      `GET /api/runs/${id} → 502 · upstream api:8080 connection refused`,
    );
    expect(banner.text()).toContain(
      'Only the drawer failed. Prev and next still work; Esc closes it.',
    );
    expect(wrapper.get('[data-testid="next-run"]').attributes('aria-disabled')).toBeUndefined();
    const load = vi.spyOn(runsApi, 'getRun');
    await banner.get('button').trigger('click');
    expect(load).toHaveBeenCalledWith(id);
  });
});
