import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import * as runsApi from '@/api/runs';
import type { RunDetail, RunEventsPage, TimelineEvent } from '@/api/types/runs';
import { SAMPLE_RUN_ID } from '@/fixtures/experiments';
import { isUnsettled, mergeEvents, useInspectorStore } from '@/stores/inspector';
import { detailOf, runOf } from '@/components/inspector/__tests__/inspectorEnv';
import { useScenario } from './scenarioEnv';

beforeEach(() => {
  useScenario(null);
  setActivePinia(createPinia());
});
afterEach(() => vi.restoreAllMocks());

const event = (seq: number, summary = `e${seq}`): TimelineEvent => ({
  ...detailOf(SAMPLE_RUN_ID).timeline.events[7]!,
  seq,
  summary,
});

describe('mergeEvents', () => {
  it('replaces rows by seq and appends new ones, in seq order', () => {
    const merged = mergeEvents([event(1), event(2, 'running')], [event(3), event(2, 'done')]);
    expect(merged.map((e) => [e.seq, e.summary])).toEqual([
      [1, 'e1'],
      [2, 'done'],
      [3, 'e3'],
    ]);
  });
});

describe('isUnsettled', () => {
  it('holds while the run or a re-score is in flight', () => {
    const d = detailOf(SAMPLE_RUN_ID);
    expect(isUnsettled(d)).toBe(false);
    expect(isUnsettled({ ...d, status: 'running' })).toBe(true);
    const pending = {
      evaluationId: 'ev',
      generation: 2,
      status: 'queued' as const,
      cause: 'rescore' as const,
      requestedAt: '2026-10-23T15:40:00',
    };
    expect(isUnsettled({ ...d, evaluation: { ...d.evaluation, pending } })).toBe(true);
  });
});

describe('load and refreshEvents', () => {
  const live = () => runOf('mcpVsBaseline', 'currency_mix', 'with-mcp', 5);

  it('keeps the detail by id and polls on from its last row', async () => {
    const store = useInspectorStore();
    await store.load(live());
    expect(store.runs[live()]?.timeline.events).toHaveLength(14);
    const spy = vi.spyOn(runsApi, 'listRunEvents').mockResolvedValue({
      events: [{ ...event(14), running: false, summary: 'done' }, event(15)],
      lastSeq: 16,
      live: true,
    });
    await store.refreshEvents(live());
    expect(spy).toHaveBeenCalledWith(live(), 14);
    const events = store.runs[live()]!.timeline.events;
    expect(events.map((e) => e.seq).slice(-2)).toEqual([14, 15]);
    expect(events[13]!.summary).toBe('done');
    await store.refreshEvents(live());
    expect(spy).toHaveBeenLastCalledWith(live(), 16);
  });

  it('reloads the detail when the events say the run is no longer live', async () => {
    const store = useInspectorStore();
    await store.load(live());
    vi.spyOn(runsApi, 'listRunEvents').mockResolvedValue({ events: [], lastSeq: 14, live: false });
    const load = vi.spyOn(runsApi, 'getRun');
    await store.refreshEvents(live());
    expect(load).toHaveBeenCalledWith(live());
  });

  it('starts over from 0 when a new attempt is shown', async () => {
    const store = useInspectorStore();
    const first = detailOf(live());
    const second: RunDetail = {
      ...first,
      shownAttempt: 2,
      attemptCount: 2,
      timeline: { ...first.timeline, events: [] },
    };
    const get = vi.spyOn(runsApi, 'getRun').mockResolvedValueOnce(first);
    await store.load(live());
    get.mockResolvedValueOnce(second);
    await store.load(live());
    const spy = vi
      .spyOn(runsApi, 'listRunEvents')
      .mockResolvedValue({ events: [event(1)], lastSeq: 1, live: true });
    await store.refreshEvents(live());
    expect(spy).toHaveBeenCalledWith(live(), 0);
    expect(store.runs[live()]!.timeline.events.map((e) => e.seq)).toEqual([1]);
  });

  it('drops a page of the old attempt that arrives after the new one is shown', async () => {
    const store = useInspectorStore();
    const first = detailOf(live());
    const second: RunDetail = {
      ...first,
      shownAttempt: 2,
      attemptCount: 2,
      timeline: { ...first.timeline, events: [] },
    };
    const get = vi.spyOn(runsApi, 'getRun').mockResolvedValueOnce(first);
    await store.load(live());
    // An automatic retry while the drawer polls: attempt 1's page is still on its way.
    let deliver: (page: RunEventsPage) => void = () => {};
    const list = vi
      .spyOn(runsApi, 'listRunEvents')
      .mockImplementationOnce(() => new Promise<RunEventsPage>((resolve) => (deliver = resolve)));
    const pending = store.refreshEvents(live());
    get.mockResolvedValueOnce(second);
    await store.load(live());
    deliver({
      events: Array.from({ length: 20 }, (_, i) => event(i + 1)),
      lastSeq: 20,
      live: true,
    });
    await pending;
    expect(store.runs[live()]!.timeline.events).toEqual([]);
    list.mockResolvedValue({ events: [], lastSeq: 0, live: true });
    await store.refreshEvents(live());
    expect(list).toHaveBeenLastCalledWith(live(), 0);
  });

  it('keeps the failure message for the banner', async () => {
    useScenario('error');
    const store = useInspectorStore();
    await store.load(SAMPLE_RUN_ID);
    expect(store.errors[SAMPLE_RUN_ID]).toBe(
      `GET /api/runs/${SAMPLE_RUN_ID} → 502 · upstream api:8080 connection refused`,
    );
    expect(store.loading[SAMPLE_RUN_ID]).toBe(false);
  });
});

describe('order, position and the A/B jump', () => {
  it('says where a run sits in the order and steps through it', () => {
    const store = useInspectorStore();
    store.setOrder({
      experimentId: 'exp',
      source: 'Comparison',
      order: 'grid order',
      ids: ['a', 'b', 'c'],
    });
    expect(store.positionOf('b')).toEqual({ label: 'Comparison · grid order', run: 'run 2 of 3' });
    expect(store.neighbours('b')).toEqual({ prev: 'a', next: 'c' });
    expect(store.neighbours('a').prev).toBeNull();
    expect(store.positionOf('x')).toBeNull();
    store.setOrder({ ...store.order!, note: 'opened from the feed' });
    expect(store.positionOf('a')?.run).toBe('opened from the feed');
  });

  it('reads "A/B jump from" after the jump and steps on from where it started', () => {
    const store = useInspectorStore();
    store.setOrder({
      experimentId: 'exp',
      source: 'Comparison',
      order: 'grid order',
      ids: ['a', 'b', 'c'],
    });
    store.recordJump('b', 'twin', 'baseline');
    expect(store.positionOf('twin')).toEqual({
      label: 'Comparison · A/B jump from',
      run: 'run 2 (baseline)',
    });
    expect(store.neighbours('twin')).toEqual({ prev: 'a', next: 'c' });
    // Jumping straight back ends the jump.
    store.recordJump('twin', 'b', 'with-skill');
    expect(store.jump).toBeNull();
    store.recordJump('b', 'twin', 'baseline');
    store.clearJump();
    expect(store.positionOf('twin')).toBeNull();
  });

  it("falls back to the experiment's runs once, unless the page sets an order", async () => {
    const store = useInspectorStore();
    const spy = vi.spyOn(runsApi, 'listRuns');
    const exp = detailOf(SAMPLE_RUN_ID).experimentId;
    await store.ensureOrder(exp, 'Runs');
    await store.ensureOrder(exp, 'Runs');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.order).toMatchObject({ source: 'Runs', order: 'all runs', fallback: true });
    expect(store.order?.ids).toHaveLength(120);
    expect(store.order?.ids).toContain(SAMPLE_RUN_ID);
  });
});

describe('actions', () => {
  it('re-scores and reloads the detail', async () => {
    const store = useInspectorStore();
    const id = runOf('skillVsNoSkill', 'credit_notes', 'with-skill', 4);
    const load = vi.spyOn(runsApi, 'getRun');
    const result = await store.rescore(id);
    expect(result.evaluation.cause).toBe('rescore');
    expect(load).toHaveBeenCalledWith(id);
  });

  it('passes on a refusal', async () => {
    const store = useInspectorStore();
    await expect(store.retry(SAMPLE_RUN_ID)).rejects.toThrow(
      `POST /api/runs/${SAMPLE_RUN_ID}/retry → 409 · run is scored, not execution_error`,
    );
  });
});
