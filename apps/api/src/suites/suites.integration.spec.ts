/**
 * The suite read services on PGlite (real migrations and triggers), over
 * rows inserted directly (seed-spec.ts) and files in a real blob store.
 * Every view is parsed with its shared schema.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { text } from 'node:stream/consumers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SuiteDetailSchema,
  SuiteHistoryEntrySchema,
  SuiteListRowSchema,
  TablePreviewSchema,
  TaskDetailSchema,
  TaskDiffSchema,
  TaskVersionEntrySchema,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import {
  finishAttempt,
  rescoreRun,
  runningClaim,
  seedExperiment,
  startAttempt,
} from '../../test/support/seed.js';
import { evaluations, runs, scores, taskRootFiles } from '../database/schema/index.js';
import { BlobStore } from '../storage/blob-store.js';
import { SuiteTasksService } from './suite-tasks.service.js';
import { taskByKey } from './suites.queries.js';
import { SuitesService } from './suites.service.js';
import {
  CHECK_PY,
  POLICY_V1,
  POLICY_V2,
  README_MD,
  T_V1,
  T_V2,
  seedSuiteDirectory,
  type SeededDirectory,
} from './seed-spec.js';
import { hash } from './views/test-rows-spec.js';

/** The Nest exception a call rejects with, as { status, body }. */
async function httpError(call: Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await call;
  } catch (err) {
    const e = err as { getStatus?: () => number; getResponse?: () => unknown };
    if (e.getStatus && e.getResponse) return { status: e.getStatus(), body: e.getResponse() };
    throw err;
  }
  throw new Error('expected the call to fail');
}

describe('a directory with two versions', () => {
  let t: TestDatabase;
  let seed: SeededDirectory;
  let suites: SuitesService;
  let tasks: SuiteTasksService;

  beforeAll(async () => {
    t = await createTestDatabase();
    seed = await seedSuiteDirectory(t.db);
    suites = new SuitesService(t.db);
    tasks = new SuiteTasksService(t.db, seed.store);
  }, 30_000);

  afterAll(async () => {
    await t.close();
    await seed.dispose();
  });

  it('lists the directory at its current version', async () => {
    const rows = SuiteListRowSchema.array().parse(await suites.list());
    expect(rows).toEqual([
      {
        suiteId: seed.v2.id,
        name: 'invoices-v1',
        versionNumber: 2,
        versionLabel: '0.1',
        contentHash: hash('suite v2'),
        path: './suites/invoices-v1',
        description: 'Accounts-payable questions over one family of invoice fixtures.',
        taskCount: 2,
        validCount: 1,
        verificationTypes: ['numeric_tolerance', 'verifier_script'],
        loadedAt: T_V2.toISOString(),
        lastLoad: {
          outcome: 'created',
          at: T_V2.toISOString(),
          changes: {
            added: [],
            removed: [],
            changed: ['late_fees'],
            nowInvalid: ['late_fees'],
            nowValid: [],
          },
          error: null,
          servedVersion: null,
        },
        currentChanges: {
          added: [],
          removed: [],
          changed: ['late_fees'],
          nowInvalid: ['late_fees'],
          nowValid: [],
        },
      },
    ]);
  });

  it('shows the current version with task versions, validity and the failure panel', async () => {
    const detail = SuiteDetailSchema.parse(await suites.detail(seed.v2.id));
    expect(detail).toMatchObject({
      current: true,
      previousContentHash: hash('suite v1'),
      versions: [
        { suiteId: seed.v2.id, versionNumber: 2, current: true, reverted: false },
        { suiteId: seed.v1.id, versionNumber: 1, current: false, reverted: false },
      ],
    });
    const [totalDue, lateFees] = detail.tasks;
    expect(totalDue).toEqual({
      key: 'total_due',
      version: 1,
      summary: 'Total amount still due',
      verificationTypes: ['numeric_tolerance'],
      maxTurns: 20,
      budgetS: 300,
      fixtureCount: 3,
      valid: true,
      selfCheckFailure: null,
    });
    expect(lateFees).toMatchObject({ key: 'late_fees', version: 2, valid: false, fixtureCount: 2 });
    expect(lateFees!.selfCheckFailure).toMatchObject({
      key: 'check',
      type: 'verifier_script',
      title:
        'verifier_script check_late_fees.py printed no result line on the reference answer · score status error',
      status: 'error',
      ranAt: T_V2.toISOString(),
      previousRun: { at: T_V1.toISOString(), status: 'passed' },
    });
    expect(lateFees!.selfCheckFailure!.transcript).toContain(
      '$ python3 verify/check_late_fees.py --answer reference.json --workspace fixtures/',
    );
    expect(lateFees!.selfCheckFailure!.explanation).toContain(
      "It raised KeyError: 'late_fee_rate' first (see the traceback).",
    );
    expect(lateFees!.selfCheckFailure!.explanation).toContain(
      'fixtures/policy_terms.json changed since the previous load, when this check passed, and its keys may no longer match what the script reads.',
    );
  });

  it('shows an older version as not current, at its own load time', async () => {
    const detail = SuiteDetailSchema.parse(await suites.detail(seed.v1.id));
    expect(detail).toMatchObject({
      suiteId: seed.v1.id,
      versionNumber: 1,
      current: false,
      loadedAt: T_V1.toISOString(),
      previousContentHash: null,
      validCount: 2,
    });
    expect(detail.tasks.map((r) => [r.key, r.version, r.valid])).toEqual([
      ['total_due', 1, true],
      ['late_fees', 1, true],
    ]);
    expect(detail.versions[0]!.suiteId).toBe(seed.v2.id);
  });

  it('answers 404 for an unknown suite', async () => {
    expect(await httpError(suites.detail('suite_nope'))).toEqual({
      status: 404,
      body: { statusCode: 404, message: 'suite suite_nope not found' },
    });
    expect((await httpError(suites.history('suite_nope'))).status).toBe(404);
  });

  it('lists the history newest first', async () => {
    const entries = SuiteHistoryEntrySchema.array().parse(await suites.history(seed.v1.id));
    expect(entries.map((e) => [e.versionNumber, e.outcome, e.current, e.experiments])).toEqual([
      [2, 'created', true, []],
      [1, 'created', false, []],
    ]);
    expect(entries[0]!.changes).toMatchObject({
      changed: ['late_fees'],
      nowInvalid: ['late_fees'],
    });
    expect(entries[1]!.changes.added).toEqual(['total_due', 'late_fees']);
  });

  it('shows a task with its verbatim YAML, verifier source and fixtures', async () => {
    const detail = TaskDetailSchema.parse(await tasks.detail(seed.v2.id, 'late_fees'));
    expect(detail).toMatchObject({
      key: 'late_fees',
      version: 2,
      introducedInSuiteVersion: 2,
      valid: false,
      path: './suites/invoices-v1/late_fees/task.yaml',
      limits: { maxTurns: 20, budgetS: 300, toolsetsNeeded: ['file', 'terminal'] },
      experiments: [],
    });
    expect(detail.verification.map((v) => [v.yaml, v.sentence])).toEqual([
      [
        '- key: answer\n  type: numeric_tolerance\n  primary: true\n  params: { path: late_fees_total, abs: 0.01 }',
        'numeric_tolerance on late_fees_total, within ±0.01 of the reference',
      ],
      [
        '- key: check\n  type: verifier_script\n  params:\n    script: check_late_fees.py\n    timeout_s: 30\n    pass_at: 1.0',
        'verifier_script check_late_fees.py returns score ≥ 1.0, timeout 30 s',
      ],
    ]);
    expect(detail.verifier).toEqual({
      path: 'verify/check_late_fees.py',
      sha256: hash(CHECK_PY),
      source: CHECK_PY,
    });
    expect(detail.fixtures.map((f) => [f.path, f.typeLabel])).toEqual([
      ['invoices.csv', 'CSV · 12 rows · 4 columns'],
      ['policy_terms.json', 'JSON · 2 keys'],
    ]);
    expect(detail.fixtures[0]!.preview).toMatchObject({ totalRows: 12 });
    expect(detail.fixtures[0]!.preview!.rows).toHaveLength(10);
    expect(detail.selfCheck.results.map((r) => [r.key, r.status, r.note])).toEqual([
      ['answer', 'passed', 'scored against the reference answer'],
      ['check', 'error', 'printed no result line on the reference answer'],
    ]);
    expect(detail.selfCheckFailure?.key).toBe('check');
  });

  it('shows a carried-over task at the suite version that introduced it', async () => {
    const detail = TaskDetailSchema.parse(await tasks.detail(seed.v2.id, 'total_due'));
    expect(detail).toMatchObject({ version: 1, introducedInSuiteVersion: 1, verifier: null });
    expect(detail.verification[0]!.yaml).toBe(
      '- key: answer\n  type: numeric_tolerance\n  primary: true\n  params:\n    path: total_due   # euros\n    abs: 0.01',
    );
    // ledger.csv is too large to preview inline; the preview endpoint reads it.
    expect(detail.fixtures.map((f) => [f.path, f.typeLabel, f.preview === null])).toEqual([
      ['docs/readme.md', 'Markdown · 3 lines', true],
      ['invoices.csv', 'CSV · 12 rows · 4 columns', false],
      ['ledger.csv', 'CSV · 4000 rows · 4 columns', true],
    ]);
  });

  it('answers 404 for an unknown task', async () => {
    expect(await httpError(tasks.detail(seed.v2.id, 'nope'))).toEqual({
      status: 404,
      body: { statusCode: 404, message: 'task nope not found' },
    });
  });

  it("lists a task's versions with the files that changed", async () => {
    const lateFees = TaskVersionEntrySchema.array().parse(
      await tasks.history(seed.v1.id, 'late_fees'),
    );
    expect(lateFees).toEqual([
      {
        version: 2,
        contentHash: hash('late_fees v2'),
        suiteId: seed.v2.id,
        introducedInSuiteVersion: 2,
        loadedAt: T_V2.toISOString(),
        changedFiles: ['fixtures/policy_terms.json'],
        current: true,
      },
      {
        version: 1,
        contentHash: hash('late_fees v1'),
        suiteId: seed.v1.id,
        introducedInSuiteVersion: 1,
        loadedAt: T_V1.toISOString(),
        changedFiles: [],
        current: false,
      },
    ]);
    const totalDue = await tasks.history(seed.v2.id, 'total_due');
    expect(totalDue.map((e) => [e.version, e.suiteId, e.current])).toEqual([[1, seed.v1.id, true]]);
  });

  it('diffs a task between two suite versions', async () => {
    const diff = TaskDiffSchema.parse(await tasks.diff(seed.v2.id, 'late_fees', seed.v1.id));
    expect(diff.from).toEqual({ suiteId: seed.v1.id, suiteVersion: 1, taskVersion: 1 });
    expect(diff.to).toEqual({ suiteId: seed.v2.id, suiteVersion: 2, taskVersion: 2 });
    expect(diff.prompt.every((l) => l.kind === 'same')).toBe(true);
    expect(diff.reference).toEqual([]);
    // No root-file record (rows seeded as before Phase 5b): task.yaml and prompt.md are
    // measured from their stored text, and reference.json is "not recorded" (Phase 7),
    // unchanged since both stored values are the same.
    expect(diff.files.map((f) => [f.path, f.change])).toEqual([
      ['task.yaml', 'unchanged'],
      ['prompt.md', 'unchanged'],
      ['reference.json', 'unchanged'],
      ['fixtures/invoices.csv', 'unchanged'],
      ['fixtures/policy_terms.json', 'changed'],
      ['verify/check_late_fees.py', 'unchanged'],
    ]);
    expect(diff.files[2]!.before).toEqual({
      sizeBytes: null,
      sha256: null,
      notRecorded: 'loaded_before_phase_5b',
    });
    expect(diff.textFiles).toEqual([
      {
        path: 'fixtures/policy_terms.json',
        lines: [
          { kind: 'removed', text: POLICY_V1.trimEnd(), oldLine: 1, newLine: null },
          { kind: 'added', text: POLICY_V2.trimEnd(), oldLine: null, newLine: 1 },
        ],
      },
    ]);
  });

  it('lists reference.json with the sizes and hashes the loader recorded', async () => {
    const [fromTask, toTask] = await Promise.all([
      taskByKey(t.db, seed.v1.id, 'late_fees'),
      taskByKey(t.db, seed.v2.id, 'late_fees'),
    ]);
    const record = (taskId: string, content: string) => ({
      taskId,
      path: 'reference.json' as const,
      sha256: hash(content),
      size: Buffer.byteLength(content),
      text: content,
    });
    await t.db
      .insert(taskRootFiles)
      .values([
        record(fromTask!.id, '{"late_fee": 12.5}\n'),
        record(toTask!.id, '{"late_fee": 12.5}\n'),
      ]);
    const diff = TaskDiffSchema.parse(await tasks.diff(seed.v2.id, 'late_fees', seed.v1.id));
    expect(diff.files.slice(0, 3).map((f) => [f.path, f.change, f.after?.sizeBytes])).toEqual([
      ['task.yaml', 'unchanged', expect.any(Number)],
      ['prompt.md', 'unchanged', expect.any(Number)],
      ['reference.json', 'unchanged', 19],
    ]);
  });

  it('refuses a diff without `against`, or against an unknown version', async () => {
    expect((await httpError(tasks.diff(seed.v2.id, 'late_fees', undefined))).status).toBe(400);
    expect(await httpError(tasks.diff(seed.v2.id, 'late_fees', 'suite_nope'))).toEqual({
      status: 404,
      body: { statusCode: 404, message: 'suite suite_nope not found' },
    });
  });

  it('streams a fixture found by its workspace path, never by a filesystem path', async () => {
    const download = await tasks.fixture(seed.v2.id, 'total_due', 'docs/readme.md');
    expect(download.path).toBe('docs/readme.md');
    expect(await text(download.stream)).toBe(README_MD);
    for (const path of [
      'fixtures/docs/readme.md',
      '../late_fees/fixtures/policy_terms.json',
      'nope.csv',
    ]) {
      expect(await httpError(tasks.fixture(seed.v2.id, 'total_due', path))).toEqual({
        status: 404,
        body: { statusCode: 404, message: `fixture ${path} not found` },
      });
    }
    // A verifier is a task file but not a fixture.
    expect(
      (await httpError(tasks.fixture(seed.v2.id, 'late_fees', 'verify/check_late_fees.py'))).status,
    ).toBe(404);
  });

  it('previews the first rows of a tabular fixture of any size, and null otherwise', async () => {
    const ledger = TablePreviewSchema.parse(
      await tasks.preview(seed.v2.id, 'total_due', 'ledger.csv'),
    );
    expect(ledger.columns).toEqual(['entry', 'account', 'debit', 'credit']);
    expect(ledger.rows).toHaveLength(10);
    expect(ledger.rows[0]).toEqual(['1', '4000-0', '0.00', '0.00']);
    expect(ledger.totalRows).toBe(4000);
    expect(await tasks.preview(seed.v2.id, 'total_due', 'docs/readme.md')).toBeNull();
  });

  it('still shows a task whose blobs are gone, and answers 500 for its download', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-empty-'));
    try {
      const bare = new SuiteTasksService(t.db, new BlobStore(dataDir));
      const detail = TaskDetailSchema.parse(await bare.detail(seed.v2.id, 'late_fees'));
      expect(detail.fixtures.map((f) => [f.typeLabel, f.preview])).toEqual([
        ['CSV', null],
        ['JSON', null],
      ]);
      expect(detail.verifier).toBeNull();
      expect((await httpError(bare.fixture(seed.v2.id, 'total_due', 'invoices.csv'))).status).toBe(
        500,
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe('experiments on a suite version', () => {
  let t: TestDatabase;
  let seed: Awaited<ReturnType<typeof seedExperiment>>;

  beforeAll(async () => {
    t = await createTestDatabase();
    seed = await seedExperiment(t.db);
  }, 30_000);

  afterAll(async () => {
    await t.close();
  });

  /** Executes a run and publishes a score set whose primary key has `status`. */
  async function score(runId: string, status: 'passed' | 'failed') {
    const attemptId = await startAttempt(t.db, runId, seed.worker.id);
    await finishAttempt(t.db, runId, attemptId);
    const [evaluation] = await t.db
      .insert(evaluations)
      .values({ runId, attemptId, cause: 'initial', generation: 1, ...runningClaim() })
      .returning({ id: evaluations.id });
    await t.db.insert(scores).values({
      evaluationId: evaluation!.id,
      key: 'answer',
      type: 'json_match',
      status,
      isPrimary: true,
      score: status === 'passed' ? 1 : 0,
      comment: status,
      scorerVersion: 1,
    });
    await t.db.transaction(async (tx) => {
      await tx
        .update(evaluations)
        .set({ status: 'completed', finishedAt: new Date() })
        .where(eq(evaluations.id, evaluation!.id));
      await tx
        .update(runs)
        .set({ status: 'scored', finishedAt: new Date() })
        .where(eq(runs.id, runId));
    });
  }

  it('lists them in the history and counts the pass rate per configuration on Task detail', async () => {
    const runOf = (versionId: string, repetition: number) =>
      seed.runs.find((r) => r.configurationVersionId === versionId && r.repetition === repetition)!;
    await score(runOf(seed.baselineVersionId, 1).id, 'passed');
    await score(runOf(seed.baselineVersionId, 2).id, 'failed');
    await score(runOf(seed.candidateVersionId, 1).id, 'passed');

    const history = await new SuitesService(t.db).history(seed.suite.id);
    expect(history[0]!.experiments).toEqual([
      { id: seed.experiment.id, name: 'Skill vs no skill' },
    ]);

    const dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-usage-'));
    try {
      const detail = TaskDetailSchema.parse(
        await new SuiteTasksService(t.db, new BlobStore(dataDir)).detail(
          seed.suite.id,
          'dup_invoices',
        ),
      );
      expect(detail.experiments).toEqual([
        {
          experimentId: seed.experiment.id,
          experimentName: 'Skill vs no skill',
          status: seed.experiment.status,
          taskVersion: 1,
          suiteVersion: 1,
          rows: [
            { configuration: 'baseline', role: 'baseline', passRate: 0.5, scored: 2, total: 2 },
            { configuration: 'with-skill', role: 'candidate', passRate: 1, scored: 1, total: 2 },
          ],
        },
      ]);
      // The task.yaml of seedExperiment writes its limits as a flow map.
      expect(detail.verification[0]!.yaml).toBe(
        '- key: answer\n  type: json_match\n  primary: true\n  params: { path: duplicates }',
      );

      // Re-scores count each run once, with its current result: baseline's pass
      // becomes a fail, and its fail is re-scored twice and stays one.
      await rescoreRun(t.db, runOf(seed.baselineVersionId, 1).id, 'failed');
      await rescoreRun(t.db, runOf(seed.baselineVersionId, 2).id, 'failed');
      await rescoreRun(t.db, runOf(seed.baselineVersionId, 2).id, 'failed');
      const rescored = TaskDetailSchema.parse(
        await new SuiteTasksService(t.db, new BlobStore(dataDir)).detail(
          seed.suite.id,
          'dup_invoices',
        ),
      );
      expect(rescored.experiments[0]!.rows).toEqual([
        { configuration: 'baseline', role: 'baseline', passRate: 0, scored: 2, total: 2 },
        { configuration: 'with-skill', role: 'candidate', passRate: 1, scored: 1, total: 2 },
      ]);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
