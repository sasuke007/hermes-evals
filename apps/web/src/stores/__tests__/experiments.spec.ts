import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { ExperimentListRow } from '@/api/types/experiments';
import { useExperimentsStore } from '@/stores/experiments';
import { useScenario } from './scenarioEnv';

beforeEach(() => {
  useScenario(null);
  setActivePinia(createPinia());
});

describe('experiments store: the list', () => {
  it('loads the rows newest first and knows whether anything runs', async () => {
    const store = useExperimentsStore();
    await store.loadList();
    expect(store.listLoaded).toBe(true);
    expect(store.listRows).toHaveLength(6);
    expect(store.anyRunning).toBe(true);
    expect(store.listUpdatedAt).not.toBeNull();
  });

  it('patches known rows in place and puts new experiments on top', async () => {
    const store = useExperimentsStore();
    await store.loadList();
    const before = store.listRows;
    const running = before[1]!;
    const record = store.listById[running.id]!;
    const fresh: ExperimentListRow = {
      ...before[0]!,
      id: 'exp_new',
      name: 'Just launched',
      createdAt: '2026-10-24T09:00:00',
    };
    // The API answers newest first; the running row moved on.
    store.applyList([
      fresh,
      ...before.map((r) => (r.id === running.id ? { ...r, doneRuns: 99 } : r)),
    ]);
    expect(store.listRows.map((r) => r.id)).toEqual(['exp_new', ...before.map((r) => r.id)]);
    expect(store.listById[running.id]).toBe(record);
    expect(store.listById[running.id]!.doneRuns).toBe(99);
  });

  it('never reorders known rows, whatever order a refresh brings', async () => {
    const store = useExperimentsStore();
    await store.loadList();
    const ids = store.listRows.map((r) => r.id);
    store.applyList([...store.listRows].reverse().map((r) => ({ ...r })));
    expect(store.listRows.map((r) => r.id)).toEqual(ids);
  });

  it('keeps the last good rows when a refresh fails', async () => {
    const store = useExperimentsStore();
    await store.loadList();
    useScenario('error');
    await store.loadList();
    expect(store.listRows).toHaveLength(6);
    expect(store.listError).toBe(
      'GET /api/experiments → 502 · upstream api:8080 connection refused',
    );
  });
});

describe('experiments store: New experiment', () => {
  it('loads the options and estimates the matrix', async () => {
    const store = useExperimentsStore();
    const options = await store.loadOptions();
    expect(options?.configurations).toHaveLength(3);
    const [base, skill] = options!.configurations;
    await store.refreshEstimate({
      suiteId: options!.suites[0]!.suiteId,
      versionIds: [base!.versionId, skill!.versionId],
      taskCount: 12,
      repetitions: 5,
      concurrency: 3,
    });
    expect(store.estimate).toMatchObject({ runs: 120, waves: 40 });
    await store.refreshEstimate(null);
    expect(store.estimate).toBeNull();
  });

  it('keeps only the answer to the newest estimate request', async () => {
    const store = useExperimentsStore();
    const options = (await store.loadOptions())!;
    const [base, skill] = options.configurations;
    const query = {
      suiteId: options.suites[0]!.suiteId,
      versionIds: [base!.versionId, skill!.versionId],
      taskCount: 12,
      repetitions: 5,
      concurrency: 3,
    };
    const first = store.refreshEstimate(query);
    const second = store.refreshEstimate({ ...query, repetitions: 1 });
    await Promise.all([first, second]);
    expect(store.estimate?.runs).toBe(24);
  });

  it('diffs two or more versions, baseline first, and clears below two', async () => {
    const store = useExperimentsStore();
    const options = (await store.loadOptions())!;
    const [base, skill] = options.configurations;
    await store.loadDiff([base!.versionId, skill!.versionId]);
    expect(store.diff?.differing).toEqual(['skills']);
    await store.loadDiff([base!.versionId]);
    expect(store.diff).toBeNull();
  });

  it('launches, or rejects with the API error', async () => {
    const store = useExperimentsStore();
    const options = (await store.loadOptions())!;
    const [base, skill] = options.configurations;
    const input = {
      name: 'x',
      description: '',
      suiteId: options.suites[0]!.suiteId,
      taskKeys: ['total_due'],
      baselineVersionId: base!.versionId,
      candidateVersionIds: [skill!.versionId],
      repetitions: 5,
      concurrency: 3,
      spendCeilingUsd: null,
      timeBudgetOverrideS: null,
      expectedConfigHashes: {
        [base!.versionId]: base!.configHash,
        [skill!.versionId]: skill!.configHash,
      },
    };
    await expect(store.launch(input)).resolves.toBe('exp_01JBFMCPVB');
    expect(store.launching).toBe(false);
    useScenario('launch-conflict');
    await expect(store.launch(input)).rejects.toMatchObject({ status: 409 });
    expect(store.launching).toBe(false);
  });
});
