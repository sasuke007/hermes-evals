/**
 * The estimate maths (plan 7.2): history medians, the budget fallback, an
 * unpriced model, and the matrix figures the summary panel shows.
 */
import { describe, expect, it } from 'vitest';
import {
  ExperimentEstimateViewSchema,
  PerRunEstimateSchema,
  type PriceTable,
  type Tokens,
} from '@hermes-evals/shared';
import {
  BUDGET_TOKENS,
  estimateSnapshot,
  experimentEstimate,
  median,
  perRunEstimate,
  type ChosenEstimate,
} from './per-run-estimate.js';

const PRICES: PriceTable = {
  sha256: 'a'.repeat(64),
  loaded_at: '2026-10-24T09:00:00.000Z',
  models: {
    'test/priced': { input_per_1m: 1, output_per_1m: 10, checked_at: '2026-10-24' },
    'mock/scripted': { input_per_1m: 0, output_per_1m: 0, checked_at: '2026-10-24' },
  },
};

const tokens = (input: number, output: number): Tokens => ({
  input,
  output,
  total: input + output,
  cache_read: 0,
  cache_write: 0,
});

describe('median', () => {
  it('takes the middle value, or the mean of the two middle ones', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('perRunEstimate', () => {
  it('falls back to a quarter of the budget and 15,000 tokens without history', () => {
    const estimate = perRunEstimate(
      { model: 'test/priced', timeBudgetS: 300, history: null },
      PRICES,
    );
    expect(PerRunEstimateSchema.parse(estimate)).toEqual({
      seconds: 75,
      // 13,000 in at $1/M and 2,000 out at $10/M: the design's split.
      costUsd: 0.033,
      tokens: 15_000,
      basis: 'budget',
      pastRuns: 0,
    });
    expect(BUDGET_TOKENS.total).toBe(15_000);
  });

  it('takes the medians of past attempts and prices them at the current table', () => {
    const estimate = perRunEstimate(
      {
        model: 'test/priced',
        timeBudgetS: 300,
        history: {
          attempts: [
            { durationMs: 10_000, tokens: tokens(1000, 100) },
            { durationMs: 30_000, tokens: tokens(3000, 300) },
            { durationMs: 20_000, tokens: tokens(2000, 200) },
          ],
          total: 192,
        },
      },
      PRICES,
    );
    expect(estimate).toEqual({
      seconds: 20,
      costUsd: 0.004,
      tokens: 2200,
      basis: 'history',
      pastRuns: 192,
    });
  });

  it('has no cost for an unpriced model, never zero', () => {
    const history = { attempts: [{ durationMs: 4000, tokens: tokens(10, 1) }], total: 1 };
    expect(
      perRunEstimate({ model: 'nobody/knows', timeBudgetS: 60, history }, PRICES),
    ).toMatchObject({ costUsd: null, basis: 'history' });
    expect(
      perRunEstimate({ model: 'nobody/knows', timeBudgetS: 60, history: null }, PRICES).costUsd,
    ).toBeNull();
    expect(
      perRunEstimate({ model: 'mock/scripted', timeBudgetS: 60, history: null }, PRICES).costUsd,
    ).toBe(0);
  });

  it('times attempts without token counts, and assumes the budget tokens when none has them', () => {
    const estimate = perRunEstimate(
      {
        model: 'test/priced',
        timeBudgetS: 60,
        history: { attempts: [{ durationMs: 450, tokens: null }], total: 1 },
      },
      PRICES,
    );
    expect(estimate).toMatchObject({ seconds: 0.5, tokens: 15_000, costUsd: 0.033, pastRuns: 1 });
  });
});

const chosen = (
  versionId: string,
  seconds: number,
  costUsd: number | null,
  basis: 'history' | 'budget',
  pastRuns: number,
): ChosenEstimate => ({
  versionId,
  name: versionId,
  estimate: { seconds, costUsd, tokens: 1000, basis, pastRuns },
});

describe('experimentEstimate', () => {
  it('counts runs and waves and sums the cost per configuration', () => {
    const view = experimentEstimate({ taskCount: 12, repetitions: 5, concurrency: 3 }, [
      chosen('a', 48, 0.01, 'history', 192),
      chosen('b', 60, 0.02, 'history', 40),
    ]);
    expect(ExperimentEstimateViewSchema.parse(view)).toEqual({
      runs: 120,
      waves: 40,
      perRunSeconds: 54,
      durationS: 2160,
      costUsd: 1.8,
      perConfiguration: [
        { versionId: 'a', name: 'a', runs: 60, costUsd: 0.6 },
        { versionId: 'b', name: 'b', runs: 60, costUsd: 1.2 },
      ],
      basis: 'history',
      // The weakest basis decides.
      pastRuns: 40,
    });
  });

  it('has no total cost when one configuration is unpriced, and is budget-based when one has no history', () => {
    const view = experimentEstimate({ taskCount: 3, repetitions: 2, concurrency: 4 }, [
      chosen('a', 30, 0.01, 'history', 10),
      chosen('b', 30, null, 'budget', 0),
    ]);
    expect(view).toMatchObject({ runs: 12, waves: 3, costUsd: null, basis: 'budget', pastRuns: 0 });
    expect(view.perConfiguration.map((p) => p.costUsd)).toEqual([0.06, null]);
  });

  it('is what the experiment row keeps as its estimate', () => {
    const view = experimentEstimate({ taskCount: 1, repetitions: 1, concurrency: 1 }, [
      chosen('a', 30.4, 0, 'budget', 0),
    ]);
    expect(estimateSnapshot(view)).toEqual({
      runs: 1,
      duration_s: 30,
      cost_usd: 0,
      basis: 'budget',
    });
  });
});
