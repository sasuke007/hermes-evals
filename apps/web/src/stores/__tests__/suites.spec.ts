import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ApiError } from '@/api/client';
import { getSuite, reloadSuites } from '@/api/suites';
import type { SuiteReloadResult } from '@/api/types/suites';
import { SUITE_V1_ID, suiteReloadFixture } from '@/fixtures/suites';
import { useSuitesStore } from '@/stores/suites';
import { useScenario } from './scenarioEnv';

vi.mock('@/api/suites', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/suites')>();
  return {
    ...actual,
    getSuite: vi.fn<typeof actual.getSuite>(actual.getSuite),
    reloadSuites: vi.fn<typeof actual.reloadSuites>(actual.reloadSuites),
  };
});

beforeEach(() => {
  useScenario(null);
  setActivePinia(createPinia());
  vi.mocked(getSuite).mockClear();
});
afterEach(() => vi.unstubAllGlobals());

describe('suites store', () => {
  it('loads the list once it is asked, with its state', async () => {
    const store = useSuitesStore();
    expect(store.listLoaded).toBe(false);
    await store.loadList();
    expect(store.list.map((r) => r.name)).toEqual(['invoices-v1']);
    expect([store.listLoaded, store.listLoading, store.listError]).toEqual([true, false, null]);
  });

  it('keeps the list error verbatim', async () => {
    useScenario('error');
    const store = useSuitesStore();
    await store.loadList();
    expect(store.listError).toBe('GET /api/suites → 502 · upstream api:8080 connection refused');
    expect(store.listLoaded).toBe(false);
  });

  it('fetches a suite version once and keeps it by id (versions never change)', async () => {
    const store = useSuitesStore();
    await store.loadSuite(SUITE_V1_ID);
    await store.loadSuite(SUITE_V1_ID);
    expect(getSuite).toHaveBeenCalledTimes(1);
    expect(store.suites[SUITE_V1_ID]!.name).toBe('invoices-v1');
    await store.loadSuite(SUITE_V1_ID, true);
    expect(getSuite).toHaveBeenCalledTimes(2);
  });

  it('keys tasks, histories and diffs by suite version and key', async () => {
    const store = useSuitesStore();
    await store.loadTask(SUITE_V1_ID, 'dup_invoices');
    await store.loadTaskHistory(SUITE_V1_ID, 'dup_invoices');
    await store.loadDiff(SUITE_V1_ID, 'dup_invoices', SUITE_V1_ID);
    expect(Object.keys(store.tasks)).toEqual([`${SUITE_V1_ID}/dup_invoices`]);
    expect(Object.keys(store.taskHistories)).toEqual([`${SUITE_V1_ID}/dup_invoices`]);
    expect(Object.keys(store.diffs)).toEqual([`${SUITE_V1_ID}/dup_invoices@${SUITE_V1_ID}`]);
    expect(await store.loadPreview(SUITE_V1_ID, 'currency_mix', 'rates.json')).toBeNull();
  });

  it('reloads one folder: busy for that folder only, then the list and its line', async () => {
    let finish: (r: SuiteReloadResult) => void = () => {};
    vi.mocked(reloadSuites).mockImplementationOnce(
      () => new Promise<SuiteReloadResult>((resolve) => (finish = resolve)),
    );
    const store = useSuitesStore();
    await store.loadSuite(SUITE_V1_ID);
    await store.loadTask(SUITE_V1_ID, 'dup_invoices');
    const pending = store.reload('./suites/invoices-v1');
    expect(store.busy).toBe(true);
    expect(store.isReloading('./suites/invoices-v1')).toBe(true);
    expect(store.isReloading('./suites/other')).toBe(false);
    expect(await store.reload(null)).toBeNull();
    finish(suiteReloadFixture('invalid-task'));
    const result = await pending;
    expect(result?.suites[0]!.message).toBe('1 task now invalid: late_fees');
    expect(store.busy).toBe(false);
    expect(store.reloadEntryFor('./suites/invoices-v1')?.outcome).toBe('created');
    expect(store.listLoaded).toBe(true);
    // The current pointer may have moved: details, tasks and histories are fetched again.
    expect(store.suites).toEqual({});
    expect(store.tasks).toEqual({});
  });

  it("keeps a failed reload's message and the folder it was for", async () => {
    vi.mocked(reloadSuites).mockRejectedValueOnce(
      new ApiError(504, 'POST /api/suites/reload', 'The suite reload did not finish in 300 s'),
    );
    const store = useSuitesStore();
    expect(await store.reload('./suites/invoices-v1')).toBeNull();
    expect(store.reloadError).toBe(
      'POST /api/suites/reload → 504 · The suite reload did not finish in 300 s',
    );
    expect(store.reloadErrorPath).toBe('./suites/invoices-v1');
    store.clearReloadError();
    expect(store.reloadError).toBeNull();
  });
});
