/**
 * In live mode the data layer sends what the shared request schemas accept:
 * the query strings of listRuns, estimateExperiment, getComparison and
 * listRunEvents parse back to the values the page passed, and the launch,
 * resume and bulk bodies parse as sent. A query parameter or body field
 * renamed on either side fails here. Runs the data layer with
 * VITE_API_MODE=live against a fetch stub that records each request.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BulkRunActionInputSchema,
  ComparisonQuerySchema,
  EstimateQuerySchema,
  LaunchExperimentInputSchema,
  ResumeExperimentInputSchema,
  RunEventsQuerySchema,
  RunListQuerySchema,
  type EstimateQuery,
  type LaunchExperimentInput,
  type RunFilters,
} from '@hermes-evals/shared';

interface Sent {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

let sent: Sent[] = [];

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
    sent.push({
      method: init.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

/** The data layer, loaded after VITE_API_MODE=live is stubbed. */
async function live() {
  return {
    source: await import('@/api/source'),
    experiments: await import('@/api/experiments'),
    runs: await import('@/api/runs'),
  };
}

function lastSent(): Sent {
  const request = sent[sent.length - 1];
  if (!request) throw new Error('nothing was sent');
  return request;
}

const LAUNCH: LaunchExperimentInput = {
  name: 'Skill vs no skill, invoices-v1',
  description: 'Does the invoice-method skill help?',
  suiteId: 'suite_01JAX7S1V1',
  taskKeys: ['total_due', 'dup_invoices'],
  baselineVersionId: 'cfgv_base',
  candidateVersionIds: ['cfgv_skill'],
  repetitions: 5,
  concurrency: 3,
  spendCeilingUsd: 2,
  timeBudgetOverrideS: null,
  expectedConfigHashes: { cfgv_base: 'a'.repeat(64), cfgv_skill: 'b'.repeat(64) },
};

describe('requests the web sends in live mode', () => {
  it('runs in live mode', async () => {
    const { source } = await live();
    expect(source.apiMode).toBe('live');
  });

  it('the Runs tab query parses back to the filters', async () => {
    const { runs } = await live();
    const cases: [RunFilters, RunFilters][] = [
      [{}, {}],
      [
        { configuration: 'with-skill', task: 'total_due' },
        { configuration: 'with-skill', task: 'total_due' },
      ],
      [{ configuration: 'all', task: 'all' }, {}],
      [
        { status: 'execution_error', scoreStatus: 'ungradable' },
        { status: 'execution_error', scoreStatus: 'ungradable' },
      ],
      [
        { hasExecutionError: true, ungradable: true },
        { hasExecutionError: true, ungradable: true },
      ],
      [{ hasExecutionError: false, ungradable: false }, {}],
      [
        { sort: 'duration', dir: 'asc' },
        { sort: 'duration', dir: 'asc' },
      ],
    ];
    for (const [filters, expected] of cases) {
      await runs.listRuns('exp_01JBB7SVNS', filters);
      expect(lastSent().path).toBe('/api/experiments/exp_01JBB7SVNS/runs');
      expect({ filters, parsed: RunListQuerySchema.parse(lastSent().query) }).toEqual({
        filters,
        parsed: expected,
      });
    }
  });

  it('the estimate query parses back to the EstimateQuery', async () => {
    const { experiments } = await live();
    const query: EstimateQuery = {
      suiteId: 'suite_01JAX7S1V1',
      versionIds: ['cfgv_base', 'cfgv_skill'],
      taskCount: 12,
      repetitions: 5,
      concurrency: 3,
    };
    await experiments.estimateExperiment(query);
    expect(lastSent().path).toBe('/api/experiments/estimate');
    expect(EstimateQuerySchema.parse(lastSent().query)).toEqual(query);
  });

  it('the comparison and run events queries parse back', async () => {
    const { experiments, runs } = await live();
    const query = { candidate: 'cfgv_skill', key: 'answer', filter: 'improved' } as const;
    await experiments.getComparison('exp_01JBB7SVNS', query);
    expect(ComparisonQuerySchema.parse(lastSent().query)).toEqual(query);
    await experiments.getComparison('exp_01JBB7SVNS');
    expect(ComparisonQuerySchema.parse(lastSent().query)).toEqual({});
    for (const after of [0, 7]) {
      await runs.listRunEvents('run_01JB7X4K2M', after);
      expect(lastSent().path).toBe('/api/runs/run_01JB7X4K2M/events');
      expect(RunEventsQuerySchema.parse(lastSent().query)).toEqual({ after });
    }
  });

  it('the launch, resume and bulk bodies parse as sent', async () => {
    const { experiments, runs } = await live();
    await experiments.launchExperiment(LAUNCH);
    expect(lastSent()).toMatchObject({ method: 'POST', path: '/api/experiments' });
    expect(LaunchExperimentInputSchema.parse(lastSent().body)).toEqual(LAUNCH);

    for (const options of [{}, { spendCeilingUsd: 3 }]) {
      await experiments.resumeExperiment('exp_01JBFMCPVB', options);
      expect(lastSent().path).toBe('/api/experiments/exp_01JBFMCPVB/resume');
      expect(ResumeExperimentInputSchema.parse(lastSent().body)).toEqual(options);
    }

    const runIds = ['run_01JB7X4K2M', 'run_01JB7X4K2N'];
    await runs.rescoreRuns('exp_01JBB7SVNS', runIds);
    expect(lastSent().path).toBe('/api/experiments/exp_01JBB7SVNS/runs/rescore');
    expect(BulkRunActionInputSchema.parse(lastSent().body)).toEqual({ runIds });
    await runs.retryRuns('exp_01JBB7SVNS', runIds);
    expect(lastSent().path).toBe('/api/experiments/exp_01JBB7SVNS/runs/retry');
    expect(BulkRunActionInputSchema.parse(lastSent().body)).toEqual({ runIds });
  });
});
