/**
 * In live mode getComparison calls GET /experiments/:id/comparison with the candidate and key
 * the page holds and parses the answer with ComparisonViewSchema: a view the API sends comes
 * through whole, one that breaks the contract (statistics and the reason both missing) is
 * refused with the field it broke. Runs the data layer with VITE_API_MODE=live against a fetch
 * stub that answers with the fixtures' view.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { comparisonFixture } from '@/fixtures/comparison';
import { EXPERIMENT_IDS, findSeed } from '@/fixtures/experiments';

let sent: { path: string; query: Record<string, string> }[] = [];
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
  vi.stubGlobal('fetch', async (input: string) => {
    const url = new URL(input, 'http://localhost');
    sent.push({ path: url.pathname, query: Object.fromEntries(url.searchParams) });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

const fixtureView = () => {
  const seed = findSeed(() => false, EXPERIMENT_IDS.skillVsNoSkill);
  if (!seed) throw new Error('no seed');
  return comparisonFixture(seed, { key: 'answer' });
};

describe('getComparison (live)', () => {
  it('asks for the candidate and key, and parses the view', async () => {
    const { getComparison } = await import('@/api/experiments');
    const view = fixtureView();
    answer = view;
    const got = await getComparison(EXPERIMENT_IDS.skillVsNoSkill, {
      candidate: view.candidate.versionId,
      key: 'answer',
    });
    expect(sent[0]).toEqual({
      path: `/api/experiments/${EXPERIMENT_IDS.skillVsNoSkill}/comparison`,
      query: { candidate: view.candidate.versionId, key: 'answer' },
    });
    expect(got).toEqual(view);
  });

  it('refuses a view that breaks its contract', async () => {
    const { getComparison } = await import('@/api/experiments');
    const { ApiError } = await import('@/api/client');
    answer = { ...fixtureView(), statistics: null };
    const err = await getComparison(EXPERIMENT_IDS.skillVsNoSkill).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ kind: 'contract' });
    expect(String((err as Error).message)).toContain('statisticsUnavailable');
  });
});
