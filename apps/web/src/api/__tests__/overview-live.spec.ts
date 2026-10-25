/**
 * Live mode for the Overview and Runs tab calls: every answer is parsed with its shared schema
 * (an answer that does not match fails as a contract error, naming the field), state-changing
 * calls carry X-Requested-With, and the experiment stream has its path. Runs the data layer with
 * VITE_API_MODE=live against a fetch stub that answers with the fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { findSeed, experimentDetailFixture, EXPERIMENT_IDS } from '@/fixtures/experiments';
import { bulkRescoreFixture, bulkRetryFixture, runListFixture } from '@/fixtures/runs';
import type { ApiError } from '@/api/client';

const MVB = EXPERIMENT_IDS.mcpVsBaseline;
const seed = findSeed(() => false, MVB)!;
const DETAIL = experimentDetailFixture(seed, 'v1');
const RUNS = runListFixture(seed);

interface Sent {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
let sent: Sent[] = [];
let answer: (path: string, method: string) => unknown = () => ({});

beforeAll(() => {
  vi.stubEnv('VITE_API_MODE', 'live');
  vi.resetModules();
});
afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});
beforeEach(() => {
  sent = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    const method = init.method ?? 'GET';
    sent.push({
      method,
      path: url.pathname,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(answer(url.pathname, method)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

const live = async () => ({
  experiments: await import('@/api/experiments'),
  runs: await import('@/api/runs'),
});

describe('Overview and Runs calls in live mode', () => {
  it('parses the experiment detail, and refuses one that breaks the contract', async () => {
    const { experiments } = await live();
    answer = () => DETAIL;
    const detail = await experiments.getExperiment(MVB);
    expect(detail.counts.scored).toBe(87);
    expect(sent[0]).toMatchObject({ method: 'GET', path: `/api/experiments/${MVB}` });

    answer = () => ({ ...DETAIL, status: 'paused', pauseReason: null, pausedAt: null });
    const err = (await experiments.getExperiment(MVB).catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('contract');
    expect(err.message).toContain('pauseReason');
  });

  it('sends the controls with X-Requested-With and parses their answer', async () => {
    const { experiments } = await live();
    answer = (path) => ({ id: MVB, status: path.endsWith('/pause') ? 'paused' : 'running' });
    await expect(experiments.pauseExperiment(MVB)).resolves.toEqual({ id: MVB, status: 'paused' });
    await expect(experiments.resumeExperiment(MVB, { spendCeilingUsd: 3 })).resolves.toEqual({
      id: MVB,
      status: 'running',
    });
    await experiments.cancelExperiment(MVB);
    await experiments.retryFailedRuns(MVB);
    expect(sent.map((s) => `${s.method} ${s.path}`)).toEqual([
      `POST /api/experiments/${MVB}/pause`,
      `POST /api/experiments/${MVB}/resume`,
      `POST /api/experiments/${MVB}/cancel`,
      `POST /api/experiments/${MVB}/retry-failed`,
    ]);
    expect(sent.every((s) => s.headers['x-requested-with'] === 'hermes-evals')).toBe(true);
    expect(sent[1]!.body).toEqual({ spendCeilingUsd: 3 });

    answer = () => ({ id: MVB, status: 'stopped' });
    await expect(experiments.pauseExperiment(MVB)).rejects.toMatchObject({ kind: 'contract' });
  });

  it('names the experiment stream and its events', async () => {
    const { experiments } = await live();
    expect(experiments.experimentEventsPath(MVB)).toBe(`/experiments/${MVB}/events`);
    expect(experiments.EXPERIMENT_EVENT_NAMES).toEqual(['run', 'counts', 'experiment', 'feed']);
  });

  it('parses the Runs list and the bulk answers', async () => {
    const { runs } = await live();
    answer = () => RUNS;
    const list = await runs.listRuns(MVB, { hasExecutionError: true });
    expect(list.rows).toHaveLength(120);
    const ids = list.rows.slice(0, 2).map((r) => r.id);

    answer = () => bulkRescoreFixture(seed, ids, false);
    await expect(runs.rescoreRuns(MVB, ids)).resolves.toMatchObject({ action: 'rescore' });
    answer = () => bulkRetryFixture(seed, ids, false);
    await expect(runs.retryRuns(MVB, ids)).resolves.toMatchObject({ action: 'retry' });
    expect(sent.slice(1).every((s) => s.headers['x-requested-with'] === 'hermes-evals')).toBe(true);

    // An answer from an older API (no judgeKeysWithoutModel) fails loudly.
    answer = () => ({
      ...RUNS,
      rows: RUNS.rows.map((r) => ({
        ...r,
        needs: { ...r.needs, judgeKeysWithoutModel: undefined },
      })),
    });
    const err = (await runs.listRuns(MVB).catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('contract');
    expect(err.message).toContain('judgeKeysWithoutModel');
  });
});
