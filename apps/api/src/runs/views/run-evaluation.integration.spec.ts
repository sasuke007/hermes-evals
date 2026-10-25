/**
 * Which evaluation a run's scores come from (plan 9.4, UI_FLOWS 18), on
 * PGlite with the real triggers: runs scored once, re-scored, with a
 * re-score queued, or with one that failed (run-states-spec.ts), as
 * GET /runs/:id (`evaluation`) and the Runs tab (`generation`,
 * `rescorePending`) show them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  RunDetailSchema,
  RunListResultSchema,
  type RunDetail,
  type RunListResult,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { viewsConfig, type RunCell } from './run-fixtures-spec.js';
import { RESCORE_FAILURE, seedAllStates, type AllStates } from './run-states-spec.js';
import { RunViewsService } from './run-views.service.js';

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

const detail = async (cell: RunCell): Promise<RunDetail> =>
  RunDetailSchema.parse(await views.detail(seed.cell(cell)));

const list = async (): Promise<RunListResult> =>
  RunListResultSchema.parse(await views.list(seed.experimentId, {}));

describe('the Runs tab', () => {
  it('names the generation each score comes from and a pending re-score', async () => {
    const rows = new Map((await list()).rows.map((r) => [r.id, r]));
    const row = (cell: RunCell) => rows.get(seed.cell(cell))!;
    // Scored once, nothing pending.
    expect(row('dup_invoices/baseline/1')).toMatchObject({ generation: 1, rescorePending: false });
    // Re-scored as generation 2; the later re-score failed, so 2 is still shown.
    expect(row('dup_invoices/baseline/2')).toMatchObject({
      generation: 2,
      rescorePending: false,
      primaryScore: { key: 'answer', status: 'ungradable', score: null },
    });
    // A re-score is queued: still scored, still showing generation 1's pass.
    expect(row('dup_invoices/with-skill/1')).toMatchObject({
      status: 'scored',
      generation: 1,
      rescorePending: true,
      primaryScore: { key: 'answer', status: 'passed', score: 1 },
    });
    // Not scored yet, or never executed.
    for (const cell of ['total_due/with-skill/1', 'dup_invoices/baseline/4'] as const) {
      expect(row(cell)).toMatchObject({ generation: null, rescorePending: false });
    }
  });
});

describe('which evaluation the scores come from', () => {
  it('a run scored once: generation 1, nothing pending', async () => {
    expect((await detail('dup_invoices/baseline/1')).evaluation).toEqual({
      generation: 1,
      pending: null,
      lastFailure: null,
    });
  });

  it('a queued re-score: the run stays scored and shows generation 1 until it publishes', async () => {
    const run = await detail('dup_invoices/with-skill/1');
    expect(run).toMatchObject({ status: 'scored', primary: { key: 'answer', status: 'passed' } });
    expect(run.evaluation).toEqual({
      generation: 1,
      pending: {
        evaluationId: seed.pendingRescore.id,
        generation: 2,
        status: 'queued',
        cause: 'rescore',
        requestedAt: seed.pendingRescore.requestedAt.toISOString(),
      },
      lastFailure: null,
    });
  });

  it('a re-score that failed: the published generation 2 stays current, with why 3 failed', async () => {
    const run = await detail('dup_invoices/baseline/2');
    expect(run.evaluation).toEqual({
      generation: 2,
      pending: null,
      lastFailure: { generation: 3, error: RESCORE_FAILURE, finishedAt: expect.any(String) },
    });
    // Generation 2's own scores, not generation 1's.
    expect(run.scores.map((s) => [s.key, s.status])).toEqual([
      ['answer', 'ungradable'],
      ['reads_fixture', 'failed'],
      ['check', 'ungradable'],
    ]);
  });

  it('a run never scored: no generation', async () => {
    for (const cell of ['total_due/with-skill/1', 'dup_invoices/baseline/4'] as const) {
      expect((await detail(cell)).evaluation).toEqual({
        generation: null,
        pending: null,
        lastFailure: null,
      });
    }
  });
});
