import { describe, expect, it } from 'vitest';
import {
  SuiteTaskRowSchema,
  TaskDetailSchema,
  TaskDiffSchema,
  TaskVersionEntrySchema,
} from '@hermes-evals/shared';
import {
  fixtureFileView,
  homeFileViews,
  suiteTaskRow,
  taskDetail,
  taskDiff,
  taskHistory,
  verificationViews,
  type PlacedTask,
} from './task-views.js';
import { T0, T2, T3, TOTAL_DUE_YAML, fileRow, hash, suiteRow, taskRow } from './test-rows-spec.js';

const CSV = 'invoice_no,amount\nINV-1,10.00\nINV-2,12.50\n';

describe('suiteTaskRow', () => {
  it('shows the stored limits, the types in task.yaml order and the fixture count', () => {
    const v1 = suiteRow(1);
    const row = suiteTaskRow(
      taskRow(v1, {
        versionNumber: 2,
        verification: [
          { key: 'answer', type: 'json_match', primary: true, params: { path: 'duplicates' } },
          {
            key: 'used_tool',
            type: 'trajectory_match',
            primary: false,
            params: { tool: 'read_file' },
          },
        ],
      }),
      3,
      null,
    );
    expect(SuiteTaskRowSchema.parse(row)).toEqual({
      key: 'total_due',
      version: 2,
      summary: 'Total amount still due',
      verificationTypes: ['json_match', 'trajectory_match'],
      maxTurns: 20,
      budgetS: 300,
      fixtureCount: 3,
      valid: true,
      selfCheckFailure: null,
    });
  });

  it('reads limits from task.yaml for an invalid task stored without them', () => {
    const row = suiteTaskRow(
      taskRow(suiteRow(1), {
        valid: false,
        invalidReason: 'reference.json is missing',
        limits: null,
        reference: null,
        taskYaml: 'summary: x\nlimits: { max_turns: 12, run_budget_seconds: 90 }\n',
      }),
      0,
      null,
    );
    expect([row.maxTurns, row.budgetS, row.valid]).toEqual([12, 90, false]);
  });

  it('shows no limit, never a made-up one, when task.yaml states none it can use', () => {
    const invalid = (taskYaml: string | null) =>
      SuiteTaskRowSchema.parse(
        suiteTaskRow(
          taskRow(suiteRow(1), {
            valid: false,
            invalidReason: 'task.yaml: limits is required',
            limits: null,
            reference: null,
            taskYaml,
          }),
          0,
          null,
        ),
      );
    // No limits block at all.
    expect(invalid('summary: x\n')).toMatchObject({ maxTurns: null, budgetS: null });
    // max_turns: 0 is not a usable value; the budget that is stated still shows.
    expect(invalid('summary: x\nlimits: { max_turns: 0, run_budget_seconds: 90 }\n')).toMatchObject(
      { maxTurns: null, budgetS: 90 },
    );
    // No task.yaml that could be read.
    expect(invalid(null)).toMatchObject({ maxTurns: null, budgetS: null });
  });
});

describe('verificationViews', () => {
  it('gives each entry its YAML as written and its sentence', () => {
    const [view] = verificationViews(taskRow(suiteRow(1)));
    expect(view).toEqual({
      key: 'answer',
      type: 'numeric_tolerance',
      primary: true,
      params: { path: 'total_due', abs: 0.01 },
      yaml: '- key: answer\n  type: numeric_tolerance\n  primary: true\n  params:\n    path: total_due\n    abs: 0.01',
      sentence: 'numeric_tolerance on total_due, within ±0.01 of the reference',
    });
  });

  it('scores the primary on answer.path when its params name no path', () => {
    const [view] = verificationViews({
      taskYaml: TOTAL_DUE_YAML.replace(
        'format: fenced_json',
        'format: fenced_json\n  path: total_due',
      ).replace('      path: total_due\n', ''),
      verification: [
        { key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0.01 } },
      ],
    });
    expect(view!.sentence).toBe('numeric_tolerance on total_due, within ±0.01 of the reference');
  });
});

describe('fixtureFileView', () => {
  it('shows the workspace path, a type label and the preview it is given', () => {
    const task = taskRow(suiteRow(1));
    const view = fixtureFileView(fileRow(task, 'fixtures/invoices.csv', CSV), Buffer.from(CSV), {
      columns: ['invoice_no', 'amount'],
      rows: [['INV-1', '10.00']],
      totalRows: 2,
    });
    expect(view).toMatchObject({
      path: 'invoices.csv',
      typeLabel: 'CSV · 2 rows · 2 columns',
      sizeBytes: CSV.length,
      sha256: hash(CSV),
    });
  });
});

describe('taskDetail', () => {
  it('builds a view the shared schema accepts', () => {
    const v1 = suiteRow(1);
    const v2 = suiteRow(2, { loadedAt: T2 });
    const task = taskRow(v2, { introducedInSuiteId: v1.id });
    const detail = taskDetail({
      suite: v2,
      task,
      introducedInSuiteVersion: 1,
      fixtures: [],
      homeFiles: [],
      verifier: null,
      failure: null,
      experiments: [],
    });
    expect(TaskDetailSchema.parse(detail)).toMatchObject({
      suite: { suiteId: v2.id, versionNumber: 2 },
      key: 'total_due',
      version: 1,
      introducedInSuiteVersion: 1,
      path: './suites/invoices-v1/total_due/task.yaml',
      prompt: { file: 'prompt.md', characters: task.prompt!.length },
      reference: { file: 'reference.json', value: { total_due: 48213.65 } },
      limits: { maxTurns: 20, budgetS: 300, toolsetsNeeded: ['file'] },
      selfCheck: {
        status: 'passed',
        trigger: 'suite reload',
        results: [
          {
            key: 'answer',
            type: 'numeric_tolerance',
            status: 'passed',
            score: 1,
            note: 'scored against the reference answer',
          },
        ],
      },
    });
  });
});

describe('homeFileViews', () => {
  const withExpectedHome = (dir: string) =>
    taskRow(suiteRow(1), {
      taskYaml: `${TOTAL_DUE_YAML}self_check:\n  expected_home: ${dir}\n`,
    });

  it('lists the home seeds, then the expected_home files, each by path, with their text', () => {
    const task = withExpectedHome('expected_home');
    const memory = 'Vendor names can carry trailing spaces.\n';
    const user = 'Reports in EUR.\n';
    const saved = 'Reports in EUR.\n§\nLargest first.\n';
    const files = [
      fileRow(task, 'expected_home/memories/USER.md', saved, 'expected_home'),
      fileRow(task, 'home/memories/USER.md', user, 'home_seed'),
      fileRow(task, 'fixtures/invoices.csv', CSV),
      fileRow(task, 'home/memories/MEMORY.md', memory, 'home_seed'),
    ];
    const views = homeFileViews(
      task,
      files,
      new Map([
        [hash(memory), memory],
        [hash(saved), saved],
      ]),
    );
    expect(views).toEqual([
      {
        kind: 'home_seed',
        path: 'home/memories/MEMORY.md',
        homePath: 'memories/MEMORY.md',
        sizeBytes: memory.length,
        sha256: hash(memory),
        text: memory,
      },
      {
        kind: 'home_seed',
        path: 'home/memories/USER.md',
        homePath: 'memories/USER.md',
        sizeBytes: user.length,
        sha256: hash(user),
        text: null,
      },
      {
        kind: 'expected_home',
        path: 'expected_home/memories/USER.md',
        homePath: 'memories/USER.md',
        sizeBytes: Buffer.byteLength(saved),
        sha256: hash(saved),
        text: saved,
      },
    ]);
  });

  it('strips a nested expected_home folder whole, as task.yaml names it', () => {
    // The loader accepts any folder of the task's own, written any way it normalises.
    const task = withExpectedHome('./known_good/home/');
    const saved = 'Reports in EUR.\n§\nLargest first.\n';
    const files = [
      fileRow(task, 'known_good/home/memories/USER.md', saved, 'expected_home'),
      fileRow(task, 'known_good/home/memories/notes/vendors.md', saved, 'expected_home'),
    ];
    expect(homeFileViews(task, files, new Map()).map((v) => [v.path, v.homePath])).toEqual([
      ['known_good/home/memories/USER.md', 'memories/USER.md'],
      ['known_good/home/memories/notes/vendors.md', 'memories/notes/vendors.md'],
    ]);
  });
});

describe('taskHistory and taskDiff', () => {
  // v1 introduced total_due v1; v2 carried it unchanged; v3 changed its prompt, reference and fixture.
  const s1 = suiteRow(1);
  const s2 = suiteRow(2, { loadedAt: T2 });
  const s3 = suiteRow(3, { loadedAt: T3 });
  const t1 = taskRow(s1);
  const t2 = taskRow(s2, { introducedInSuiteId: s1.id });
  const t3 = taskRow(s3, {
    versionNumber: 2,
    contentHash: hash('total_due v2'),
    prompt:
      'What is the total still due, disputed invoices included?\nReply with a fenced JSON block.',
    reference: { total_due: 48526.05 },
  });
  const placed = (task: typeof t1, suite: typeof s1, csv: string): PlacedTask => ({
    task,
    suite,
    files: [
      fileRow(task, 'fixtures/invoices.csv', csv),
      fileRow(task, 'verify/check.py', 'print()', 'verifier'),
    ],
  });
  const rows = [placed(t1, s1, CSV), placed(t2, s2, CSV), placed(t3, s3, `${CSV}INV-3,1.00\n`)];
  const suites = new Map([s1, s2, s3].map((s) => [s.id, s]));

  it('lists each task version once, newest first, at the suite version that introduced it', () => {
    const entries = taskHistory(rows, suites, s3.id);
    expect(TaskVersionEntrySchema.array().parse(entries)).toEqual([
      {
        version: 2,
        contentHash: hash('total_due v2'),
        suiteId: s3.id,
        introducedInSuiteVersion: 3,
        loadedAt: T3.toISOString(),
        changedFiles: ['prompt.md', 'reference.json', 'fixtures/invoices.csv'],
        current: true,
      },
      {
        version: 1,
        contentHash: hash('total_due v1'),
        suiteId: s1.id,
        introducedInSuiteVersion: 1,
        loadedAt: T0.toISOString(),
        changedFiles: [],
        current: false,
      },
    ]);
  });

  it('marks the version the current suite version holds, after a revert', () => {
    expect(taskHistory(rows, suites, s2.id).map((e) => [e.version, e.current])).toEqual([
      [2, false],
      [1, true],
    ]);
  });

  it('diffs prompt, task.yaml, reference and files between two suite versions', () => {
    const diff = TaskDiffSchema.parse(taskDiff(rows[1]!, rows[2]!));
    expect(diff.from).toEqual({ suiteId: s2.id, suiteVersion: 2, taskVersion: 1 });
    expect(diff.to).toEqual({ suiteId: s3.id, suiteVersion: 3, taskVersion: 2 });
    expect(diff.prompt).toEqual([
      { kind: 'removed', text: 'What is the total still due?', oldLine: 1, newLine: null },
      {
        kind: 'added',
        text: 'What is the total still due, disputed invoices included?',
        oldLine: null,
        newLine: 1,
      },
      { kind: 'same', text: 'Reply with a fenced JSON block.', oldLine: 2, newLine: 2 },
    ]);
    expect(diff.taskYaml.every((l) => l.kind === 'same')).toBe(true);
    expect(diff.reference).toEqual([
      { path: 'total_due', kind: 'changed', before: 48213.65, after: 48526.05 },
    ]);
    // Loaded before Phase 5b: task.yaml and prompt.md measured from their text, no reference.json.
    expect(diff.files.map((f) => [f.path, f.change])).toEqual([
      ['task.yaml', 'unchanged'],
      ['prompt.md', 'changed'],
      ['fixtures/invoices.csv', 'changed'],
      ['verify/check.py', 'unchanged'],
    ]);
    expect(diff.files[1]!.after).toEqual({
      sizeBytes: Buffer.byteLength(t3.prompt!),
      sha256: hash(t3.prompt!),
    });
    expect(diff.files[2]!.after).toEqual({
      sizeBytes: CSV.length + 'INV-3,1.00\n'.length,
      sha256: hash(`${CSV}INV-3,1.00\n`),
    });
    expect(diff.textFiles).toEqual([]);
  });

  it('lists the recorded root files first and line-diffs a changed small text file', () => {
    const record = (path: 'task.yaml' | 'prompt.md' | 'reference.json', content: string) => ({
      path,
      sha256: hash(content),
      size: Buffer.byteLength(content),
    });
    const before = [
      record('task.yaml', TOTAL_DUE_YAML),
      record('prompt.md', t2.prompt!),
      record('reference.json', '{ "total_due": 48213.65 }\n'),
    ];
    const after = [
      record('task.yaml', TOTAL_DUE_YAML),
      record('prompt.md', t3.prompt!),
      record('reference.json', '{ "total_due": 48526.05 }\n'),
    ];
    const next = `${CSV}INV-3,1.00\n`;
    const diff = TaskDiffSchema.parse(
      taskDiff(rows[1]!, rows[2]!, {
        rootFrom: before,
        rootTo: after,
        texts: new Map([
          [hash(CSV), CSV],
          [hash(next), next],
        ]),
      }),
    );
    expect(diff.files.map((f) => [f.path, f.change])).toEqual([
      ['task.yaml', 'unchanged'],
      ['prompt.md', 'changed'],
      ['reference.json', 'changed'],
      ['fixtures/invoices.csv', 'changed'],
      ['verify/check.py', 'unchanged'],
    ]);
    expect(diff.files[2]!.before).toEqual({ sizeBytes: 26, sha256: before[2]!.sha256 });
    expect(diff.textFiles).toEqual([
      {
        path: 'fixtures/invoices.csv',
        lines: expect.arrayContaining([
          { kind: 'added', text: 'INV-3,1.00', oldLine: null, newLine: expect.any(Number) },
        ]),
      },
    ]);
    expect(diff.textFiles[0]!.lines.filter((l) => l.kind !== 'same')).toHaveLength(1);
  });

  it('leaves a binary or oversized changed file out of the line diffs', () => {
    const next = `${CSV}INV-3,1.00\n`;
    const binary = taskDiff(rows[1]!, rows[2]!, {
      texts: new Map([
        [hash(CSV), CSV],
        [hash(next), null],
      ]),
    });
    expect(binary.textFiles).toEqual([]);
    const big = 'x'.repeat(64 * 1024 + 1);
    const large = taskDiff(rows[1]!, placed(t3, s3, big), {
      texts: new Map([
        [hash(CSV), CSV],
        [hash(big), big],
      ]),
    });
    expect(large.textFiles).toEqual([]);
  });
});
