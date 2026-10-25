import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ApiError } from '@/api/client';
import { EXPERIMENT_IDS } from '@/api/experiments';
import * as runsApi from '@/api/runs';
import { RUNS_REFRESH_DELAY_MS, useRunsStore } from '@/stores/runs';
import { useScenario } from './scenarioEnv';

const SVN = EXPERIMENT_IDS.skillVsNoSkill;

beforeEach(() => {
  useScenario(null);
  setActivePinia(createPinia());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runs store', () => {
  it('loads one experiment as records keyed by id in the API order', async () => {
    const runs = useRunsStore();
    await runs.load(SVN, { sort: 'duration', dir: 'desc' });
    expect(runs.rows).toHaveLength(120);
    expect(Object.keys(runs.records)).toHaveLength(120);
    expect(runs.rows[0]!.durationS).toBe(300);
    expect(runs.summary).toMatchObject({ total: 120, passed: 89, executionErrors: 1 });
    expect(runs.loaded).toBe(true);
    expect(runs.error).toBeNull();
  });

  it('patches a row in place from a run event, keeping the order', async () => {
    const runs = useRunsStore();
    await runs.load(SVN);
    const order = [...runs.order];
    const row = runs.rows[5]!;
    runs.applyRunEvent({
      type: 'run',
      at: '2026-10-23T15:00:00',
      runId: row.id,
      status: 'scored',
      attempt: 1,
      primaryScore: { key: 'answer', status: 'failed', score: 0 },
      finishedAt: '2026-10-23T15:00:00',
      generation: 2,
      rescorePending: false,
    });
    expect(runs.records[row.id]).toMatchObject({
      generation: 2,
      primaryScore: { status: 'failed' },
      durationS: row.durationS,
    });
    expect(runs.order).toEqual(order);
  });

  it('keeps the measured columns of a run that moved on to scoring, and reloads them soon', async () => {
    vi.useFakeTimers();
    const runs = useRunsStore();
    await runs.load(SVN);
    const row = runs.rows.find((r) => r.status === 'scored' && r.durationS !== null)!;
    const list = vi.spyOn(runsApi, 'listRuns');
    runs.applyRunEvent({
      type: 'run',
      at: '2026-10-23T15:00:00',
      runId: row.id,
      status: 'scoring',
      attempt: row.attempts,
      primaryScore: null,
      finishedAt: row.finishedAt,
      generation: row.generation,
      rescorePending: false,
    });
    expect(runs.records[row.id]).toMatchObject({
      status: 'scoring',
      durationS: row.durationS,
      tokens: row.tokens,
      costUsd: row.costUsd,
    });
    await vi.advanceTimersByTimeAsync(RUNS_REFRESH_DELAY_MS);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('clears the measured columns of a run that went back to queued or running', async () => {
    const runs = useRunsStore();
    await runs.load(SVN);
    const row = runs.rows.find((r) => r.status === 'execution_error')!;
    runs.applyRunEvent({
      type: 'run',
      at: '2026-10-23T15:00:00',
      runId: row.id,
      status: 'running',
      attempt: row.attempts + 1,
      primaryScore: null,
      finishedAt: null,
      generation: row.generation,
      rescorePending: false,
    });
    expect(runs.records[row.id]).toMatchObject({
      status: 'running',
      executionErrorCategory: null,
      durationS: null,
      tokens: null,
      costUsd: null,
    });
  });

  it('keeps the rows shown, in their order, on a quiet reload', async () => {
    const runs = useRunsStore();
    await runs.load(SVN);
    const reversed = [...runs.order].reverse();
    runs.order = reversed;
    await runs.refresh();
    expect(runs.order).toEqual(reversed);
    // A new filter reloads in the API's order.
    await runs.load(SVN, { configuration: 'with-skill' });
    expect(runs.rows).toHaveLength(60);
    expect(runs.rows[0]!.taskKey).toBe('total_due');
  });

  it('keeps the last good rows when a reload fails', async () => {
    const runs = useRunsStore();
    await runs.load(SVN);
    useScenario('error');
    await runs.refresh();
    expect(runs.error).toBe(
      `GET /api/experiments/${SVN}/runs → 502 · upstream api:8080 connection refused`,
    );
    expect(runs.rows).toHaveLength(120);
  });

  it('marks accepted re-scores pending and lists the refused ones', async () => {
    const runs = useRunsStore();
    await runs.load(SVN);
    const scored = runs.rows.find((r) => r.status === 'scored')!;
    const errored = runs.rows.find((r) => r.status === 'execution_error')!;
    const result = await runs.rescore([scored.id, errored.id]);
    expect(result?.enqueued).toEqual([scored.id]);
    expect(runs.records[scored.id]!.rescorePending).toBe(true);
    expect(runs.outcome).toEqual({
      action: 'rescore',
      requested: 2,
      enqueued: [scored.id],
      refused: [{ runId: errored.id, reason: 'run is execution_error, not scored' }],
    });
    await runs.retry([errored.id]);
    expect(runs.records[errored.id]).toMatchObject({ status: 'queued', durationS: null });
    expect(runs.outcome?.action).toBe('retry');
    runs.dismissOutcome();
    expect(runs.outcome).toBeNull();
  });

  it('keeps the fields a refused bulk request names (a 400’s issues)', async () => {
    const runs = useRunsStore();
    await runs.load(SVN);
    vi.spyOn(runsApi, 'rescoreRuns').mockRejectedValue(
      new ApiError(400, `POST /api/experiments/${SVN}/runs/rescore`, 'Validation failed', [
        { path: 'runIds', message: 'select at most 500 runs' },
      ]),
    );
    expect(await runs.rescore([runs.rows[0]!.id])).toBeNull();
    expect(runs.bulkError).toEqual({
      action: 'rescore',
      message: `POST /api/experiments/${SVN}/runs/rescore → 400 · Validation failed`,
      issues: 'runIds: select at most 500 runs',
    });
  });

  it('forgets everything on reset', async () => {
    const runs = useRunsStore();
    await runs.load(SVN);
    runs.reset();
    expect(runs.rows).toEqual([]);
    expect(runs.experimentId).toBeNull();
    expect(runs.loaded).toBe(false);
  });
});
