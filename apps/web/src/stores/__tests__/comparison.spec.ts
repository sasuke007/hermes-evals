import type { RunStatusEvent } from '@hermes-evals/shared';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useScenario } from './scenarioEnv';
import { EXPERIMENT_IDS } from '@/fixtures/experiments';
import { LIVE_REFRESH_MS, useComparisonStore } from '@/stores/comparison';

const SVNS = EXPERIMENT_IDS.skillVsNoSkill;
const PRIMARY = { candidate: null, key: 'primary' };

function runEvent(runId: string, over: Partial<RunStatusEvent> = {}): RunStatusEvent {
  return {
    type: 'run',
    at: '2026-10-25T15:00:00Z',
    runId,
    status: 'running',
    attempt: 2,
    primaryScore: null,
    finishedAt: null,
    generation: null,
    rescorePending: false,
    ...over,
  };
}

beforeEach(() => {
  useScenario(null);
  setActivePinia(createPinia());
});
afterEach(() => {
  vi.useRealTimers();
});

describe('comparison store', () => {
  it('loads the view for a selection and keeps it between visits', async () => {
    const store = useComparisonStore();
    const pending = store.load(SVNS, PRIMARY);
    expect(store.records[SVNS]?.loading).toBe(true);
    await pending;
    const record = store.records[SVNS]!;
    expect(record.loading).toBe(false);
    expect(record.view?.candidate.name).toBe('with-skill');
    expect(record.viewSelection).toEqual(PRIMARY);
    expect(record.loadedAt).not.toBeNull();
  });

  it('lets the newest selection win over one still loading', async () => {
    const store = useComparisonStore();
    const first = store.load(EXPERIMENT_IDS.skillMcp, PRIMARY);
    const second = store.load(EXPERIMENT_IDS.skillMcp, { candidate: 'with-mcp', key: 'primary' });
    await Promise.all([first, second]);
    const record = store.records[EXPERIMENT_IDS.skillMcp]!;
    expect(record.view?.candidate.name).toBe('with-mcp');
    expect(record.viewSelection?.candidate).toBe('with-mcp');
  });

  it('keeps the last good view when a refresh fails', async () => {
    const store = useComparisonStore();
    await store.load(SVNS, PRIMARY);
    useScenario('error');
    await store.refresh(SVNS);
    const record = store.records[SVNS]!;
    expect(String(record.error)).toContain('GET /api/experiments/');
    expect(record.view?.rows).toHaveLength(12);
  });

  it('patches a cell from a run event and refetches once, keeping the rows in place', async () => {
    vi.useFakeTimers();
    const store = useComparisonStore();
    await store.load(SVNS, PRIMARY);
    const view = store.records[SVNS]!.view!;
    // Reverse the order on screen: a live refetch must keep it.
    view.rows = [...view.rows].reverse();
    const order = view.rows.map((r) => r.taskKey);
    const cell = view.rows[view.rows.length - 1]!.baseline[0]!;

    store.applyRunEvent(SVNS, runEvent(cell.runId));
    expect([cell.runStatus, cell.scoreStatus, cell.attempt, cell.durationS]).toEqual([
      'running',
      null,
      2,
      null,
    ]);
    store.applyRunEvent(
      SVNS,
      runEvent(cell.runId, {
        status: 'scored',
        primaryScore: { key: 'answer', status: 'passed', score: 1 },
      }),
    );
    expect([cell.runStatus, cell.scoreStatus]).toEqual(['scored', 'passed']);

    await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS);
    const after = store.records[SVNS]!.view!;
    expect(after).not.toBe(view);
    expect(after.rows.map((r) => r.taskKey)).toEqual(order);

    store.resort(SVNS);
    expect(store.records[SVNS]!.view!.rows[0]!.taskKey).toBe('dup_invoices');
  });

  it('ignores events of runs it does not show', async () => {
    vi.useFakeTimers();
    const store = useComparisonStore();
    store.applyRunEvent(SVNS, runEvent('run_unknown'));
    await store.load(SVNS, PRIMARY);
    const before = store.records[SVNS]!.view;
    store.applyRunEvent(SVNS, runEvent('run_unknown'));
    await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS * 2);
    expect(store.records[SVNS]!.view).toBe(before);
  });

  it('drops a pending refetch when the page leaves', async () => {
    vi.useFakeTimers();
    const store = useComparisonStore();
    await store.load(SVNS, PRIMARY);
    const before = store.records[SVNS]!.view;
    store.scheduleRefresh(SVNS);
    store.release(SVNS);
    await vi.advanceTimersByTimeAsync(LIVE_REFRESH_MS * 2);
    expect(store.records[SVNS]!.view).toBe(before);
  });
});
