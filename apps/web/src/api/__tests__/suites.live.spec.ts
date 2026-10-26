/**
 * In live mode the suites data layer calls the endpoints of plan section 11 and parses each
 * answer with its shared schema: the paths and the reload body are what the API reads, and
 * an answer that breaks its contract is refused with the field it broke. Runs the data
 * layer with VITE_API_MODE=live against a fetch stub that answers with fixtures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuiteReloadRequestSchema } from '@hermes-evals/shared';
import {
  SUITE_V1_ID,
  suiteDetailFixture,
  suiteListFixture,
  suiteReloadFixture,
  taskDetailFixture,
  taskDiffFixture,
} from '@/fixtures/suites';

interface Sent {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

let sent: Sent[] = [];
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
  answer = {};
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    sent.push({
      method: init.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

const suites = () => import('@/api/suites');

function last(): Sent {
  const request = sent[sent.length - 1];
  if (!request) throw new Error('nothing was sent');
  return request;
}

describe('suites data layer, live', () => {
  it('lists suites and parses the rows', async () => {
    answer = suiteListFixture('v1');
    const rows = await (await suites()).listSuites();
    expect(last()).toMatchObject({ method: 'GET', path: '/api/suites' });
    expect(rows[0]!.name).toBe('invoices-v1');
  });

  it('reads a suite version, its history, a task and its history', async () => {
    const api = await suites();
    answer = suiteDetailFixture('v1', SUITE_V1_ID);
    await api.getSuite(SUITE_V1_ID);
    expect(last().path).toBe(`/api/suites/${SUITE_V1_ID}`);
    answer = [];
    await api.getSuiteHistory(SUITE_V1_ID);
    expect(last().path).toBe(`/api/suites/${SUITE_V1_ID}/history`);
    answer = {
      ...taskDetailFixture('v1', SUITE_V1_ID, 'dup_invoices'),
      homeFiles: [],
      experiments: [],
    };
    const task = await api.getTask(SUITE_V1_ID, 'dup_invoices');
    expect(last().path).toBe(`/api/suites/${SUITE_V1_ID}/tasks/dup_invoices`);
    expect(task.verification).toHaveLength(2);
    answer = [];
    await api.getTaskHistory(SUITE_V1_ID, 'dup_invoices');
    expect(last().path).toBe(`/api/suites/${SUITE_V1_ID}/tasks/dup_invoices/history`);
  });

  it('parses the home files a task has and refuses an answer without them (Phase 6)', async () => {
    const api = await suites();
    const base = { ...taskDetailFixture('v1', SUITE_V1_ID, 'per_vendor'), experiments: [] };
    answer = { ...base, homeFiles: [] };
    expect((await api.getTask(SUITE_V1_ID, 'per_vendor')).homeFiles).toEqual([]);
    const seed = {
      kind: 'home_seed',
      path: 'home/memories/USER.md',
      homePath: 'memories/USER.md',
      sizeBytes: 12,
      sha256: 'a'.repeat(64),
      text: 'Reports in EUR.\n',
    };
    answer = { ...base, homeFiles: [seed] };
    expect((await api.getTask(SUITE_V1_ID, 'per_vendor')).homeFiles).toEqual([seed]);
    answer = base;
    await expect(api.getTask(SUITE_V1_ID, 'per_vendor')).rejects.toMatchObject({
      kind: 'contract',
    });
    answer = { ...base, homeFiles: [{ ...seed, kind: 'fixture' }] };
    await expect(api.getTask(SUITE_V1_ID, 'per_vendor')).rejects.toMatchObject({
      kind: 'contract',
    });
    // The path in the home comes from the API; the web never works it out from the task path.
    const { homePath: _homePath, ...noHomePath } = seed;
    answer = { ...base, homeFiles: [noHomePath] };
    await expect(api.getTask(SUITE_V1_ID, 'per_vendor')).rejects.toMatchObject({
      kind: 'contract',
    });
  });

  it('asks for a diff against another suite version with ?against=', async () => {
    answer = taskDiffFixture('v1', 'total_due', SUITE_V1_ID, SUITE_V1_ID);
    await (await suites()).getTaskDiff(SUITE_V1_ID, 'total_due', 'suite_older');
    expect(last()).toMatchObject({
      path: `/api/suites/${SUITE_V1_ID}/tasks/total_due/diff`,
      query: { against: 'suite_older' },
    });
  });

  it('previews a fixture by its encoded workspace path, and accepts null', async () => {
    answer = null;
    const preview = await (await suites()).getFixturePreview(SUITE_V1_ID, 'k', 'docs/a b.csv');
    expect(preview).toBeNull();
    expect(last().path).toBe(
      `/api/suites/${SUITE_V1_ID}/tasks/k/fixtures/docs%2Fa%20b.csv/preview`,
    );
  });

  it('reloads one directory or all of them with a body the API parses', async () => {
    const api = await suites();
    answer = suiteReloadFixture('invalid-task');
    const result = await api.reloadSuites('./suites/invoices-v1');
    const one = last();
    expect(one).toMatchObject({ method: 'POST', path: '/api/suites/reload' });
    expect(one.headers['x-requested-with']).toBe('hermes-evals');
    expect(SuiteReloadRequestSchema.parse(one.body)).toEqual({ path: './suites/invoices-v1' });
    expect(result.suites[0]!.message).toBe('1 task now invalid: late_fees');
    await api.reloadSuites();
    expect(SuiteReloadRequestSchema.parse(last().body)).toEqual({});
  });

  it('refuses an answer that breaks the contract, naming the field', async () => {
    answer = [{ ...suiteListFixture('v1')[0], contentHash: 'not-a-hash' }];
    await expect((await suites()).listSuites()).rejects.toMatchObject({ kind: 'contract' });
  });
});
