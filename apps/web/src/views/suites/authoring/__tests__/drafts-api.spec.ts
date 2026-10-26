/**
 * The draft data layer in fixtures mode (src/api/drafts.ts on the world of
 * src/api/drafts-fixtures.ts): every answer parses with its shared contract, edits stick,
 * the form and task.yaml follow each other, and the refusals the editor reacts to come back
 * as the API words them. (Here rather than in src/api/__tests__ for file ownership.)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DraftSummarySchema,
  DraftTaskDetailSchema,
  SuiteDraftViewSchema,
  TryCheckResultSchema,
} from '@hermes-evals/shared';
import * as api from '@/api/drafts';
import { resetDraftFixtures } from '@/api/drafts-fixtures';
import { isApiError } from '@/api/client';
import { setScenario } from '@/api/__tests__/scenario';

const FOLDER = 'invoices-v1';

beforeEach(() => {
  setScenario(null);
  resetDraftFixtures();
});

describe('the draft world', () => {
  it('lists the sample draft and parses with the contracts', async () => {
    const summaries = await api.listDrafts();
    expect(
      DraftSummarySchema.array()
        .parse(summaries)
        .map((s) => s.folder),
    ).toEqual([FOLDER]);
    const view = SuiteDraftViewSchema.parse(await api.getSuiteDraft(FOLDER));
    expect(view.changes.map((c) => c.kind)).toEqual(['added', 'changed', 'label']);
    expect(view.tasks.find((t) => t.key === 'overdue_count')?.state).toBe('added');
    expect(view.tasks.find((t) => t.key === 'total_due')?.state).toBe('changed');
    expect(view.nextVersion).toBe(view.base!.versionNumber + 1);
  });

  it('serves every task detail within its contract', async () => {
    const view = await api.getSuiteDraft(FOLDER);
    for (const row of view.tasks) {
      const detail = await api.getDraftTask(FOLDER, row.key);
      expect(
        DraftTaskDetailSchema.safeParse(detail).success
          ? row.key
          : `${row.key} breaks its contract`,
      ).toBe(row.key);
    }
  });

  it('answers 404 for a folder with no draft, and opens one on the current version', async () => {
    setScenario('draft-none');
    await expect(api.getSuiteDraft(FOLDER)).rejects.toMatchObject({ status: 404 });
    const view = await api.openSuiteDraft(FOLDER);
    expect(view.changes).toEqual([]);
    expect((await api.getSuiteDraft(FOLDER)).id).toBe(view.id);
  });
});

describe('a blank task', () => {
  it('has an empty prompt that row 8 reports as a problem, counted in the header', async () => {
    const { keys } = await api.createDraftTask(FOLDER, { kind: 'blank' });
    const detail = await api.getDraftTask(FOLDER, keys[0]!);
    const row = detail.readiness.rules.find((r) => r.rule === 'answer_block')!;
    expect([row.status, row.message]).toEqual(['problem', 'The prompt is empty.']);
    expect(row.target).toEqual({ section: 'prompt', field: 'prompt' });
    const drawn = detail.readiness.rules.filter((r) => r.status === 'problem').length;
    expect(detail.readiness.counts.problems).toBe(drawn);
  });
});

describe('editing a task', () => {
  it('writes a form edit into task.yaml and keeps it', async () => {
    const before = await api.getDraftTask(FOLDER, 'overdue_count');
    const form = { ...before.form!, maxTurns: 30 };
    const after = await api.updateDraftTask(FOLDER, 'overdue_count', {
      form,
      revision: before.revision,
    });
    expect(after.taskYaml).toContain('max_turns: 30');
    expect(after.revision).toBe(before.revision + 1);
    expect((await api.getDraftTask(FOLDER, 'overdue_count')).form?.maxTurns).toBe(30);
  });

  it('locks the form on an unknown key in task.yaml, with a suggestion', async () => {
    const before = await api.getDraftTask(FOLDER, 'overdue_count');
    const yaml = before.taskYaml!.replace('primary: true', 'prmary: true');
    const after = await api.updateDraftTask(FOLDER, 'overdue_count', { taskYaml: yaml });
    expect(after.form).toBeNull();
    expect(after.formLock).toMatchObject({
      column: 5,
      message: 'unknown key `prmary`. Did you mean `primary`?',
    });
    expect(after.readiness.rules.find((r) => r.rule === 'task_yaml')?.status).toBe('problem');
  });

  it('reads a task.yaml edit back into the form', async () => {
    const before = await api.getDraftTask(FOLDER, 'overdue_count');
    const yaml = before.taskYaml!.replace('max_turns: 20', 'max_turns: 40');
    const after = await api.updateDraftTask(FOLDER, 'overdue_count', { taskYaml: yaml });
    expect(after.formLock).toBeNull();
    expect(after.form?.maxTurns).toBe(40);
  });

  it('refuses a rename onto another task and a key that is not a folder name', async () => {
    const taken = await api
      .updateDraftTask(FOLDER, 'overdue_count', { key: 'total_due' })
      .catch((e: unknown) => e);
    expect(isApiError(taken) && taken.status).toBe(409);
    expect(isApiError(taken) && taken.detail).toBe(
      '`total_due` is already a task in `invoices-v1`.',
    );
    const bad = await api
      .updateDraftTask(FOLDER, 'overdue_count', { key: 'overdue count' })
      .catch((e: unknown) => e);
    expect(isApiError(bad) && bad.status).toBe(400);
  });

  it('marks a renamed base task added, renamed from its key', async () => {
    await api.updateDraftTask(FOLDER, 'total_due', { key: 'total_open' });
    const view = await api.getSuiteDraft(FOLDER);
    expect(view.changes).toContainEqual({
      kind: 'added',
      key: 'total_open',
      renamedFrom: 'total_due',
    });
  });

  it('refuses an upload under verify/ and a file over 25 MB', async () => {
    const big = new File(['x'], 'ledger-2025.parquet');
    Object.defineProperty(big, 'size', { value: 31.2 * 1024 * 1024 });
    const { uploadDraftFile } = await import('@/api/drafts-upload');
    await expect(
      uploadDraftFile(FOLDER, 'overdue_count', big, { kind: 'fixture' }),
    ).rejects.toMatchObject({ status: 413 });
    const script = new File(['print(1)'], 'check.py');
    await expect(
      uploadDraftFile(FOLDER, 'overdue_count', script, {
        kind: 'fixture',
        path: '../verify/check.py',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('adds an uploaded CSV with its rows and columns', async () => {
    const { uploadDraftFile } = await import('@/api/drafts-upload');
    const csv = new File(['invoice,amount\nA,1\nB,2\n'], 'ledger.csv', { type: 'text/csv' });
    const detail = await uploadDraftFile(FOLDER, 'overdue_count', csv, { kind: 'fixture' });
    const file = detail.files.find((f) => f.path === 'fixtures/ledger.csv');
    expect(file).toMatchObject({
      kind: 'fixture',
      visibility: 'agent',
      agentPath: '/workspace/ledger.csv',
      typeLabel: 'CSV · 2 rows · 2 columns',
    });
  });

  it('marks a removed base task, and drops an added one', async () => {
    const removed = await api.removeDraftTask(FOLDER, 'currency_mix');
    expect(removed.tasks.find((t) => t.key === 'currency_mix')?.state).toBe('removed');
    const dropped = await api.removeDraftTask(FOLDER, 'overdue_count');
    expect(dropped.tasks.some((t) => t.key === 'overdue_count')).toBe(false);
  });
});

describe('Try it and the self-check', () => {
  it('scores the reference and a pasted reply', async () => {
    const reference = TryCheckResultSchema.parse(
      await api.tryDraftCheck(FOLDER, 'overdue_count', { key: 'answer', reply: null }),
    );
    expect(reference).toMatchObject({
      against: 'reference',
      status: 'passed',
      score: 1,
      comment: '|17 − 17| = 0 ≤ 0',
    });
    const failed = await api.tryDraftCheck(FOLDER, 'overdue_count', {
      key: 'answer',
      reply: '18 are overdue.\n\n```json\n{ "overdue_count": 18 }\n```',
    });
    expect(failed).toMatchObject({
      status: 'failed',
      score: 0,
      comment: '|18 − 17| = 1 > 0',
      value: '18',
    });
    const none = await api.tryDraftCheck(FOLDER, 'overdue_count', {
      key: 'answer',
      reply: '17 are overdue.',
    });
    expect(none).toMatchObject({
      status: 'ungradable',
      score: null,
      extraction: { status: 'missing' },
    });
  });

  it('answers 503 for the self-check without a worker', async () => {
    setScenario('no-worker');
    await expect(api.runDraftSelfCheck(FOLDER, 'summary_file')).rejects.toMatchObject({
      status: 503,
    });
  });

  it('runs the self-check and moves the readiness rows', async () => {
    const before = await api.getDraftTask(FOLDER, 'summary_file');
    expect(before.readiness.rules.find((r) => r.rule === 'self_check')?.status).toBe('pending');
    await api.runDraftSelfCheck(FOLDER, 'summary_file');
    const after = await api.getDraftTask(FOLDER, 'summary_file');
    expect(after.readiness.rules.find((r) => r.rule === 'self_check')?.status).toBe('passed');
  });
});

describe('saving', () => {
  it('saves the next version and the draft is gone', async () => {
    const outcome = await api.saveSuiteDraft(FOLDER, {});
    expect(outcome.kind).toBe('saved');
    await expect(api.getSuiteDraft(FOLDER)).rejects.toMatchObject({ status: 404 });
  });

  it('answers the conflict when the folder moved past the base, and combines onto it', async () => {
    setScenario('draft-conflict-overlap');
    const outcome = await api.saveSuiteDraft(FOLDER, {});
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') return;
    expect(outcome.body.conflict.overlap).toEqual(['total_due']);
    const rebased = await api.rebaseSuiteDraft(FOLDER, {
      onto: outcome.body.conflict.current.versionNumber,
      choices: [{ key: 'total_due', keep: 'mine' }],
    });
    expect(rebased.kind === 'rebased' && rebased.draft.conflict).toBeNull();
  });

  it('names the download after the folder and the version', () => {
    expect(api.suiteVersionZip(FOLDER, 6)).toEqual({
      url: '/api/suites/invoices-v1/versions/6/zip',
      fileName: 'invoices-v1-v6.zip',
    });
  });
});
