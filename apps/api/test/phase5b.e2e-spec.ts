/**
 * Phase 5b end to end: suite authoring (plan 4.6) on the real AppModule and
 * WorkerModule over a fresh Postgres 17 database, with real pg-boss, the real
 * loader, the draft jobs and the save's writes to a temporary SUITES_DIR. As
 * in Phases 2 to 6 only the sandbox is replaced (test/support/fake-engine.ts),
 * so no model is ever called; verifier scripts run as subprocesses, the
 * runner tests choose (the container runner has its own gated spec). Every
 * HTTP answer is parsed with its shared schema.
 *
 * Flow E from nothing to an experiment: a new suite through the draft API
 * (two tasks, uploads, checks, readiness clean), the worker's self-check,
 * Save as v1, an experiment on v1. Then an edit saved as v2; the two save
 * conflicts (files edited on disk without a reload, and a version moved by a
 * reload), each combined with rebase; a CSV import; v1 downloaded and
 * compared; a task restored from v1. The zip import, Reload all and the
 * committed suites' round trip are in phase5b-suites.e2e-spec.ts.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DraftConflictBodySchema,
  DraftReviewSchema,
  DraftSelfCheckViewSchema,
  DraftSummarySchema,
  DraftTaskCreateResultSchema,
  SuiteDraftViewSchema,
  SuiteListRowSchema,
  SuiteReloadResultSchema,
  TaskImportResultSchema,
  TaskImportValidationSchema,
  TaskReadinessSchema,
  suiteVersionZipName,
  type TaskImportSettings,
} from '@hermes-evals/shared';
import { Phase2World, type ConfigRef } from './support/phase2-app.js';
import {
  AuthoringClient,
  FLOW_E,
  QUESTIONS_CSV,
  readTree,
  sha256,
  TOTAL,
  unzip,
  VENDOR_SUMMARY,
} from './support/phase5b-authoring.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!SERVER_URL)('Phase 5b on Postgres 17: suite authoring', () => {
  const world = new Phase2World(SERVER_URL!, 'phase5b_e2e');
  const api = new AuthoringClient(() => world.api);
  const draft = `/suites/${FLOW_E}/draft`;
  const task = (key: string) => `${draft}/tasks/${key}`;
  const folder = () => join(world.suitesDir, FLOW_E);
  let configs: { baseline: ConfigRef; candidate: ConfigRef };
  /** The Flow E folder as v1 saved it. */
  let v1Files: Map<string, Buffer>;

  beforeAll(async () => {
    await world.start();
    await world.startWorker();
    configs = {
      baseline: await world.configuration('baseline', 'mock/scripted'),
      candidate: await world.configuration('candidate', 'mock/scripted', { maxTurns: 15 }),
    };
  }, 180_000);

  afterAll(() => world.stop(), 120_000);

  const detail = (key: string) => api.task(FLOW_E, key);
  const edit = (key: string, body: object) => api.editTask(FLOW_E, key, body);
  const open = (name: string, status = 201) => api.openDraft(name, status);
  const save = (name: string, body: object = {}) => api.saveDraft(name, body);

  it('creates a suite from nothing: two tasks, uploads, checks, readiness clean', async () => {
    expect(await api.get('/suites/drafts', z.array(DraftSummarySchema))).toEqual([]);
    const created = await api.json(
      'post',
      '/suites/drafts',
      { name: FLOW_E, versionLabel: '0.1', description: 'Flow E', from: { kind: 'empty' } },
      201,
      SuiteDraftViewSchema,
    );
    expect(created).toMatchObject({ folder: FLOW_E, origin: 'empty', base: null, nextVersion: 1 });
    expect(created.problems.map((p) => p.code)).toEqual(['no_tasks']);
    // The name is held: a second new suite of that name is refused.
    await api.refused(
      'post',
      '/suites/drafts',
      { name: FLOW_E, versionLabel: '0.1', from: { kind: 'empty' } },
      409,
    );

    const total = await api.writeTask(FLOW_E, TOTAL);
    expect(total.state).toBe('added');
    expect(total.files.map((f) => [f.path, f.kind])).toEqual(
      expect.arrayContaining([['fixtures/amounts.csv', 'fixture']]),
    );
    // An answer check self-checks in the API: nothing waits for the worker.
    expect(total.readiness.summary).toBe('ready');

    const summary = await api.writeTask(FLOW_E, VENDOR_SUMMARY);
    // The expected upload named its folder in task.yaml.
    expect(summary.form).toMatchObject({ expectedWorkspace: 'expected' });
    expect(summary.readiness.counts.problems).toBe(0);
    expect(summary.readiness.needsWorker).toBe(true);
    expect(summary.readiness.rules.find((r) => r.rule === 'self_check')!.status).toBe('pending');

    // verify/ is never written through the API (R7).
    await api.refused(
      'patch',
      `${task(VENDOR_SUMMARY.key)}/files/${encodeURIComponent('fixtures/invoices.csv')}`,
      { path: 'verify/invoices.csv' },
      400,
    );
    await api.refused(
      'put',
      task(VENDOR_SUMMARY.key),
      { rubrics: [{ path: 'verify/rubric.md', text: 'x' }] },
      400,
    );

    const view = await api.get(draft, SuiteDraftViewSchema);
    expect(view.problems).toEqual([]);
    expect(view.changes).toEqual([
      { kind: 'added', key: 'total', renamedFrom: null },
      { kind: 'added', key: 'vendor_summary', renamedFrom: null },
    ]);
  });

  it("self-checks the file check in the worker, and readiness shows the worker's run", async () => {
    const run = await api.json(
      'post',
      `${task(VENDOR_SUMMARY.key)}/self-check`,
      {},
      200,
      DraftSelfCheckViewSchema,
    );
    expect(run).toMatchObject({ status: 'passed', current: true });
    // The positive run on the expected workspace, then the negative control on the fixtures.
    expect(run.results.map((r) => [r.key, r.mode, r.expect, r.status])).toEqual([
      ['summary_csv', 'workspace', 'pass', 'passed'],
      ['summary_csv', 'workspace', 'fail', 'failed'],
    ]);
    const readiness = await api.get(`${task(VENDOR_SUMMARY.key)}/readiness`, TaskReadinessSchema);
    expect(readiness.summary).toBe('ready');
  });

  it('saves v1 and runs an experiment on it', async () => {
    const review = await api.get(`${draft}/review`, DraftReviewSchema);
    expect(review.invalid).toEqual([]);
    expect(review.writes.map((w) => w.path)).toEqual(
      expect.arrayContaining([
        `./suites/${FLOW_E}/suite.yaml`,
        `./suites/${FLOW_E}/total/prompt.md`,
        `./suites/${FLOW_E}/vendor_summary/expected/summary.csv`,
      ]),
    );

    const saved = await save(FLOW_E);
    expect(saved).toMatchObject({ outcome: 'created', taskCount: 2, validCount: 2, invalid: [] });
    expect(saved.suite).toMatchObject({ name: FLOW_E, versionNumber: 1, versionLabel: '0.1' });
    await api.refused('get', draft, undefined, 404);

    // The folder is on disk, every text exactly as typed, and no staging folder is left.
    v1Files = await readTree(folder());
    expect([...v1Files.keys()]).toEqual([
      'suite.yaml',
      'total/fixtures/amounts.csv',
      'total/prompt.md',
      'total/reference.json',
      'total/task.yaml',
      'vendor_summary/expected/summary.csv',
      'vendor_summary/fixtures/invoices.csv',
      'vendor_summary/prompt.md',
      'vendor_summary/reference.json',
      'vendor_summary/task.yaml',
    ]);
    expect(v1Files.get('total/prompt.md')!.toString()).toBe(TOTAL.prompt);
    expect(v1Files.get('total/reference.json')!.toString()).toBe(TOTAL.reference);
    expect(parseYaml(v1Files.get('suite.yaml')!.toString())).toEqual({
      name: FLOW_E,
      version_label: '0.1',
      description: 'Flow E',
      tasks: ['total', 'vendor_summary'],
    });
    const leftovers = (await readTree(world.suitesDir)).keys();
    expect([...leftovers].filter((p) => p.startsWith('.'))).toEqual([]);

    const body = await world.launchBody('Flow E on v1', configs.baseline, [configs.candidate], {
      suiteId: saved.suite.suiteId,
      taskKeys: ['total', 'vendor_summary'],
    });
    const id = (await api.json('post', '/experiments', body, 201, z.object({ id: z.string() }))).id;
    const done = await world.completed(id, 120_000);
    expect(done.suite).toMatchObject({ name: FLOW_E, versionNumber: 1 });
    expect(done.totalRuns).toBe(4);
    expect(done.counts.scored).toBe(4);
  }, 180_000);

  it('saves an edit as v2: one line of task.yaml, every other file untouched', async () => {
    const opened = await open(FLOW_E);
    expect(opened.base).toMatchObject({ versionNumber: 1 });
    expect(opened.tasks.map((t) => t.state)).toEqual(['unchanged', 'unchanged']);
    expect(opened.changes).toEqual([]);
    // Opening again answers the open draft.
    expect((await open(FLOW_E, 200)).id).toBe(opened.id);

    const before = await detail('total');
    const changed = await edit('total', {
      form: { ...before.form!, summary: 'Sum the amount column' },
      revision: before.revision,
    });
    expect(changed.state).toBe('changed');
    // A stale revision is refused.
    await api.refused('put', task('total'), { prompt: 'x', revision: before.revision }, 409);

    const saved = await save(FLOW_E);
    expect(saved).toMatchObject({ outcome: 'created', suite: { versionNumber: 2 } });
    expect(saved.changes.changed).toEqual(['total']);
    const after = await readTree(folder());
    const lines = (p: string, files: Map<string, Buffer>) => files.get(p)!.toString().split('\n');
    const yamlBefore = lines('total/task.yaml', v1Files);
    const yamlAfter = lines('total/task.yaml', after);
    expect(yamlAfter.filter((line, i) => line !== yamlBefore[i])).toEqual([
      'summary: Sum the amount column',
    ]);
    for (const [path, bytes] of v1Files) {
      if (path !== 'total/task.yaml' && path !== 'suite.yaml') {
        expect(sha256(after.get(path)!), path).toBe(sha256(bytes));
      }
    }
  });

  it('refuses a save over files edited on disk without a reload, then combines onto them', async () => {
    await open(FLOW_E);
    const mine = `${TOTAL.prompt}Show your working.\n`;
    await edit('total', { prompt: mine });
    // Someone edits the same task on disk and does not reload.
    await writeFile(join(folder(), 'total', 'prompt.md'), `${TOTAL.prompt}Round to the cent.\n`);

    const refused = await api.json('post', `${draft}/save`, {}, 409, DraftConflictBodySchema);
    expect(refused.conflict).toMatchObject({
      cause: 'disk_changed',
      baseVersion: 2,
      current: { versionNumber: 3 },
      overlap: ['total'],
    });
    // Nothing of the draft reached the disk.
    expect(await readFile(join(folder(), 'total', 'prompt.md'), 'utf8')).toContain('cent');

    const combined = await api.json(
      'post',
      `${draft}/rebase`,
      { onto: 3, choices: [{ key: 'total', keep: 'mine' }] },
      200,
      SuiteDraftViewSchema,
    );
    expect(combined).toMatchObject({ base: { versionNumber: 3 }, conflict: null });
    const saved = await save(FLOW_E);
    expect(saved).toMatchObject({ outcome: 'created', suite: { versionNumber: 4 } });
    expect(await readFile(join(folder(), 'total', 'prompt.md'), 'utf8')).toBe(mine);
  });

  it('shows a version moved by a reload as a conflict, and combines the two sides', async () => {
    await open(FLOW_E);
    const before = await detail(VENDOR_SUMMARY.key);
    await edit(VENDOR_SUMMARY.key, { form: { ...before.form!, maxTurns: 12 } });
    const edited = `${(await readFile(join(folder(), 'total', 'prompt.md'), 'utf8')).trimEnd()} Thank you.\n`;
    await writeFile(join(folder(), 'total', 'prompt.md'), edited);
    const reload = await api.json(
      'post',
      '/suites/reload',
      { path: FLOW_E },
      200,
      SuiteReloadResultSchema,
    );
    expect(reload.suites[0]).toMatchObject({ outcome: 'created', versionNumber: 5 });

    const view = await api.get(draft, SuiteDraftViewSchema);
    expect(view.conflict).toMatchObject({
      cause: 'version_moved',
      baseVersion: 4,
      current: { versionNumber: 5 },
      overlap: [],
      draftKeys: [VENDOR_SUMMARY.key],
    });
    expect(
      (await api.json('post', `${draft}/save`, {}, 409, DraftConflictBodySchema)).conflict,
    ).toMatchObject({ cause: 'version_moved', current: { versionNumber: 5 } });

    await api.json('post', `${draft}/rebase`, { onto: 5, choices: [] }, 200, SuiteDraftViewSchema);
    const saved = await save(FLOW_E);
    expect(saved).toMatchObject({ outcome: 'created', suite: { versionNumber: 6 } });
    expect(await readFile(join(folder(), 'total', 'prompt.md'), 'utf8')).toBe(edited);
    expect(await readFile(join(folder(), VENDOR_SUMMARY.key, 'task.yaml'), 'utf8')).toContain(
      'max_turns: 12',
    );
  });

  it('imports tasks from a CSV, mapping each column, and saves them valid', async () => {
    await open(FLOW_E);
    const file = { field: 'file', name: 'questions.csv', bytes: QUESTIONS_CSV };
    const read = await api.upload(
      `${draft}/import/validate`,
      {},
      [file],
      200,
      TaskImportValidationSchema,
    );
    expect(read.problems).toEqual([]);
    expect(read.file).toMatchObject({ format: 'csv', rowCount: 2 });
    expect(read.file!.columns.map((c) => c.name)).toEqual(['key', 'question', 'answer']);

    const settings: TaskImportSettings = {
      mapping: [
        { column: 'key', use: 'task_key' },
        { column: 'question', use: 'prompt' },
        { column: 'answer', use: 'reference_value' },
      ],
      keyPrefix: null,
      answerPath: 'total',
      workspace: { from: 'task', key: 'total' },
      checks: { from: 'task', key: 'total' },
      limits: { maxTurns: 10, runBudgetSeconds: 120, toolsetsNeeded: ['file'] },
      appendAnswerInstructions: true,
      keyFixes: [],
    };
    const fields = { settings: JSON.stringify(settings) };
    const preview = await api.upload(
      `${draft}/import/validate`,
      fields,
      [file],
      200,
      TaskImportValidationSchema,
    );
    expect(preview.preview).toMatchObject({ addCount: 2, fixCount: 0 });
    expect(preview.preview!.rows.map((r) => [r.key, r.referenceValue, r.readiness])).toEqual([
      ['sum_twice', '21', 'ready'],
      ['sum_half', '5.25', 'ready'],
    ]);

    const added = await api.upload(`${draft}/import`, fields, [file], 201, TaskImportResultSchema);
    expect(added.added).toEqual(['sum_twice', 'sum_half']);
    const twice = await detail('sum_twice');
    expect(JSON.parse(twice.reference!)).toEqual({ total: 21 });
    expect(twice.files.map((f) => f.path)).toContain('fixtures/amounts.csv');

    const saved = await save(FLOW_E);
    expect(saved).toMatchObject({ outcome: 'created', taskCount: 4, validCount: 4 });
    expect(saved.changes.added).toEqual(['sum_twice', 'sum_half']);
  });

  it('downloads v1 as a zip holding the files v1 saved, byte for byte', async () => {
    const zip = await api.download(`/suites/${FLOW_E}/versions/1/zip`);
    expect(zip.headers['content-type']).toBe('application/zip');
    expect(zip.headers['content-disposition']).toContain(
      `filename="${suiteVersionZipName(FLOW_E, 1)}"`,
    );
    const entries = await unzip(zip.bytes);
    expect([...entries.keys()].sort()).toEqual([...v1Files.keys()].map((p) => `${FLOW_E}/${p}`));
    for (const [path, bytes] of v1Files) {
      const entry = entries.get(`${FLOW_E}/${path}`)!;
      // suite.yaml is written anew from the stored version; every other file is its blob.
      if (path === 'suite.yaml')
        expect(parseYaml(entry.toString())).toEqual(parseYaml(bytes.toString()));
      else expect(sha256(entry), path).toBe(sha256(bytes));
    }
  });

  it("restores v1's task into a draft from its blobs and saves it back to disk", async () => {
    await open(FLOW_E);
    const restored = await api.json(
      'post',
      `${draft}/tasks`,
      { kind: 'restore', suiteVersion: 1, key: 'total' },
      201,
      DraftTaskCreateResultSchema,
    );
    expect(restored.keys).toEqual(['total']);
    expect(restored.draft.changes).toContainEqual(
      expect.objectContaining({ kind: 'restored', key: 'total', fromSuiteVersion: 1 }),
    );
    const total = await detail('total');
    expect(total).toMatchObject({ state: 'restored', restoredFrom: { suiteVersion: 1 } });
    expect(total.prompt).toBe(v1Files.get('total/prompt.md')!.toString());

    const saved = await save(FLOW_E);
    expect(saved).toMatchObject({ outcome: 'created', suite: { versionNumber: 8 } });
    const now = await readTree(folder());
    for (const path of ['total/prompt.md', 'total/task.yaml', 'total/reference.json']) {
      expect(sha256(now.get(path)!), path).toBe(sha256(v1Files.get(path)!));
    }
    const list = await api.get('/suites', z.array(SuiteListRowSchema));
    expect(list.find((row) => row.name === FLOW_E)).toMatchObject({
      versionNumber: 8,
      currentChanges: expect.objectContaining({ changed: ['total'] }),
    });
  });
});
