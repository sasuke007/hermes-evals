import { beforeEach, describe, expect, it } from 'vitest';
import {
  getFixturePreview,
  getSuite,
  getSuiteHistory,
  getTask,
  getTaskDiff,
  getTaskHistory,
  listSuites,
  reloadSuites,
} from '@/api/suites';
import { SUITE_V1_ID, SUITE_V2_ID } from '@/fixtures/suites';
import { setScenario, settledWithin } from './scenario';

beforeEach(() => setScenario(null));

describe('suites', () => {
  it('lists invoices-v1 with all 12 tasks valid', async () => {
    const [suite, ...rest] = await listSuites();
    expect(rest).toEqual([]);
    expect(suite).toMatchObject({
      suiteId: SUITE_V1_ID,
      name: 'invoices-v1',
      versionNumber: 1,
      versionLabel: '0.1',
      path: './suites/invoices-v1',
      taskCount: 12,
      validCount: 12,
      loadedAt: '2026-10-23T09:12:04',
      lastLoad: { outcome: 'unchanged' },
    });
    expect(suite!.contentHash.startsWith('3f9c2a1')).toBe(true);
    expect(suite!.verificationTypes.slice(0, 3)).toEqual([
      'json_match',
      'numeric_tolerance',
      'llm_judge',
    ]);
  });

  it('gives the suite detail with every task row', async () => {
    const suite = await getSuite(SUITE_V1_ID);
    expect(suite.tasks.map((t) => t.key)).toEqual([
      'total_due',
      'overdue_list',
      'dup_invoices',
      'vat_split',
      'credit_notes',
      'currency_mix',
      'missing_po',
      'late_fees',
      'per_vendor',
      'disputed',
      'partial_pay',
      'summary_file',
    ]);
    expect(suite.tasks.find((t) => t.key === 'late_fees')).toMatchObject({
      verificationTypes: ['numeric_tolerance', 'verifier_script'],
      fixtureCount: 3,
      valid: true,
    });
    expect(suite.versions).toHaveLength(1);
  });

  it('shows Flow D after a reload breaks late_fees', async () => {
    setScenario('invalid-task');
    const [row] = await listSuites();
    expect([row!.validCount, row!.versionNumber, row!.contentHash.slice(0, 7)]).toEqual([
      11,
      2,
      '7d20e4b',
    ]);
    const suite = await getSuite(SUITE_V2_ID);
    expect(suite.previousContentHash?.slice(0, 7)).toBe('3f9c2a1');
    const late = suite.tasks.find((t) => t.key === 'late_fees')!;
    expect([late.valid, late.version]).toEqual([false, 2]);
    expect(late.selfCheckFailure?.title).toBe(
      'verifier_script check_late_fees.py printed no result line on the reference answer · score status error',
    );
    expect(late.selfCheckFailure?.transcript).toContain("KeyError: 'late_fee_rate'");
    const reload = await reloadSuites();
    expect(reload.suites[0]).toMatchObject({
      outcome: 'created',
      message: '1 task now invalid: late_fees',
    });
  });

  it('reloads with no changes by default', async () => {
    const reload = await reloadSuites();
    expect(reload.suites[0]).toMatchObject({
      outcome: 'unchanged',
      message: 'All self-checks passed',
    });
  });

  it('reloads one directory by its path, or none when the path is unknown', async () => {
    const one = await reloadSuites('./suites/invoices-v1');
    expect(one.suites.map((s) => s.sourcePath)).toEqual(['./suites/invoices-v1']);
    expect((await reloadSuites('./suites/nope')).suites).toEqual([]);
  });

  it('keeps the last good version when a reload fails', async () => {
    setScenario('reload-failed');
    const [row] = await listSuites();
    expect(row!.lastLoad.outcome).toBe('error');
    expect(row!.lastLoad.error).toMatchObject({
      file: './suites/invoices-v1/vat_split/task.yaml',
      line: 14,
      column: 9,
      message: 'mapping values are not allowed here',
    });
    expect(row!.lastLoad.servedVersion?.contentHash.slice(0, 7)).toBe('3f9c2a1');
  });

  it('lists the history, with the reverted entry and the experiments of v1', async () => {
    setScenario('reverted');
    const history = await getSuiteHistory(SUITE_V1_ID);
    expect(history.map((h) => [h.versionNumber, h.outcome, h.current])).toEqual([
      [1, 'reverted', true],
      [2, 'created', false],
      [1, 'created', false],
    ]);
    expect(history[0]!.experiments).toHaveLength(6);
    const suite = await getSuite(SUITE_V1_ID);
    expect(suite.versions[0]).toMatchObject({ versionNumber: 1, reverted: true, current: true });
  });

  it('is empty when ./suites has no suite', async () => {
    setScenario('empty');
    expect(await listSuites()).toEqual([]);
  });

  it('honours loading and error', async () => {
    setScenario('loading');
    expect(await settledWithin(listSuites())).toBe('pending');
    setScenario('error');
    await expect(getSuite(SUITE_V1_ID)).rejects.toThrow(`GET /api/suites/${SUITE_V1_ID} → 502`);
  });
});

describe('tasks', () => {
  it('gives dup_invoices as the Task detail board draws it', async () => {
    const task = await getTask(SUITE_V1_ID, 'dup_invoices');
    expect(task).toMatchObject({
      key: 'dup_invoices',
      version: 1,
      summary: 'Find invoices billed twice by the same vendor',
      path: './suites/invoices-v1/dup_invoices/task.yaml',
      limits: { maxTurns: 20, budgetS: 300, toolsetsNeeded: ['file'] },
      valid: true,
      verifier: null,
    });
    expect(task.prompt.markdown).toContain(
      'Find every pair of invoices that are duplicates of each other.',
    );
    expect(task.fixtures[0]).toMatchObject({
      path: 'invoices.csv',
      typeLabel: 'CSV · 48 rows · 8 columns',
    });
    expect(task.fixtures[0]!.preview?.rows).toHaveLength(5);
    expect(task.verification.map((v) => [v.key, v.primary, v.sentence])).toEqual([
      ['answer', true, 'json_match on duplicates, unordered, pass at 1.0'],
      ['reads_fixture', false, 'trajectory_match: calls read_file on invoices.csv at least once'],
    ]);
    expect(task.verification[0]!.yaml).toBe(
      [
        '- key: answer',
        '  type: json_match',
        '  primary: true',
        '  params:',
        '    path: duplicates',
        '    unordered: true',
        '    inner_unordered: true',
        '    pass_at: 1.0',
      ].join('\n'),
    );
    expect(task.reference.value).toEqual({
      duplicates: [
        ['INV-0988', 'INV-1131'],
        ['INV-1042', 'INV-1107'],
      ],
    });
    expect(task.selfCheck.results.map((r) => [r.key, r.status, r.score])).toEqual([
      ['answer', 'passed', 1],
      ['reads_fixture', 'skipped', null],
    ]);
  });

  it('lists the experiments that included the task with its pass rates', async () => {
    const task = await getTask(SUITE_V1_ID, 'dup_invoices');
    const byName = Object.fromEntries(
      task.experiments.map((e) => [
        e.experimentName,
        e.rows.map((r) => [r.configuration, r.passRate]),
      ]),
    );
    expect(byName['Skill vs no skill, invoices-v1']).toEqual([
      ['baseline', 0.2],
      ['with-skill', 0.8],
    ]);
    expect(byName['MCP smoke test, invoices-v1']).toEqual([
      ['baseline', 0.33],
      ['with-mcp', 0.67],
    ]);
    expect(byName['MCP vs baseline, invoices-v1']).toEqual([
      ['baseline', 0.25],
      ['with-mcp', 0.75],
    ]);
  });

  it('gives a task version history and diff when total_due changed', async () => {
    setScenario('newer-version');
    const history = await getTaskHistory(SUITE_V2_ID, 'total_due');
    expect(history.map((h) => [h.version, h.introducedInSuiteVersion, h.current])).toEqual([
      [2, 2, true],
      [1, 1, false],
    ]);
    const diff = await getTaskDiff(SUITE_V2_ID, 'total_due', SUITE_V1_ID);
    expect(diff.from).toMatchObject({ suiteVersion: 1, taskVersion: 1 });
    expect(diff.to).toMatchObject({ suiteVersion: 2, taskVersion: 2 });
    expect(diff.reference).toEqual([
      { path: 'total_due', kind: 'changed', before: 48213.65, after: 48526.05 },
    ]);
    expect(diff.prompt.filter((l) => l.kind !== 'same')).toHaveLength(2);
    // task.yaml, prompt.md and reference.json come first, with their recorded sizes and hashes.
    expect(diff.files.map((f) => f.path).slice(0, 3)).toEqual([
      'task.yaml',
      'prompt.md',
      'reference.json',
    ]);
    expect(diff.files.find((f) => f.path === 'fixtures/invoices.csv')).toMatchObject({
      change: 'changed',
    });
    const unchanged = await getTaskHistory(SUITE_V2_ID, 'dup_invoices');
    expect(unchanged).toHaveLength(1);
  });

  it('previews tabular fixtures only', async () => {
    expect((await getFixturePreview(SUITE_V1_ID, 'dup_invoices', 'invoices.csv'))?.totalRows).toBe(
      48,
    );
    expect(await getFixturePreview(SUITE_V1_ID, 'currency_mix', 'rates.json')).toBeNull();
  });

  it('rejects an unknown task with a 404', async () => {
    await expect(getTask(SUITE_V1_ID, 'nope')).rejects.toThrow('→ 404 · task nope not found');
  });
});
