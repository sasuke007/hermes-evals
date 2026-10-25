/**
 * GET /experiments/:id/runs on PGlite with the real triggers: an experiment
 * whose 20 runs sit in every state (run-states-spec.ts), filtered and
 * sorted the way the Runs tab asks, through the shared query schema.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RunListQuerySchema, RunListResultSchema, type RunListResult } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { RunViewsService } from './run-views.service.js';
import { seedAllStates, type AllStates } from './run-states-spec.js';
import { viewsConfig } from './run-fixtures-spec.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let seed: AllStates;
let views: RunViewsService;

beforeAll(async () => {
  t = await createTestDatabase();
  seed = await seedAllStates(t.db);
  views = new RunViewsService(t.db, seed.store, viewsConfig());
});

afterAll(async () => {
  await t.close();
  await seed.dispose();
});

/** The list for a query string as the web sends it, parsed with the shared schemas both ways. */
async function list(query: Record<string, string> = {}): Promise<RunListResult> {
  const result = await views.list(seed.experimentId, RunListQuerySchema.parse(query));
  return RunListResultSchema.parse(result);
}

const names = (result: RunListResult) =>
  result.rows.map((r) => `${r.taskKey}/${r.configuration.name}/${r.repetition}`);

describe('rows', () => {
  it('lists every run in matrix order and counts the whole experiment', async () => {
    const result = await list();
    expect(result.matched).toBe(20);
    expect(names(result).slice(0, 6)).toEqual([
      'dup_invoices/baseline/1',
      'dup_invoices/baseline/2',
      'dup_invoices/baseline/3',
      'dup_invoices/baseline/4',
      'dup_invoices/baseline/5',
      'dup_invoices/with-skill/1',
    ]);
    expect(result.summary).toEqual({
      total: 20,
      passed: 2,
      failed: 1,
      error: 1,
      ungradable: 1,
      executionErrors: 5,
    });
  });

  it("shows a scored run's primary score and its attempt's figures", async () => {
    const [row] = (await list()).rows;
    expect(row).toMatchObject({
      id: seed.cell('dup_invoices/baseline/1'),
      experimentId: seed.experimentId,
      taskVersion: 2,
      attempts: 1,
      status: 'scored',
      primaryScore: { key: 'answer', status: 'failed', score: 0.5 },
      executionErrorCategory: null,
      durationS: 6.1,
      tokens: { input: 3300, output: 63, total: 3363 },
      costUsd: 0,
      configuration: {
        versionId: seed.baselineId,
        name: 'baseline',
        version: 1,
        role: 'baseline',
        model: 'mock/scripted',
        provider: 'custom',
      },
      needs: { provider: 'custom', judgeKeys: [], judgeProvider: null },
    });
    expect(row!.finishedAt).not.toBeNull();
  });

  it('names what Re-score needs for a task with an llm_judge key', async () => {
    const row = (await list({ task: 'total_due' })).rows[0]!;
    expect(row.needs).toEqual({
      provider: 'custom',
      judgeKeys: ['method'],
      judgeProvider: 'custom',
    });
  });

  it('names no judge provider when no judge model is configured', async () => {
    const bare = new RunViewsService(t.db, seed.store, viewsConfig({}));
    const result = await bare.list(
      seed.experimentId,
      RunListQuerySchema.parse({ task: 'total_due' }),
    );
    expect(RunListResultSchema.parse(result).rows[0]!.needs).toEqual({
      provider: 'custom',
      judgeKeys: ['method'],
      judgeProvider: null,
    });
  });

  it("does not show a run waiting for its retry with its previous attempt's figures", async () => {
    const row = (await list()).rows.find((r) => r.id === seed.cell('total_due/baseline/4'))!;
    expect(row).toMatchObject({
      status: 'queued',
      attempts: 1,
      executionErrorCategory: null,
      durationS: null,
      tokens: null,
      costUsd: null,
      finishedAt: null,
      primaryScore: null,
    });
  });

  it('gives every execution error its category', async () => {
    const rows = (await list({ exec_error: '1' })).rows;
    expect(rows.map((r) => [r.repetition, r.configuration.name, r.executionErrorCategory])).toEqual(
      [
        [4, 'baseline', 'provider'],
        [5, 'baseline', 'timeout'],
        [2, 'with-skill', 'setup'],
        [3, 'with-skill', 'worker_lost'],
        [4, 'with-skill', 'other'],
      ],
    );
  });
});

describe('filters', () => {
  it('filters by configuration name or version id, and treats `all` as no filter', async () => {
    expect((await list({ config: 'with-skill' })).matched).toBe(10);
    expect((await list({ config: seed.candidateId })).matched).toBe(10);
    expect((await list({ config: 'all', task: 'all' })).matched).toBe(20);
    expect((await list({ config: 'nope' })).matched).toBe(0);
  });

  it('filters by task, run status and the primary score status', async () => {
    expect((await list({ task: 'total_due' })).matched).toBe(10);
    expect((await list({ status: 'queued' })).matched).toBe(7);
    expect(names(await list({ score_status: 'failed' }))).toEqual(['dup_invoices/baseline/1']);
    expect(names(await list({ ungradable: 'true' }))).toEqual(['dup_invoices/baseline/2']);
    expect(names(await list({ score_status: 'passed', config: 'baseline' }))).toEqual([
      'total_due/baseline/2',
    ]);
  });

  it('keeps the summary over the whole experiment whatever the filters', async () => {
    const result = await list({ task: 'total_due', status: 'scored' });
    expect(result.matched).toBe(1);
    expect(result.summary.total).toBe(20);
  });

  it('filters nothing when a flag is false', async () => {
    expect((await list({ exec_error: '0', ungradable: 'false' })).matched).toBe(20);
  });
});

describe('sorting', () => {
  it('sorts durations longest first by default, with unmeasured runs last either way', async () => {
    const desc = (await list({ sort: 'duration' })).rows.map((r) => r.durationS);
    expect(desc.slice(0, 4)).toEqual([190, 71, 41, 40]);
    expect(desc.slice(-1)).toEqual([null]);
    const asc = (await list({ sort: 'duration', dir: 'asc' })).rows.map((r) => r.durationS);
    expect(asc[0]).toBe(4);
    expect(asc.at(-1)).toBeNull();
  });

  it('sorts by score in status order, by status in lifecycle order, and by configuration', async () => {
    const byScore = (await list({ sort: 'score', dir: 'asc' })).rows.map(
      (r) => r.primaryScore?.status ?? null,
    );
    expect(byScore.slice(0, 5)).toEqual(['passed', 'passed', 'failed', 'error', 'ungradable']);
    expect(byScore.at(-1)).toBeNull();
    const byStatus = (await list({ sort: 'status', dir: 'asc' })).rows.map((r) => r.status);
    expect(byStatus[0]).toBe('queued');
    expect(byStatus.at(-1)).toBe('cancelled');
    const byConfig = await list({ sort: 'configuration' });
    expect(byConfig.rows.slice(0, 10).every((r) => r.configuration.name === 'baseline')).toBe(true);
    expect(names(byConfig).slice(5, 7)).toEqual(['total_due/baseline/1', 'total_due/baseline/2']);
  });

  it('sorts tokens, cost, attempts and finished time, and the task order descending', async () => {
    expect((await list({ sort: 'tokens' })).rows[0]!.tokens?.total).toBe(3363);
    expect((await list({ sort: 'cost' })).rows[0]!.costUsd).toBe(0.0125);
    expect((await list({ sort: 'attempts' })).rows.slice(0, 2).map((r) => r.attempts)).toEqual([
      2, 2,
    ]);
    const finished = (await list({ sort: 'finished', dir: 'asc' })).rows.map((r) => r.finishedAt);
    const set = finished.filter((f): f is string => f !== null);
    expect(set).toEqual([...set].sort());
    expect(names(await list({ sort: 'task', dir: 'desc' }))[0]).toBe('total_due/with-skill/5');
  });
});

it('answers 404 for an unknown experiment', async () => {
  await expect(views.list('exp_nope', {})).rejects.toMatchObject({
    response: { statusCode: 404, message: 'experiment exp_nope not found' },
  });
});
