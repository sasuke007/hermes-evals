/**
 * suites/invoices-v1 through the real loader into PGlite (plan 17, Phase 6
 * exit; plan 18.5 steps 1 and 2): all twelve tasks load valid with no issue
 * at all, every runnable self-check passes on its reference, summary_file's
 * negative controls fail on the bare fixtures, and for every task a
 * scripted reply that falls into its trap fails the primary key while the
 * reference passes it, graded by the real scorers.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { LoadIssueSchema, SelfCheckSchema } from '@hermes-evals/shared';
import { taskFiles, tasks } from '../../src/database/schema/index.js';
import {
  loadInvoicesSuite,
  primaryKey,
  readText,
  replyWith,
  runGenerator,
  scoreKey,
  SUITE_DIR,
  TASK_KEYS,
  type LoadedSuite,
  type TaskKey,
  type Trap,
} from './support.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let suite: LoadedSuite;
let traps: Record<TaskKey, Trap>;
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'invoices-v1-traps-'));
  traps = await runGenerator(scratch);
  suite = await loadInvoicesSuite();
});

afterAll(async () => {
  await suite?.close();
  await rm(scratch, { recursive: true, force: true });
});

const row = (key: TaskKey) => suite.byKey.get(key)!;

describe('loading suites/invoices-v1', () => {
  it('creates a version with the twelve tasks in suite.yaml order, every one valid', () => {
    expect(suite.entry).toMatchObject({
      name: 'invoices-v1',
      outcome: 'created',
      versionNumber: 1,
      error: null,
    });
    expect(suite.rows.map((r) => r.key)).toEqual([...TASK_KEYS]);
    for (const r of suite.rows) {
      expect(r, r.key).toMatchObject({ valid: true, invalidReason: null });
    }
  });

  it('reports no load issue, not even a warning', () => {
    for (const r of suite.rows) {
      for (const issue of r.loadIssues) LoadIssueSchema.parse(issue);
      expect(r.loadIssues, r.key).toEqual([]);
    }
  });

  it('passes every runnable self-check on the reference, and skips only trajectory and judge keys', () => {
    for (const r of suite.rows) {
      const check = SelfCheckSchema.parse(r.selfCheck);
      expect(check.status, r.key).toBe('passed');
      for (const result of check.results) {
        if (result.mode === 'none') {
          expect(['trajectory_match', 'llm_judge'], `${r.key}.${result.key}`).toContain(
            result.type,
          );
          expect(result.status).toBe('skipped');
        } else if (result.expect !== 'fail') {
          expect(result.status, `${r.key}.${result.key}: ${result.comment}`).toBe('passed');
        }
      }
    }
    const modes = (key: TaskKey) =>
      row(key).selfCheck.results.map((r) => [r.key, r.mode, r.expect ?? null, r.status]);
    expect(modes('late_fees')).toEqual([
      ['answer', 'answer', null, 'passed'],
      ['fees', 'script', null, 'passed'],
    ]);
    expect(modes('per_vendor')).toEqual([
      ['answer', 'answer', null, 'passed'],
      ['reads_ledger', 'none', null, 'skipped'],
    ]);
    expect(modes('disputed')).toEqual([
      ['answer', 'answer', null, 'passed'],
      ['method', 'none', null, 'skipped'],
    ]);
  });

  it("proves summary_file's checks on its expected workspace, and fails both on the bare fixtures", () => {
    const results = row('summary_file').selfCheck.results;
    expect(results.map((r) => [r.key, r.mode, r.expect, r.status])).toEqual([
      ['summary_csv', 'workspace', 'pass', 'passed'],
      ['summary_csv', 'workspace', 'fail', 'failed'],
      ['totals', 'workspace', 'pass', 'passed'],
      ['totals', 'workspace', 'fail', 'failed'],
    ]);
    expect(results[1]!.comment).toBe('negative control: summary.csv does not exist');
    expect(results[3]!.comment).toContain('summary.csv not found in the workspace');
    expect(row('summary_file').selfCheck.expected_workspace).toEqual([
      { path: 'summary.csv', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  it('stores every file under its kind: only fixtures ever reach a trial', async () => {
    const files = await suite.db.db
      .select({ key: tasks.key, path: taskFiles.path, kind: taskFiles.kind })
      .from(taskFiles)
      .innerJoin(tasks, eq(tasks.id, taskFiles.taskId))
      .where(eq(tasks.suiteId, suite.entry.suiteId!))
      .orderBy(asc(tasks.key), asc(taskFiles.path));
    const notFixtures = files.filter((f) => f.kind !== 'fixture');
    expect(notFixtures.map((f) => [f.key, f.path, f.kind])).toEqual([
      ['disputed', 'rubric.md', 'rubric'],
      ['late_fees', 'verify/check_fees.py', 'verifier'],
      ['late_fees', 'verify/expected_fees.json', 'verifier'],
      ['summary_file', 'expected/summary.csv', 'expected'],
      ['summary_file', 'verify/check_summary.py', 'verifier'],
      ['summary_file', 'verify/expected_summary.json', 'verifier'],
    ]);
    for (const f of files.filter((f) => f.kind === 'fixture')) {
      expect(f.path, f.key).toMatch(/^fixtures\/[a-z_]+\.(csv|json)$/);
    }
  });
});

describe('each task against its trap', () => {
  it.each(TASK_KEYS)(
    '%s: the reference passes the primary key, and the trap answer fails it',
    async (key) => {
      const task = row(key);
      const primary = primaryKey(task);
      const trap = traps[key];
      const right = await scoreKey(task, primary, {
        text: replyWith(task.reference),
        // A file-producing task's reference is the expected workspace.
        ...(key === 'summary_file' ? { files: { 'summary.csv': await expectedSummary() } } : {}),
      });
      expect(right.status, `${key} reference: ${right.comment}`).toBe('passed');
      const wrong = await scoreKey(task, primary, {
        text: replyWith(trap.answer),
        files: trap.files,
      });
      expect(wrong.status, `${key} trap (${trap.note}): ${wrong.comment}`).toBe('failed');
    },
  );

  it('fails the secondary checks that look at the same mistake', async () => {
    const late = await scoreKey(row('late_fees'), 'fees', {
      text: replyWith(traps.late_fees.answer),
    });
    expect(late).toMatchObject({ status: 'failed', score: 0 });
    expect(late.comment).toContain('owes no fee');
    const vat = await scoreKey(row('vat_split'), 'total_vat', {
      text: replyWith(traps.vat_split.answer),
    });
    expect(vat.status).toBe('failed');
    const summary = await scoreKey(row('summary_file'), 'totals', {
      text: replyWith(traps.summary_file.answer),
      files: traps.summary_file.files,
    });
    expect(summary).toMatchObject({ status: 'failed', score: 0.875 });
    expect(summary.comment).toMatch(/^7 of 8 vendor rows right: no row for /);
  });

  it('grades a reply without an answer block ungradable on answer keys, and a missing summary as failed', async () => {
    const none = await scoreKey(row('total_due'), 'answer', { text: 'The total is about 100k.' });
    expect(none.status).toBe('ungradable');
    const fees = await scoreKey(row('late_fees'), 'fees', { text: 'No block.' });
    expect(fees).toMatchObject({ status: 'failed', score: 0 });
    const file = await scoreKey(row('summary_file'), 'summary_csv', { text: replyWith({}) });
    expect(file).toMatchObject({ status: 'failed', comment: 'summary.csv does not exist' });
  });
});

const expectedSummary = () => readText(SUITE_DIR, 'summary_file/expected/summary.csv');
