/**
 * The editor's stores (src/stores/draft.ts, draftTask.ts, draftTaskTools.ts) on the fixture
 * world: autosave after a pause, one write at a time, the form and task.yaml following each
 * other and the form locking on a task.yaml error (plan 12.4), a rename stored only once it
 * is a free folder name, a failed write kept with Try again, Try it after each write, the
 * self-check's no-worker state, and the 25 MB refusal, shown at once and kept by the API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { AUTHORING_LIMITS } from '@hermes-evals/shared';
import * as api from '@/api/drafts';
import { resetDraftFixtures } from '@/api/drafts-fixtures';
import { setScenario } from '@/api/__tests__/scenario';
import { DETAILS_DEBOUNCE_MS, useDraftStore } from '@/stores/draft';
import { TASK_DEBOUNCE_MS, useDraftTaskStore } from '@/stores/draftTask';
import { useDraftTaskToolsStore } from '@/stores/draftTaskTools';

/** Lazy pages and debounced writes take longer while every package's tests run at once. */
const LAZY_MS = 10_000;

vi.mock('@/api/drafts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/drafts')>();
  return {
    ...actual,
    updateDraftTask: vi.fn<typeof actual.updateDraftTask>(actual.updateDraftTask),
    tryDraftCheck: vi.fn<typeof actual.tryDraftCheck>(actual.tryDraftCheck),
  };
});

const FOLDER = 'invoices-v1';

beforeEach(() => {
  setScenario(null);
  resetDraftFixtures();
  setActivePinia(createPinia());
  vi.mocked(api.updateDraftTask).mockClear();
  vi.mocked(api.tryDraftCheck).mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openTask(key = 'overdue_count') {
  const drafts = useDraftStore();
  await drafts.load(FOLDER);
  const task = useDraftTaskStore();
  await task.open(FOLDER, key);
  return task;
}

describe('task autosave', () => {
  it('writes after a pause, once for a burst of edits', async () => {
    vi.useFakeTimers();
    const task = await openTask();
    task.editForm((f) => (f.summary = 'C'));
    task.editForm((f) => (f.summary = 'Count'));
    expect(task.status).toBe('saving');
    expect(api.updateDraftTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TASK_DEBOUNCE_MS + 10);
    expect(api.updateDraftTask).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.updateDraftTask).mock.calls[0]![2].form?.summary).toBe('Count');
    expect(task.status).toBe('saved');
  });

  it('keeps task.yaml in step with a form edit, and the form with a task.yaml edit', async () => {
    const task = await openTask();
    task.editForm((f) => (f.maxTurns = 35));
    await task.flush();
    expect(task.taskYaml).toContain('max_turns: 35');
    task.editYaml(task.taskYaml.replace('max_turns: 35', 'max_turns: 45'));
    await task.flush();
    expect(task.form?.maxTurns).toBe(45);
  });

  it('locks the form while task.yaml has an error, and unlocks when it is fixed', async () => {
    const task = await openTask();
    const good = task.taskYaml;
    task.editYaml(good.replace('primary: true', 'prmary: true'));
    await task.flush();
    expect(task.locked).toBe(true);
    expect(task.form).toBeNull();
    task.editForm((f) => (f.summary = 'ignored'));
    expect(api.updateDraftTask).toHaveBeenCalledTimes(1);
    task.editYaml(good);
    await task.flush();
    expect(task.locked).toBe(false);
    expect(task.form?.checks[0]?.primary).toBe(true);
  });

  it('never sends the form and task.yaml in one write', async () => {
    const task = await openTask();
    task.editForm((f) => (f.summary = 'From the form'));
    task.editYaml(task.taskYaml);
    await task.flush();
    const bodies = vi.mocked(api.updateDraftTask).mock.calls.map((c) => c[2]);
    expect(bodies.every((b) => !(b.form && b.taskYaml !== undefined))).toBe(true);
    expect(bodies[0]?.form).toBeDefined();
  });

  it('stores a rename only when the key is a free folder name', async () => {
    const task = await openTask();
    task.editKey('total_due');
    expect(task.keyProblem).toBe('`total_due` is already a task in `invoices-v1`.');
    task.editKey('overdue count');
    expect(task.keyProblem).toBe(
      'Use letters, digits, ., _ and -, starting with a letter or digit.',
    );
    await task.flush();
    expect(api.updateDraftTask).not.toHaveBeenCalled();
    task.editKey('overdue_total');
    await task.flush();
    expect(task.key).toBe('overdue_total');
    expect(task.detail?.key).toBe('overdue_total');
  });

  it('keeps a failed edit and sends it again on Try again', async () => {
    const task = await openTask();
    vi.mocked(api.updateDraftTask).mockRejectedValueOnce(
      new Error('PUT /api/… → 502 · upstream api:8080 connection refused'),
    );
    task.editPrompt('A new prompt');
    await task.flush();
    expect(task.status).toBe('failed');
    expect(task.saveError).toContain('502');
    expect(task.prompt).toBe('A new prompt');
    await task.flush();
    expect(task.status).toBe('saved');
    expect(task.detail?.prompt).toBe('A new prompt');
  });
});

describe('Try it, self-check and uploads', () => {
  it('tries every answer check against the reference after a write', async () => {
    const task = await openTask();
    const tools = useDraftTaskToolsStore();
    task.editForm((f) => (f.maxTurns = 21));
    await task.flush();
    await vi.waitFor(() => expect(tools.tries.answer?.reference?.status).toBe('passed'), {
      timeout: LAZY_MS,
    });
  });

  it('scores a pasted reply after a pause', async () => {
    vi.useFakeTimers();
    await openTask();
    const tools = useDraftTaskToolsStore();
    tools.setReply('answer', '```json\n{ "overdue_count": 18 }\n```');
    await vi.advanceTimersByTimeAsync(1000);
    expect(tools.tries.answer?.replyResult).toMatchObject({ status: 'failed', value: '18' });
  });

  it('says the worker is offline on a 503 and keeps the draft', async () => {
    setScenario('no-worker');
    resetDraftFixtures();
    await openTask('summary_file');
    const tools = useDraftTaskToolsStore();
    await tools.runSelfCheck();
    expect(tools.selfCheckState).toBe('offline');
  });

  it('refuses a file over 25 MB at once, and the API keeps the refusal (Phase 5b #11)', async () => {
    const task = await openTask();
    const tools = useDraftTaskToolsStore();
    const limit = AUTHORING_LIMITS.suiteMaxFileBytes;
    const big = new File([new Uint8Array(limit + 4096)], 'ledger-2025.parquet');
    await tools.upload([{ file: big, path: big.name }], 'fixture');
    expect(tools.rejected).toEqual([
      {
        name: 'ledger-2025.parquet',
        kind: 'fixture',
        sizeBytes: big.size,
        reason: 'The limit is 25 MB per file.',
        path: 'fixtures/ledger-2025.parquet',
      },
    ]);
    expect(tools.uploads).toEqual([]);
    expect(task.detail?.files.map((f) => f.path)).not.toContain('fixtures/ledger-2025.parquet');

    // A reload reads the refusal back from the API's readiness, without its size.
    await task.reload();
    const row = task.detail!.readiness.rules.find((r) => r.rule === 'file_limits')!;
    expect(row).toMatchObject({
      status: 'problem',
      message: '`ledger-2025.parquet` is over 25 MB.',
      target: { section: 'workspace', field: 'fixtures/ledger-2025.parquet' },
    });
    tools.reset();
    expect(tools.refusals).toEqual([
      {
        name: 'ledger-2025.parquet',
        kind: 'fixture',
        sizeBytes: null,
        reason: 'The limit is 25 MB per file.',
        path: 'fixtures/ledger-2025.parquet',
      },
    ]);

    // Dismissing it deletes the path, which drops the API's record.
    await tools.dismissRejected('ledger-2025.parquet');
    expect(tools.refusals).toEqual([]);
    await task.reload();
    expect(task.detail!.readiness.rules.find((r) => r.rule === 'file_limits')!.status).toBe(
      'passed',
    );
  });

  it('keeps a stored file when its bigger replacement is dismissed', async () => {
    const task = await openTask();
    const tools = useDraftTaskToolsStore();
    const small = new File(['a,b\n'], 'ledger.csv');
    await tools.upload([{ file: small, path: small.name }], 'fixture');
    const big = new File([new Uint8Array(AUTHORING_LIMITS.suiteMaxFileBytes + 1)], 'ledger.csv');
    await tools.upload([{ file: big, path: big.name }], 'fixture');
    await task.reload();
    tools.reset();
    expect(tools.refusals.map((r) => r.path)).toEqual(['fixtures/ledger.csv']);
    await tools.dismissRejected('ledger.csv');
    expect(tools.refusals).toEqual([]);
    expect(task.detail?.files.map((f) => f.path)).toContain('fixtures/ledger.csv');
  });

  it('adds a dropped file into the folder it was dropped in', async () => {
    const task = await openTask();
    const tools = useDraftTaskToolsStore();
    const pdf = new File(['%PDF'], 'payment-terms.pdf');
    await tools.upload([{ file: pdf, path: 'payment-terms.pdf' }], 'fixture', 'docs/');
    expect(task.detail?.files.map((f) => f.path)).toContain('fixtures/docs/payment-terms.pdf');
  });
});

describe('suite draft store', () => {
  it('writes Edit details after a pause and says it is saving', async () => {
    vi.useFakeTimers();
    const drafts = useDraftStore();
    await drafts.load(FOLDER);
    drafts.editDetails(FOLDER, { versionLabel: '' });
    expect(drafts.writes[FOLDER]?.saving).toBe(true);
    expect(drafts.drafts[FOLDER]?.versionLabel).toBe('');
    await vi.advanceTimersByTimeAsync(DETAILS_DEBOUNCE_MS + 10);
    expect(drafts.writes[FOLDER]?.saving).toBe(false);
    expect(drafts.drafts[FOLDER]?.problems.map((p) => p.message)).toContain('Add a version label.');
  });

  it('reorders, removes with Undo and discards', async () => {
    const drafts = useDraftStore();
    const view = (await drafts.load(FOLDER))!;
    const order = view.tasks.map((t) => t.key).reverse();
    await drafts.reorder(FOLDER, order);
    expect(drafts.drafts[FOLDER]?.changes.some((c) => c.kind === 'order')).toBe(true);
    await drafts.removeTask(FOLDER, 'currency_mix');
    expect(drafts.drafts[FOLDER]?.tasks.find((t) => t.key === 'currency_mix')?.state).toBe(
      'removed',
    );
    await drafts.undoRemove(FOLDER, 'currency_mix');
    expect(drafts.drafts[FOLDER]?.tasks.find((t) => t.key === 'currency_mix')?.state).toBe(
      'unchanged',
    );
    await drafts.discard(FOLDER);
    expect(drafts.drafts[FOLDER]).toBeUndefined();
    expect(await drafts.load(FOLDER)).toBeNull();
  });
});
