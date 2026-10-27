/**
 * The experiment list and New experiment against the real API (VITE_API_MODE=live): each
 * call goes to its endpoint, sends what the shared request schemas accept, and parses the
 * answer with the response's shared schema, so a contract change fails here instead of in a
 * page. Runs the data layer against a fetch stub that answers with the fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EstimateQuerySchema,
  LaunchExperimentInputSchema,
  type EstimateQuery,
  type LaunchExperimentInput,
} from '@hermes-evals/shared';
import {
  duplicateDraftFixture,
  estimateFixture,
  experimentListRowFixture,
  experimentSeeds,
  newExperimentOptionsFixture,
} from '@/fixtures/experiments';

interface Sent {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
}

const none = () => false;
let sent: Sent[] = [];
/** What the stub answers next: a status and a JSON body. */
let answer: { status: number; body: unknown } = { status: 200, body: {} };

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
  answer = { status: 200, body: {} };
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    sent.push({
      method: init.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  });
});

async function experiments() {
  return import('@/api/experiments');
}

function lastSent(): Sent {
  const request = sent[sent.length - 1];
  if (!request) throw new Error('nothing was sent');
  return request;
}

const options = newExperimentOptionsFixture(none);
const suiteId = options.suites[0]!.suiteId;
const [base, skill] = options.configurations;

const LAUNCH: LaunchExperimentInput = {
  name: 'Skill vs no skill, invoices-v1',
  description: '',
  suiteId,
  taskKeys: ['total_due', 'dup_invoices', 'vat_split'],
  baselineVersionId: base!.versionId,
  candidateVersionIds: [skill!.versionId],
  repetitions: 5,
  concurrency: 3,
  spendCeilingUsd: null,
  timeBudgetOverrideS: 120,
  expectedConfigHashes: {
    [base!.versionId]: base!.configHash,
    [skill!.versionId]: skill!.configHash,
  },
};

describe('the experiment list, live', () => {
  it('parses GET /experiments with the list row schema', async () => {
    const rows = experimentSeeds(none).map(experimentListRowFixture);
    answer = { status: 200, body: rows };
    const { listExperiments } = await experiments();
    await expect(listExperiments()).resolves.toEqual(rows);
    expect(lastSent()).toMatchObject({ method: 'GET', path: '/api/experiments' });
  });

  it('refuses a row that breaks the contract, naming the field', async () => {
    const [row] = experimentSeeds(none).map(experimentListRowFixture);
    const { reason: _dropped, ...verdict } = row!.verdicts[0] ?? {
      candidate: 'x',
      candidateVersionId: 'x',
      verdict: 'better',
      delta: 0.1,
      lo: 0.05,
      hi: 0.2,
      reason: null,
    };
    answer = { status: 200, body: [{ ...row, status: 'completed', verdicts: [verdict] }] };
    const { listExperiments } = await experiments();
    await expect(listExperiments()).rejects.toMatchObject({
      kind: 'contract',
      message: expect.stringContaining('GET /api/experiments → 200'),
      detail: expect.stringContaining('0.verdicts.0.reason'),
    });
  });
});

describe('New experiment, live', () => {
  it('parses GET /experiments/new-options', async () => {
    answer = { status: 200, body: options };
    const { getNewExperimentOptions } = await experiments();
    await expect(getNewExperimentOptions()).resolves.toEqual(options);
    expect(lastSent().path).toBe('/api/experiments/new-options');
  });

  it('sends the per-run budget override as budget, and parses the estimate', async () => {
    const query: EstimateQuery = {
      suiteId,
      versionIds: [base!.versionId, skill!.versionId],
      taskCount: 12,
      repetitions: 5,
      concurrency: 3,
      budgetS: 120,
    };
    const view = estimateFixture(options, query);
    answer = { status: 200, body: view };
    const { estimateExperiment } = await experiments();
    await expect(estimateExperiment(query)).resolves.toEqual(view);
    expect(lastSent().path).toBe('/api/experiments/estimate');
    expect(lastSent().query.budget).toBe('120');
    expect(EstimateQuerySchema.parse(lastSent().query)).toEqual(query);

    const { budgetS: _none, ...withoutBudget } = query;
    await estimateExperiment(withoutBudget);
    expect(lastSent().query).not.toHaveProperty('budget');
    expect(EstimateQuerySchema.parse(lastSent().query)).toEqual(withoutBudget);
  });

  it('launches with the CSRF header and the body the API parses', async () => {
    answer = { status: 201, body: { id: 'exp_new', warnings: [] } };
    const { launchExperiment } = await experiments();
    await expect(launchExperiment(LAUNCH)).resolves.toEqual({ id: 'exp_new', warnings: [] });
    expect(lastSent()).toMatchObject({ method: 'POST', path: '/api/experiments' });
    expect(lastSent().headers['x-requested-with']).toBe('hermes-evals');
    expect(LaunchExperimentInputSchema.parse(lastSent().body)).toEqual(LAUNCH);
  });

  it("rejects a refused launch with the API's own sentence", async () => {
    answer = { status: 409, body: { statusCode: 409, message: 'Nous Portal is not connected.' } };
    const { launchExperiment } = await experiments();
    await expect(launchExperiment(LAUNCH)).rejects.toMatchObject({
      status: 409,
      detail: 'Nous Portal is not connected.',
      message: 'POST /api/experiments → 409 · Nous Portal is not connected.',
    });
  });

  it('duplicates through POST /experiments/:id/duplicate and parses the draft', async () => {
    const [seed] = experimentSeeds(none);
    const draft = duplicateDraftFixture(none, seed!);
    answer = { status: 200, body: draft };
    const { duplicateExperiment } = await experiments();
    await expect(duplicateExperiment(seed!.id)).resolves.toEqual(draft);
    expect(lastSent()).toMatchObject({
      method: 'POST',
      path: `/api/experiments/${seed!.id}/duplicate`,
    });
    expect(lastSent().headers['x-requested-with']).toBe('hermes-evals');
  });
});
