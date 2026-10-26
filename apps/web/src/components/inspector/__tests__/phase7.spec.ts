/**
 * The inspector's Phase 7 follow-ups: the whole stderr.log behind "Full log" (Phase 5 section
 * 6.1), json_match's evidence key by key, Hermes's background requests and an MCP server's
 * 405 to the event-stream GET drawn neutral (Phase 5 question 19, Phase 6 question 15), and
 * the 20,000-character window of MCP results (Phase 6 question 13).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import * as runsApi from '@/api/runs';
import type { JsonMatchEvidence, ScoreEvidenceView, TimelineEvent } from '@/api/types/runs';
import { useScenario } from '@/stores/__tests__/scenarioEnv';
import EventTimeline from '../EventTimeline.vue';
import ScoreEvidence from '../ScoreEvidence.vue';
import TimelineEventRow from '../TimelineEventRow.vue';
import { eventLook, outputNote, timelineCounts } from '../inspectorFormat';
import { hasJsonMismatch, jsonMatchCaption, jsonMatchRows } from '../jsonMatchRows';
import { detailOf, mountDrawer, runOf, spaced, squash } from './inspectorEnv';

let wrapper: VueWrapper | null = null;
beforeEach(() => {
  useScenario(null);
  setActivePinia(createPinia());
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Full log (GET /runs/:id/attempts/:n/stderr)', () => {
  const id = () => runOf('skillVsNoSkill', 'disputed', 'baseline', 4);

  it("reads the shown attempt's whole log and shows it in place, then goes back to the tail", async () => {
    const read = vi.spyOn(runsApi, 'getAttemptStderr');
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id()));
    const caption = () => squash(wrapper!.get('[data-testid="stderr-caption"]').text());
    expect(caption()).toBe('stderr · last 6 of 1,204 lines');
    await wrapper.get('[data-testid="full-log"]').trigger('click');
    await flushPromises();
    expect(read).toHaveBeenCalledWith(id(), 2);
    expect(caption()).toMatch(/^stderr · all 1,204 lines · \d+(\.\d)? KB$/);
    const full = wrapper.get('[data-testid="stderr-full"]').text();
    expect(full.split('\n')).toHaveLength(1204);
    expect(full.startsWith('[step 1] ')).toBe(true);
    expect(full.endsWith('hermes: exit 124 (timeout)')).toBe(true);
    expect(wrapper.find('[aria-label="Copy the full log"]').exists()).toBe(true);
    await wrapper.get('[data-testid="stderr-tail-button"]').trigger('click');
    expect(caption()).toBe('stderr · last 6 of 1,204 lines');
    expect(wrapper.find('[data-testid="stderr-full"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="full-log"]').text()).toBe('Full log');
  });

  it('downloads the log as a .log file', async () => {
    const created: Blob[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (blob: Blob) => {
        created.push(blob);
        return 'blob:stderr';
      },
      revokeObjectURL: () => {},
    });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id()));
    await wrapper.get('[data-testid="full-log"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-testid="stderr-download"]').trigger('click');
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe(`stderr-${id()}-attempt-2.log`);
    expect(clicked[0]!.href).toBe('blob:stderr');
    expect(await created[0]!.text()).toContain('hermes: exit 124 (timeout)');
  });

  it('says when only the end of a long log came back (stderr-long)', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id(), { scenario: 'stderr-long' }));
    await wrapper.get('[data-testid="full-log"]').trigger('click');
    await flushPromises();
    expect(squash(wrapper.get('[data-testid="stderr-caption"]').text())).toBe(
      'stderr · last 1 MB of 3.3 MB · 48,213 lines in all',
    );
    expect(wrapper.get('[data-testid="stderr-full"]').text()).toContain(
      'hermes: exit 124 (timeout)',
    );
  });

  it('keeps the tail and says why when the log is gone (stderr-missing)', async () => {
    ({ wrapper } = await mountDrawer('skillVsNoSkill', id(), { scenario: 'stderr-missing' }));
    await wrapper.get('[data-testid="full-log"]').trigger('click');
    await flushPromises();
    const error = wrapper.get('[data-testid="full-log-error"]');
    expect(error.attributes('role')).toBe('alert');
    expect(squash(error.text())).toBe(
      'No full log is stored for attempt 2: it wrote nothing more, or it ended before the worker kept full logs. The tail below is stored with the run.',
    );
    expect(wrapper.get('[data-testid="stderr-tail"]').text()).toContain('exit 124');
    expect(wrapper.get('[data-testid="full-log"]').attributes('disabled')).toBeUndefined();
  });
});

describe('json_match evidence key by key', () => {
  const empty: ScoreEvidenceView = {
    eventSeqs: [],
    artifactIds: [],
    judge: null,
    trajectory: null,
    text: null,
    jsonMatch: null,
  };
  /** The board's partial credit sample (RunInspectorStates › JSON match with partial credit). */
  const board: JsonMatchEvidence = {
    unit: 'keys',
    matched: 4,
    total: 5,
    mismatches: ['Granite Office'],
    path: 'overdue_by_vendor',
    entries: [
      { path: 'Fjord Software', expected: 3, observed: 3, match: true },
      { path: 'Granite Office', expected: 2, observed: 3, match: false },
      { path: 'Helios Energy', expected: 4, observed: 4, match: true },
      { path: 'Cobalt Print Co', expected: 1, observed: 1, match: true },
      { path: 'Nordlys Freight', expected: 7, observed: 7, match: true },
    ],
  };

  it('draws the board: each key with its value, a mismatch with both, and where it compared', () => {
    wrapper = mount(ScoreEvidence, { props: { evidence: { ...empty, jsonMatch: board } } });
    expect(spaced(wrapper.get('[data-testid="json-match-table"]'))).toBe(
      [
        '✓ Fjord Software matches 3',
        '✗ Granite Office does not match expected 2, got 3',
        '✓ Helios Energy matches 4',
        '✓ Cobalt Print Co matches 1',
        '✓ Nordlys Freight matches 7',
      ].join(' '),
    );
    const caption = wrapper.get('[data-testid="json-match-caption"]');
    expect(squash(caption.text())).toBe(
      'Compared at overdue_by_vendor against the reference, key by key. The score is the share of keys that match.',
    );
    expect(caption.get('code').text()).toBe('overdue_by_vendor');
  });

  it('says what is missing from the answer and what only the answer has', () => {
    const rows = jsonMatchRows({
      unit: 'items',
      matched: 1,
      total: 2,
      mismatches: ['[1]', '[2]'],
      path: null,
      entries: [
        { path: '[0]', expected: 'INV-1042', observed: 'INV-1042', match: true },
        { path: '[1]', expected: 'INV-1107', match: false },
        { path: '[2]', observed: { id: 'INV-9' }, match: false },
      ],
    });
    expect(rows).toEqual([
      { label: '[0]', match: true, note: '"INV-1042"' },
      { label: '[1]', match: false, note: 'expected "INV-1107", missing from the answer' },
      { label: '[2]', match: false, note: 'not in the reference, got {"id": "INV-9"}' },
    ]);
  });

  it('names a value compared whole, and opens its expander on a mismatch', () => {
    const value: JsonMatchEvidence = {
      unit: 'value',
      matched: 0,
      total: 1,
      mismatches: [],
      path: 'total_due',
      entries: [{ path: '', expected: 48213.65, observed: 48526.05, match: false }],
    };
    expect(jsonMatchRows(value)).toEqual([
      { label: 'value', match: false, note: 'expected 48213.65, got 48526.05' },
    ]);
    expect(jsonMatchCaption(value)).toBe(
      'Compared at `total_due` with the reference as one value.',
    );
    expect(hasJsonMismatch(value)).toBe(true);
    expect(hasJsonMismatch({ ...value, entries: [{ path: '', match: true }] })).toBe(false);
  });

  it('shows the first 20 rows and every mismatch until Show all', async () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      path: `vendor_${i}`,
      expected: i,
      observed: i === 25 ? -1 : i,
      match: i !== 25,
    }));
    const many: JsonMatchEvidence = {
      unit: 'keys',
      matched: 29,
      total: 30,
      mismatches: ['vendor_25'],
      path: null,
      entries,
    };
    wrapper = mount(ScoreEvidence, { props: { evidence: { ...empty, jsonMatch: many } } });
    const labels = () =>
      wrapper!
        .findAll('[data-testid="json-match-table"] .font-mono')
        .map((s) => s.text().replace(/ (does not )?match(es)?$/, ''));
    expect(labels()).toHaveLength(21);
    expect(labels()[20]).toBe('vendor_25');
    const more = wrapper.get('[data-testid="json-match-show-all"]');
    expect(squash(more.text())).toBe('Show all 30 keys (9 more that match)');
    await more.trigger('click');
    expect(labels()).toHaveLength(30);
    expect(wrapper.find('[data-testid="json-match-show-all"]').exists()).toBe(false);
  });

  it('fills every fixture json_match with its entries, counted like the scorer', () => {
    const detail = detailOf(runOf('skillVsNoSkill', 'dup_invoices', 'baseline', 3));
    const answer = detail.scores.find((s) => s.key === 'answer')!.evidence.jsonMatch!;
    expect(answer.path).toBe('duplicates');
    expect(answer.entries?.map((e) => [e.path, e.match])).toEqual([
      ['[0]', false],
      ['[1]', false],
    ]);
    expect(answer.mismatches).toEqual(['[0]', '[1]']);
  });
});

describe('neutral rows: Hermes background and the MCP event stream', () => {
  const row = (partial: Partial<TimelineEvent>): TimelineEvent => ({
    ...detailOf(runOf('skillVsNoSkill', 'dup_invoices', 'baseline', 3)).timeline.events[0]!,
    ...partial,
  });

  it('draws every background row neutral, refused or allowed, even with an error flag', () => {
    expect(eventLook(row({ kind: 'refused', origin: 'hermes-background', error: true }))).toBe(
      'refused',
    );
    const allowed = row({
      kind: 'network',
      origin: 'hermes-background',
      error: true,
      network: { ...row({}).network!, decision: 'allowed', status: 404 },
    });
    expect(eventLook(allowed)).toBe('net');
    expect(eventLook({ ...allowed, origin: 'agent' })).toBe('error');
    expect(timelineCounts([allowed])).toBe(
      '1 event · 0 tool calls · 0 model calls · 1 other network call · 0 refused connections · no errors',
    );
  });

  it('adds hermes-agent and raw.githubusercontent.com rows, tagged and neutral (hermes-background)', () => {
    const id = runOf('skillVsNoSkill', 'per_vendor', 'with-skill', 1);
    const events = detailOf(id, 'hermes-background').timeline.events;
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const background = events.filter((e) => e.origin === 'hermes-background');
    expect(background.map((e) => e.summary)).toEqual([
      'inference-api.nousresearch.com:443',
      'hermes-agent.nousresearch.com:443',
      'raw.githubusercontent.com:443',
    ]);
    wrapper = mount(EventTimeline, { props: { events, open: new Set<number>() } });
    const rows = wrapper
      .findAll('[data-testid="timeline-event"]')
      .filter((r) => r.text().includes('Hermes background'));
    expect(rows.map((r) => r.attributes('data-look'))).toEqual(['refused', 'refused', 'net']);
    expect(rows.every((r) => !r.text().includes('error'))).toBe(true);
  });

  it('draws the 405 to the event-stream GET as "MCP event stream not offered · 405" (mcp-http)', async () => {
    const id = runOf('mcpVsBaseline', 'per_vendor', 'with-mcp', 1);
    const events = detailOf(id, 'mcp-http').timeline.events;
    const stream = events.find((e) => e.network?.status === 405)!;
    wrapper = mount(TimelineEventRow, { props: { event: stream, open: true } });
    expect(wrapper.attributes('data-look')).toBe('net');
    expect(wrapper.get('[data-testid="event-title"]').text()).toBe('MCP event stream not offered');
    expect(wrapper.get('[data-testid="event-summary"]').text()).toBe('vendor-directory · 405');
    expect(wrapper.get('button').text()).not.toMatch(/\berror\b/);
    expect(squash(wrapper.get('[data-testid="event-detail"]').text())).toBe(
      "vendor-directory offers no event stream: it answered the MCP client's GET with 405, as the protocol allows. Its tools are called over POST, so the run is not affected.",
    );
    // An event stored before the API titled it (an error-flagged "MCP call") is drawn the same.
    const older = { ...stream, title: 'MCP call', error: true, text: null };
    await wrapper.setProps({ event: older });
    expect(wrapper.attributes('data-look')).toBe('net');
    expect(wrapper.get('[data-testid="event-title"]').text()).toBe('MCP event stream not offered');
    expect(wrapper.get('button').text()).not.toMatch(/\berror\b/);
    expect(squash(wrapper.get('[data-testid="event-detail"]').text())).toMatch(
      /^vendor-directory offers no event stream/,
    );
    // Any other 4xx from an MCP server is still an error.
    const failed = {
      ...stream,
      error: true,
      network: { ...stream.network!, method: 'POST', status: 404 },
    };
    expect(eventLook(failed)).toBe('error');
  });

  it("keeps 20,000 characters of an MCP tool's result and 5,000 of any other (mcp-http)", () => {
    const id = runOf('mcpVsBaseline', 'per_vendor', 'with-mcp', 1);
    const events = detailOf(id, 'mcp-http').timeline.events;
    const search = events.find((e) => e.title === 'search_vendors')!;
    expect(search.output).toHaveLength(20_000);
    expect(outputNote(search)).toBe(
      '31,204 characters · Truncated by the runtime at 20,000 characters.',
    );
    wrapper = mount(TimelineEventRow, { props: { event: search, open: true } });
    expect(wrapper.get('[data-testid="event-detail"]').text()).toContain(
      'Truncated by the runtime at 20,000 characters.',
    );
    // Hermes cut it at 5,000 and "..." before the worker read it: not the timeline's window.
    expect(outputNote({ ...search, outputChars: 5_003, truncated: true })).toBe(
      "5,003 characters · Truncated by Hermes at 5,000 characters before the run's events were recorded.",
    );
    const tool: TimelineEvent = { ...search, server: null, outputChars: 742, truncated: false };
    expect(outputNote(tool)).toBe(
      '742 characters · not truncated. Output beyond 5,000 characters is truncated by the runtime and marked here.',
    );
  });
});
