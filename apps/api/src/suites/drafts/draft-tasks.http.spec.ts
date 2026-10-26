/**
 * The task and file routes of a draft over HTTP (plan 4.6 and 11; SA.4 to
 * SA.8): the editor's view, form edits that keep task.yaml's comments and
 * key order, a state that follows the content (an edit undone is
 * unchanged again), rename, remove and undo, blank, duplicate, restore of
 * an older version and revert, Try it, and the diff against the base. The
 * file routes are in draft-files.http.spec.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DraftTaskCreateResultSchema,
  DraftTaskDetailSchema,
  DraftTaskDiffSchema,
  SuiteDraftViewSchema,
  TaskReadinessSchema,
  TryCheckResultSchema,
  type DraftTaskDetail,
  type TaskForm,
} from '@hermes-evals/shared';
import {
  INVOICES_CSV,
  startDraftsApp,
  TOTAL_DUE_YAML,
  WRITE,
  type DraftsApp,
} from './drafts-testing.helper-spec.js';

let s: DraftsApp;
const base = '/api/suites/invoices-v1/draft';

beforeAll(async () => {
  s = await startDraftsApp();
  await s.http().post(base).set(WRITE).expect(201);
}, 120_000);

afterAll(async () => {
  await s?.close();
});

const detail = (body: unknown): DraftTaskDetail => DraftTaskDetailSchema.parse(body);
const get = async (key: string) =>
  detail((await s.http().get(`${base}/tasks/${key}`).expect(200)).body);
const put = (key: string, body: object) =>
  s.http().put(`${base}/tasks/${key}`).set(WRITE).send(body);
const draftView = async () =>
  SuiteDraftViewSchema.parse((await s.http().get(base).expect(200)).body);

describe('the task editor', () => {
  it('shows the task: texts verbatim, the form, every file and the readiness', async () => {
    const task = await get('total_due');
    expect(task).toMatchObject({
      key: 'total_due',
      state: 'unchanged',
      base: { key: 'total_due', version: 2, suiteVersion: 2 },
      restoredFrom: null,
      taskYaml: TOTAL_DUE_YAML,
      formLock: null,
      draft: { folder: 'invoices-v1', baseVersion: 2, nextVersion: 3 },
    });
    expect(task.form).toMatchObject({ maxTurns: 20, answerPath: 'total_due' });
    expect(task.files.map((f) => [f.path, f.kind, f.visibility, f.agentPath])).toEqual([
      ['task.yaml', 'task_yaml', 'hidden', null],
      ['prompt.md', 'prompt', 'agent', 'task.txt'],
      ['reference.json', 'reference', 'hidden', null],
      ['fixtures/invoices.csv', 'fixture', 'agent', '/workspace/invoices.csv'],
    ]);
    expect(task.files[3]!.typeLabel).toBe('CSV · 3 rows · 3 columns');
    expect(task.readiness.summary).toBe('ready');
    const summary = await get('summary_file');
    expect(summary.files.find((f) => f.path === 'verify/check.py')).toMatchObject({
      kind: 'verifier',
      visibility: 'hidden',
    });
    expect(summary.selfCheck).toMatchObject({ status: 'passed', current: true });
    expect(summary.readiness.rules.find((r) => r.rule === 'self_check')!.status).toBe('passed');
  });

  it('writes one form field back into task.yaml, comments and key order kept', async () => {
    const before = await get('total_due');
    const form: TaskForm = { ...before.form!, maxTurns: 30 };
    const after = detail(
      (await put('total_due', { form, revision: before.revision }).expect(200)).body,
    );
    expect(after.taskYaml).toBe(TOTAL_DUE_YAML.replace('max_turns: 20', 'max_turns: 30'));
    expect(after.state).toBe('changed');
    expect((await draftView()).changes).toEqual([{ kind: 'changed', key: 'total_due' }]);
    // Undone, the task hashes to its base again: no change left.
    const undone = detail((await put('total_due', { form: before.form }).expect(200)).body);
    expect(undone.taskYaml).toBe(TOTAL_DUE_YAML);
    expect(undone.state).toBe('unchanged');
    expect((await draftView()).changes).toEqual([]);
  });

  it('adds a judge check and its rubric in one edit, the rubric hidden from the agent', async () => {
    const judged = `${TOTAL_DUE_YAML}  - key: judge\n    type: llm_judge\n    params: { rubric: rubric.md }\n`;
    const task = detail(
      (
        await put('total_due', {
          taskYaml: judged,
          rubrics: [{ path: 'rubric.md', text: 'Score 1 when the total is right.\n' }],
        }).expect(200)
      ).body,
    );
    expect(task.rubrics).toEqual([
      { path: 'rubric.md', text: 'Score 1 when the total is right.\n' },
    ]);
    expect(task.files.find((f) => f.path === 'rubric.md')).toMatchObject({
      kind: 'rubric',
      visibility: 'hidden',
    });
    expect(task.readiness.rules.find((r) => r.rule === 'check_settings')!.status).toBe('passed');
    await s.http().post(`${base}/tasks/total_due/revert`).set(WRITE).expect(200);
  });

  it('refuses an edit on an older revision of the task, and both the form and task.yaml', async () => {
    const task = await get('total_due');
    await put('total_due', { prompt: 'x', revision: task.revision - 1 }).expect(409);
    await put('total_due', { form: task.form, taskYaml: 'summary: x\n' }).expect(400);
  });

  it('stores what the rules refuse, and reports it', async () => {
    const res = detail(
      (await put('total_due', { reference: '{ "total_due": 12,, }' }).expect(200)).body,
    );
    expect(res.reference).toBe('{ "total_due": 12,, }');
    const row = res.readiness.rules.find((r) => r.rule === 'reference_json')!;
    expect(row.status).toBe('problem');
    expect(row.message).toMatch(/^line 1, col 19: /);
    const locked = detail(
      (
        await put('total_due', {
          taskYaml: TOTAL_DUE_YAML.replace('    primary: true', '    prmary: true'),
        }).expect(200)
      ).body,
    );
    expect(locked.form).toBeNull();
    expect(locked.formLock).toMatchObject({
      line: 13,
      message: 'unknown key `prmary`. Did you mean `primary`?',
    });
    await put('total_due', { form: (await get('summary_file')).form }).expect(409);
    await s.http().post(`${base}/tasks/total_due/revert`).set(WRITE).expect(200);
    expect((await get('total_due')).state).toBe('unchanged');
  });

  it('renames a task, refusing a key another task holds', async () => {
    await put('total_due', { key: 'summary_file' }).expect(409);
    const renamed = detail((await put('total_due', { key: 'total_open' }).expect(200)).body);
    expect(renamed).toMatchObject({
      key: 'total_open',
      state: 'added',
      base: { key: 'total_due' },
    });
    expect(renamed.readiness.rules[0]).toMatchObject({ rule: 'key_summary', status: 'warning' });
    expect((await draftView()).changes).toEqual([
      { kind: 'added', key: 'total_open', renamedFrom: 'total_due' },
    ]);
    const back = detail(
      (await s.http().post(`${base}/tasks/total_open/revert`).set(WRITE).expect(200)).body,
    );
    expect(back).toMatchObject({ key: 'total_due', state: 'unchanged' });
  });

  it('marks a base task removed and brings it back', async () => {
    const removed = SuiteDraftViewSchema.parse(
      (await s.http().delete(`${base}/tasks/summary_file`).set(WRITE).expect(200)).body,
    );
    expect(removed.changes).toEqual([{ kind: 'removed', key: 'summary_file' }]);
    expect(removed.problems).toEqual([]);
    const undone = detail((await put('summary_file', { removed: false }).expect(200)).body);
    expect(undone.state).toBe('unchanged');
  });
});

describe('adding tasks', () => {
  it('adds a blank task with a free key, and drops it', async () => {
    const created = DraftTaskCreateResultSchema.parse(
      (await s.http().post(`${base}/tasks`).set(WRITE).send({ kind: 'blank' }).expect(201)).body,
    );
    expect(created.keys).toEqual(['new_task']);
    const blank = await get('new_task');
    expect(blank).toMatchObject({ state: 'added', prompt: '', reference: null });
    expect(blank.readiness.summary).toBe('problems');
    const second = DraftTaskCreateResultSchema.parse(
      (await s.http().post(`${base}/tasks`).set(WRITE).send({ kind: 'blank' }).expect(201)).body,
    );
    expect(second.keys).toEqual(['new_task_2']);
    for (const key of ['new_task', 'new_task_2']) {
      const after = SuiteDraftViewSchema.parse(
        (await s.http().delete(`${base}/tasks/${key}`).set(WRITE).expect(200)).body,
      );
      expect(after.tasks.map((t) => t.key)).not.toContain(key);
    }
  });

  it('duplicates a task beside it, with its files', async () => {
    const created = DraftTaskCreateResultSchema.parse(
      (
        await s
          .http()
          .post(`${base}/tasks`)
          .set(WRITE)
          .send({ kind: 'duplicate', from: 'total_due' })
          .expect(201)
      ).body,
    );
    expect(created.keys).toEqual(['total_due_copy']);
    expect(created.draft.tasks.map((t) => t.key)).toEqual([
      'total_due',
      'total_due_copy',
      'summary_file',
    ]);
    const copy = await get('total_due_copy');
    expect(copy.files.map((f) => f.path)).toContain('fixtures/invoices.csv');
    expect(copy.readiness.summary).toBe('ready');
    await s
      .http()
      .post(`${base}/tasks`)
      .set(WRITE)
      .send({ kind: 'duplicate', from: 'total_due', key: 'summary_file' })
      .expect(409);
    await s.http().delete(`${base}/tasks/total_due_copy`).set(WRITE).expect(200);
  });

  it('restores an older version of a task from its blobs, and reverts it', async () => {
    const created = DraftTaskCreateResultSchema.parse(
      (
        await s
          .http()
          .post(`${base}/tasks`)
          .set(WRITE)
          .send({ kind: 'restore', suiteVersion: 1, key: 'total_due' })
          .expect(201)
      ).body,
    );
    expect(created.draft.changes).toEqual([
      { kind: 'restored', key: 'total_due', fromTaskVersion: 1, fromSuiteVersion: 1 },
    ]);
    const restored = await get('total_due');
    expect(restored).toMatchObject({
      state: 'restored',
      restoredFrom: { taskVersion: 1, suiteVersion: 1 },
    });
    expect(restored.reference).toBe('{\n  "total_due": 1000.5\n}\n');
    const diff = DraftTaskDiffSchema.parse(
      (await s.http().get(`${base}/tasks/total_due/diff`).expect(200)).body,
    );
    expect(diff.from).toMatchObject({ suiteVersion: 2, taskVersion: 2 });
    expect(diff.reference).toEqual([
      { path: 'total_due', kind: 'changed', before: 1234.56, after: 1000.5 },
    ]);
    expect(diff.files.map((f) => [f.path, f.change])).toEqual([
      ['task.yaml', 'unchanged'],
      ['prompt.md', 'changed'],
      ['reference.json', 'changed'],
      ['fixtures/invoices.csv', 'unchanged'],
    ]);
    expect(diff.prompt.filter((l) => l.kind !== 'same').map((l) => l.text)).toEqual([
      'What is the total amount still due?',
      'What is the total amount due?',
    ]);
    await s
      .http()
      .post(`${base}/tasks`)
      .set(WRITE)
      .send({ kind: 'restore', suiteVersion: 7, key: 'total_due' })
      .expect(404);
    await s.http().post(`${base}/tasks/total_due/revert`).set(WRITE).expect(200);
    expect((await draftView()).changes).toEqual([]);
  });

  it('copies tasks from another suite version, refusing a key the draft holds', async () => {
    await s
      .http()
      .post(`${base}/tasks`)
      .set(WRITE)
      .send({ kind: 'copy', suite: 'invoices-v1', versionNumber: 1, keys: ['total_due'] })
      .expect(409);
    await s.http().post(`${base}/tasks/new_task/revert`).set(WRITE).expect(404);
  });
});

describe('Try it and readiness', () => {
  it('tries an answer check on the reference and on pasted replies', async () => {
    const tryIt = async (reply: string | null) =>
      TryCheckResultSchema.parse(
        (
          await s
            .http()
            .post(`${base}/tasks/total_due/try`)
            .set(WRITE)
            .send({ key: 'answer', reply })
            .expect(200)
        ).body,
      );
    expect(await tryIt(null)).toMatchObject({
      against: 'reference',
      status: 'passed',
      score: 1,
      path: 'total_due',
      value: '1234.56',
      extraction: null,
      passAt: null,
    });
    const passed = await tryIt('The total is below.\n\n```json\n{ "total_due": 1234.56 }\n```\n');
    expect(passed).toMatchObject({
      against: 'reply',
      status: 'passed',
      value: '1234.56',
      extraction: { status: 'found', block: '{ "total_due": 1234.56 }', error: null },
    });
    const failed = await tryIt('```json\n{ "total_due": 1000 }\n```');
    expect(failed).toMatchObject({ status: 'failed', score: 0, value: '1000' });
    const ungradable = await tryIt('The total is 1,234.56 EUR.');
    expect(ungradable).toMatchObject({
      status: 'ungradable',
      score: null,
      comment: 'No fenced json block found in the reply',
      extraction: { status: 'missing', block: null },
    });
  });

  it('refuses a check that is not an answer check, and one that does not exist', async () => {
    const tool = await s
      .http()
      .post(`${base}/tasks/total_due/try`)
      .set(WRITE)
      .send({ key: 'reads_invoices', reply: null })
      .expect(422);
    expect(tool.body.message).toMatch(/checked when runs are scored/);
    await s
      .http()
      .post(`${base}/tasks/total_due/try`)
      .set(WRITE)
      .send({ key: 'nope', reply: null })
      .expect(404);
  });

  it('answers the readiness rules', async () => {
    const readiness = TaskReadinessSchema.parse(
      (await s.http().get(`${base}/tasks/summary_file/readiness`).expect(200)).body,
    );
    expect(readiness.needsWorker).toBe(true);
    expect(readiness.rules.map((r) => r.status)).not.toContain('problem');
  });

  it('answers 404 for a task the draft does not hold', async () => {
    await s.http().get(`${base}/tasks/nope`).expect(404);
    await s.http().get('/api/suites/invoices-v1/draft/tasks/bad%20key').expect(400);
  });
});

it('keeps the fixture the suite loaded', () => {
  expect(INVOICES_CSV).toContain('INV-1');
});
