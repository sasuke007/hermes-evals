/**
 * The experiment page's record and its live stream (UI_FLOWS 14.2). Live mode against a fake
 * EventSource and a fetch stub: the stream opens on GET /api/experiments/:id/events with its
 * named events, each event patches the record in place (rows never reorder), `run` events reach
 * the runs store and onRunEvent listeners, a status change refetches the record, and a drop
 * freezes the values. Fixtures mode draws the stream live, or reconnecting under stream-lost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import type { ExperimentEvent } from '@hermes-evals/shared';
import { FakeEventSource } from '@/composables/__tests__/fakeEventSource';
import { SSE_HIDDEN_CLOSE_MS } from '@/composables/useSse';
import { EXPERIMENT_IDS, experimentDetailFixture, findSeed } from '@/fixtures/experiments';
import { runListFixture } from '@/fixtures/runs';
import { setVisibility, useScenario } from './scenarioEnv';

const MVB = EXPERIMENT_IDS.mcpVsBaseline;
const SVN = EXPERIMENT_IDS.skillVsNoSkill;
const seed = findSeed(() => false, MVB)!;
const DETAIL = experimentDetailFixture(seed, 'v1');
const RUNS = runListFixture(seed);
const AT = '2026-10-23T15:24:00';

let detailGets = 0;
let runsGets = 0;

function stubApi(): void {
  detailGets = 0;
  runsGets = 0;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', async (input: string) => {
    const path = new URL(input, 'http://localhost').pathname;
    let body: unknown = {};
    if (path === `/api/experiments/${MVB}`) {
      detailGets++;
      body = DETAIL;
    } else if (path === `/api/experiments/${MVB}/runs`) {
      runsGets++;
      body = RUNS;
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
}

async function liveStores() {
  vi.stubEnv('VITE_API_MODE', 'live');
  vi.resetModules();
  const { useExperimentDetailStore } = await import('@/stores/experiment-detail');
  const { useRunsStore } = await import('@/stores/runs');
  setActivePinia(createPinia());
  return { detail: useExperimentDetailStore(), runs: useRunsStore() };
}

beforeEach(() => {
  FakeEventSource.reset();
  useScenario(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
});

describe('experiment-detail store, live', () => {
  it('opens the experiment stream and patches the record from its events', async () => {
    stubApi();
    const { detail, runs } = await liveStores();
    await detail.open(MVB);
    const es = FakeEventSource.last;
    expect(es.url).toBe(`/api/experiments/${MVB}/events`);
    es.open();
    expect(detail.liveState).toBe('live');
    expect(detail.current?.counts.scored).toBe(87);

    const emit = (event: ExperimentEvent) => es.emit(event.type, event);
    emit({
      type: 'counts',
      at: AT,
      counts: { ...DETAIL.counts, scored: 88, scoring: 0 },
      doneRuns: 88,
      spend: { ...DETAIL.spend, spentUsd: 1.23 },
    });
    expect(detail.current?.counts.scored).toBe(88);
    expect(detail.current?.spend.spentUsd).toBe(1.23);
    expect(detail.lastEventAt).toBe(AT);

    const entry = { ...DETAIL.feed[0]!, runId: 'run_new', taskKey: 'vat_split', finishedAt: AT };
    emit({ type: 'feed', at: AT, entry });
    expect(detail.current?.feed[0]?.runId).toBe('run_new');
    expect(detail.current?.feed).toHaveLength(10);
    expect(detail.arrivedRunIds).toEqual(['run_new']);

    // A run event reaches the runs table in place and every listener.
    await runs.load(MVB);
    const order = [...runs.order];
    const target = RUNS.rows.find((r) => r.status === 'execution_error')!;
    const heard: string[] = [];
    const stop = detail.onRunEvent((e) => heard.push(`${e.runId} ${e.status}`));
    emit({
      type: 'run',
      at: AT,
      runId: target.id,
      status: 'queued',
      attempt: target.attempts,
      primaryScore: null,
      finishedAt: null,
      generation: null,
      rescorePending: false,
    });
    stop();
    expect(heard).toEqual([`${target.id} queued`]);
    expect(runs.records[target.id]).toMatchObject({
      status: 'queued',
      durationS: null,
      executionErrorCategory: null,
    });
    expect(runs.order).toEqual(order);

    // A status change patches at once and refetches the record.
    const before = detailGets;
    emit({
      type: 'experiment',
      at: AT,
      status: 'paused',
      pauseReason: 'user',
      failure: null,
      verdicts: [],
      verdictUpdatedAt: null,
    });
    expect(detail.current?.status).toBe('paused');
    expect(detail.current?.pausedAt).toBe(AT);
    await vi.waitFor(() => expect(detailGets).toBe(before + 1));
  });

  it('drops an event that fails its schema', async () => {
    stubApi();
    const { detail } = await liveStores();
    await detail.open(MVB);
    FakeEventSource.last.open();
    FakeEventSource.last.emit('counts', { type: 'counts', at: AT, counts: { scored: -1 } });
    expect(detail.current?.counts.scored).toBe(87);
  });

  it('freezes on a drop and refetches on reconnect', async () => {
    vi.useFakeTimers();
    stubApi();
    const { detail } = await liveStores();
    await detail.open(MVB);
    FakeEventSource.last.open();
    const gets = detailGets;
    FakeEventSource.last.fail();
    expect(detail.liveState).toBe('reconnecting');
    expect(detail.frozen).toBe(true);
    expect(detail.liveIndicator).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    FakeEventSource.last.open();
    expect(detail.liveState).toBe('live');
    await vi.advanceTimersByTimeAsync(0);
    expect(detailGets).toBe(gets + 1);
  });

  it('opens one stream per experiment, also when moving from one to another', async () => {
    stubApi();
    const { detail } = await liveStores();
    await detail.open(MVB);
    await nextTick();
    expect(FakeEventSource.all.map((es) => es.closed)).toEqual([false]);
    await detail.open(SVN);
    await nextTick();
    expect(FakeEventSource.all.map((es) => es.url)).toEqual([
      `/api/experiments/${MVB}/events`,
      `/api/experiments/${SVN}/events`,
    ]);
    expect(FakeEventSource.last.closed).toBe(false);
  });

  it('refetches the Runs tab’s rows on reconnect, and counts the reconnect', async () => {
    vi.useFakeTimers();
    stubApi();
    const { detail, runs } = await liveStores();
    await detail.open(MVB);
    await runs.load(MVB);
    FakeEventSource.last.open();
    const before = runsGets;
    FakeEventSource.last.fail();
    await vi.advanceTimersByTimeAsync(1_000);
    FakeEventSource.last.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(runsGets).toBe(before + 1);
    expect(detail.reconnects).toBe(1);
  });

  it('refetches the record and the rows when a background tab shows again', async () => {
    vi.useFakeTimers();
    stubApi();
    const { detail, runs } = await liveStores();
    await detail.open(MVB);
    await runs.load(MVB);
    FakeEventSource.last.open();
    const gets = { detail: detailGets, runs: runsGets };
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(SSE_HIDDEN_CLOSE_MS);
    expect(detail.liveState).toBe('idle');
    setVisibility('visible');
    FakeEventSource.last.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(detail.liveState).toBe('live');
    expect(detailGets).toBe(gets.detail + 1);
    expect(runsGets).toBe(gets.runs + 1);
    expect(detail.reconnects).toBe(1);
  });

  it('closes the stream when the page leaves', async () => {
    stubApi();
    const { detail } = await liveStores();
    await detail.open(MVB);
    const es = FakeEventSource.last;
    detail.close();
    expect(es.closed).toBe(true);
    expect(detail.currentId).toBeNull();
    // The record stays for the next visit.
    expect(detail.records[MVB]).toBeDefined();
  });
});

describe('experiment-detail store, fixtures', () => {
  it('draws the stream live, and reconnecting under stream-lost', async () => {
    const { useExperimentDetailStore } = await import('@/stores/experiment-detail');
    setActivePinia(createPinia());
    const store = useExperimentDetailStore();
    await store.open(MVB);
    expect(store.liveState).toBe('live');
    expect(store.lastEventAt).toBe('2026-10-23T15:23:42');
    store.close();

    useScenario('stream-lost');
    await store.open(MVB);
    expect(store.liveState).toBe('reconnecting');
    expect(store.liveAttempt).toBe(3);
  });

  it('runs the controls and keeps their error', async () => {
    useScenario('paused-ceiling');
    const { useExperimentDetailStore } = await import('@/stores/experiment-detail');
    setActivePinia(createPinia());
    const store = useExperimentDetailStore();
    await store.open(MVB);
    expect(await store.resume()).toBe(false);
    expect(store.actionError).toEqual({
      action: 'resume',
      message: `POST /api/experiments/${MVB}/resume → 409 · raise the spend ceiling above $2.00 to resume`,
    });
    expect(await store.resume({ spendCeilingUsd: 3 })).toBe(true);
    expect(store.current).toMatchObject({ status: 'running', pauseReason: null, pausedAt: null });
    expect(store.actionError).toBeNull();
  });
});
