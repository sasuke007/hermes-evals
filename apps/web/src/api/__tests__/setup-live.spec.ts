/**
 * Phase 8's calls in live mode: GET /system/setup is parsed with SystemSetupSchema (a seed
 * report whose state and times disagree is a contract error, naming the field), and the
 * launch answer's warnings reach the store, which keeps them for the new experiment's
 * Overview. Runs the data layer with VITE_API_MODE=live against a fetch stub.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MOCK_JUDGE_WARNING, type LaunchExperimentInput } from '@hermes-evals/shared';
import type { ApiError } from '@/api/client';
import { systemSetupFixture } from '@/fixtures/setup';

let sent: { method: string; path: string }[] = [];
let answer: unknown = {};

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
    sent.push({ method: init.method ?? 'GET', path: url.pathname });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

const LAUNCH: LaunchExperimentInput = {
  name: 'Skill vs no skill',
  description: '',
  suiteId: 'suite_1',
  taskKeys: ['credit_notes'],
  baselineVersionId: 'cfv_a',
  candidateVersionIds: ['cfv_b'],
  repetitions: 2,
  concurrency: 1,
  spendCeilingUsd: null,
  timeBudgetOverrideS: null,
  expectedConfigHashes: { cfv_a: 'a'.repeat(64), cfv_b: 'b'.repeat(64) },
};

describe('Phase 8 calls, live', () => {
  it('reads the judge and the seed from GET /system/setup', async () => {
    const { getSystemSetup } = await import('@/api/system');
    answer = systemSetupFixture((n) => n === 'judge-mock');
    await expect(getSystemSetup()).resolves.toEqual(answer);
    expect(sent).toEqual([{ method: 'GET', path: '/api/system/setup' }]);
  });

  it('refuses a seed report whose state and times disagree', async () => {
    const { getSystemSetup } = await import('@/api/system');
    const setup = systemSetupFixture(() => false);
    answer = { ...setup, seed: { ...setup.seed, finishedAt: null } };
    const err = (await getSystemSetup().catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe('contract');
    expect(err.message).toContain('seed.finishedAt');
  });

  it("keeps the launch answer's warnings for the new experiment's Overview", async () => {
    setActivePinia(createPinia());
    const { useExperimentsStore } = await import('@/stores/experiments');
    const store = useExperimentsStore();
    answer = { id: 'exp_new', warnings: [MOCK_JUDGE_WARNING] };
    await expect(store.launch(LAUNCH)).resolves.toBe('exp_new');
    expect(store.launchWarnings).toEqual({ exp_new: [MOCK_JUDGE_WARNING] });
    store.dismissLaunchWarnings('exp_new');
    expect(store.launchWarnings).toEqual({});
    answer = { id: 'exp_next', warnings: [] };
    await store.launch(LAUNCH);
    expect(store.launchWarnings).toEqual({});
  });
});
