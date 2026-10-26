/**
 * buildImportedTasks: the column mapping of SA.9 (task key, summary, prompt,
 * the whole reference, the value at the answer path), the shared workspace
 * files, checks and limits, the appended answer paragraph, and the preview's
 * fixes. The readiness rules are the drafts module's (B1); here a stand-in
 * records what it was asked and answers from the key alone.
 */
import { parse as parseYaml } from 'yaml';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIRECTORY_KEY_PATTERN,
  TaskImportPreviewSchema,
  TaskImportSettingsSchema,
  TaskYamlSchema,
  type TaskImportSettings,
} from '@hermes-evals/shared';
import type { DraftTaskFolder } from '../drafts/materialise.js';
import { evaluateReadiness, type ReadinessContext } from '../drafts/readiness.js';
import {
  buildImportedTasks,
  parseTaskTable,
  type TaskImportContext,
  type TaskTableRow,
} from './parsers.js';

vi.mock('../drafts/readiness.js', () => ({
  evaluateReadiness: vi.fn(async (task: DraftTaskFolder, context: ReadinessContext) => {
    for (const file of task.files) await context.readBlob(file.sha256);
    const taken = context.otherKeys.includes(task.key);
    const ok = DIRECTORY_KEY_PATTERN.test(task.key) && !taken;
    return { readiness: { summary: ok ? 'ready' : 'problems' }, analysis: {} };
  }),
}));

const SHA = (c: string) => c.repeat(64);
const INVOICES = {
  path: 'fixtures/invoices.csv',
  kind: 'fixture' as const,
  sha256: SHA('a'),
  size: 4400,
};

const TOTAL_DUE: DraftTaskFolder = {
  key: 'total_due',
  taskYaml: `summary: Total amount still due
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file, terminal]
answer:
  format: fenced_json
  path: total_due
# the primary check
verification:
  - key: answer
    primary: true
    type: numeric_tolerance
    params: { path: total_due, abs: 0.01 }
  - key: judged
    type: llm_judge
    params: { rubric: rubric.md }
  - key: script
    type: verifier_script
    params: { script: check.py }
`,
  prompt: 'What is due?\n',
  reference: '{ "total_due": 1 }\n',
  rubrics: { 'rubric.md': 'Be fair.\n', 'other.md': 'unused\n' },
  files: [
    INVOICES,
    { path: 'fixtures/notes.md', kind: 'fixture', sha256: SHA('b'), size: 10 },
    { path: 'home/memories/USER.md', kind: 'home_seed', sha256: SHA('c'), size: 10 },
    { path: 'verify/check.py', kind: 'verifier', sha256: SHA('d'), size: 99 },
    { path: 'verify/expected.json', kind: 'verifier', sha256: SHA('e'), size: 9 },
  ],
};

const OVERDUE_CSV = `key,question,expected
overdue_fjord,How many overdue invoices does Fjord Software have?,3
overdue_granite,How many overdue invoices does Granite Office have?,2
overdue_over_5000,"How many overdue invoices are over 5,000 EUR?",6
overdue 90,How many invoices are more than 90 days overdue?,1
overdue_disputed,How many overdue invoices are disputed?,2
overdue_no_po,How many overdue invoices have no purchase order?,5
`;

function rowsOf(name: string, text: string): TaskTableRow[] {
  const result = parseTaskTable(name, Buffer.from(text));
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.rows;
}

/** The board's settings (SA.9 step 3), with `overrides`. */
function settingsOf(overrides: Partial<TaskImportSettings> = {}): TaskImportSettings {
  return TaskImportSettingsSchema.parse({
    mapping: [
      { column: 'key', use: 'task_key' },
      { column: 'question', use: 'prompt' },
      { column: 'expected', use: 'reference_value' },
    ],
    keyPrefix: null,
    answerPath: 'answer',
    workspace: { from: 'task', key: 'total_due' },
    checks: {
      from: 'new',
      checks: [{ key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0 } }],
    },
    limits: { maxTurns: 20, runBudgetSeconds: 300, toolsetsNeeded: ['file', 'terminal'] },
    appendAnswerInstructions: true,
    keyFixes: [],
    ...overrides,
  });
}

const reads: string[] = [];
function contextOf(overrides: Partial<TaskImportContext> = {}): TaskImportContext {
  return {
    folder: 'invoices-v1',
    existingKeys: new Set(['total_due', 'overdue_count']),
    workspaceSource: TOTAL_DUE,
    checksSource: TOTAL_DUE,
    uploads: [],
    readBlob: async (sha256) => {
      reads.push(sha256);
      return Buffer.from('');
    },
    ...overrides,
  };
}

async function build(rows: TaskTableRow[], settings: TaskImportSettings, context = contextOf()) {
  const result = await buildImportedTasks(rows, settings, context);
  TaskImportPreviewSchema.parse(result.preview);
  return result;
}

beforeEach(() => {
  reads.length = 0;
  vi.mocked(evaluateReadiness).mockClear();
});

describe('the board: overdue_questions.csv into invoices-v1', () => {
  it('builds one task per row and holds back the row whose key needs a fix', async () => {
    const { preview, tasks } = await build(
      rowsOf('overdue_questions.csv', OVERDUE_CSV),
      settingsOf(),
    );
    expect(preview.addCount).toBe(5);
    expect(preview.fixCount).toBe(1);
    expect(preview.messages).toEqual([
      {
        severity: 'info',
        message:
          'No column is mapped to Summary. Summaries are taken from the first 80 characters of each prompt.',
      },
    ]);
    expect(preview.rows[3]).toEqual({
      row: 4,
      key: 'overdue 90',
      summary: 'How many invoices are more than 90 days overdue?',
      referenceValue: '1',
      readiness: 'problems',
      problems: [
        {
          field: 'key',
          message:
            'Row 4: key overdue 90 has a space. Use letters, digits, ., _ and -, starting with a letter or digit.',
        },
      ],
      needsFix: true,
    });
    expect(preview.rows[0]).toMatchObject({
      key: 'overdue_fjord',
      referenceValue: '3',
      readiness: 'ready',
    });
    expect(tasks.map((t) => t.key)).toEqual([
      'overdue_fjord',
      'overdue_granite',
      'overdue_over_5000',
      'overdue_disputed',
      'overdue_no_po',
    ]);
  });

  it('writes the canonical task.yaml, the prompt with its answer paragraph, and the reference at the path', async () => {
    const { tasks } = await build(rowsOf('q.csv', OVERDUE_CSV), settingsOf());
    expect(tasks[0]).toEqual({
      key: 'overdue_fjord',
      taskYaml: `summary: How many overdue invoices does Fjord Software have?
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file, terminal]
answer:
  format: fenced_json
  path: answer
verification:
  - key: answer
    type: numeric_tolerance
    primary: true
    params: { abs: 0 }
`,
      prompt: `How many overdue invoices does Fjord Software have?

End your reply with your answer as a fenced JSON block, exactly in this shape:

\`\`\`json
{ "answer": 0 }
\`\`\`
`,
      reference: '{\n  "answer": 3\n}\n',
      rubrics: {},
      files: [INVOICES, TOTAL_DUE.files[1]],
    });
    TaskYamlSchema.parse(parseYaml(tasks[0]!.taskYaml!));
  });

  it('adds the row once its key is fixed inline', async () => {
    const settings = settingsOf({ keyFixes: [{ row: 4, key: 'overdue_90' }] });
    const { preview, tasks } = await build(rowsOf('q.csv', OVERDUE_CSV), settings);
    expect(preview).toMatchObject({ addCount: 6, fixCount: 0 });
    expect(tasks[3]!.key).toBe('overdue_90');
  });

  it('runs the readiness rules on every row, knowing the other keys and reading each blob once', async () => {
    await build(rowsOf('q.csv', OVERDUE_CSV), settingsOf());
    const calls = vi.mocked(evaluateReadiness).mock.calls;
    expect(calls).toHaveLength(6);
    expect(calls[0]![1]).toMatchObject({
      folder: 'invoices-v1',
      renamedFrom: null,
      lastSelfCheck: null,
    });
    expect(calls[0]![1].otherKeys).toEqual([
      'total_due',
      'overdue_count',
      'overdue_granite',
      'overdue_over_5000',
      'overdue 90',
      'overdue_disputed',
      'overdue_no_po',
    ]);
    expect(reads.sort()).toEqual([SHA('a'), SHA('b')]);
  });
});

describe('keys', () => {
  it('generates keys from the prefix when no column is Task key', async () => {
    const settings = settingsOf({
      mapping: [
        { column: 'question', use: 'prompt' },
        { column: 'expected', use: 'reference_value' },
        { column: 'key', use: 'ignore' },
      ],
      keyPrefix: 'overdue_q',
    });
    const { preview, tasks } = await build(rowsOf('q.csv', OVERDUE_CSV), settings);
    expect(tasks.map((t) => t.key)).toEqual([
      'overdue_q01',
      'overdue_q02',
      'overdue_q03',
      'overdue_q04',
      'overdue_q05',
      'overdue_q06',
    ]);
    expect(preview.messages[0]).toEqual({
      severity: 'info',
      message:
        'No column is mapped to Task key, so keys are generated: overdue_q01, overdue_q02, …',
    });
  });

  it('needs a fix for a key the draft holds and for a key an earlier row took', async () => {
    const text = 'key,question,expected\nq1,a?,1\ntotal_due,b?,2\nq1,c?,3\n';
    const { preview, tasks } = await build(rowsOf('q.csv', text), settingsOf());
    expect(preview.rows.map((r) => r.problems)).toEqual([
      [],
      [{ field: 'key', message: 'Row 2: total_due is already a task in invoices-v1.' }],
      [{ field: 'key', message: 'Row 3: q1 is also the key of row 1.' }],
    ]);
    expect(tasks.map((t) => t.key)).toEqual(['q1']);
  });

  it.each([
    [null, 'Set a key prefix, or map a column to Task key.'],
    [
      '_q',
      'The key prefix _q starts with "_". Use letters, digits, ., _ and -, starting with a letter or digit.',
    ],
  ])('refuses the mapping with the prefix %j', async (keyPrefix, message) => {
    const settings = settingsOf({
      mapping: [
        { column: 'question', use: 'prompt' },
        { column: 'expected', use: 'reference_value' },
      ],
      keyPrefix,
    });
    const { preview } = await build(rowsOf('q.csv', OVERDUE_CSV), settings);
    expect(preview.messages).toContainEqual({ severity: 'problem', message });
  });
});

describe('the mapping as a whole', () => {
  it.each([
    [
      [
        { column: 'key', use: 'task_key' },
        { column: 'expected', use: 'reference_value' },
      ],
      'Map one column to Prompt.',
    ],
    [
      [
        { column: 'key', use: 'task_key' },
        { column: 'question', use: 'prompt' },
      ],
      'Map one column to Reference or Reference value.',
    ],
    [
      [
        { column: 'question', use: 'prompt' },
        { column: 'expected', use: 'reference_value' },
        { column: 'key', use: 'reference' },
      ],
      'Map only one column to Reference or Reference value.',
    ],
    [
      [
        { column: 'key', use: 'task_key' },
        { column: 'question', use: 'prompt' },
        { column: 'answer', use: 'reference' },
      ],
      'Column answer is not in the file.',
    ],
  ] as const)('a mapping with a problem adds nothing (%#)', async (mapping, message) => {
    const { preview, tasks } = await build(
      rowsOf('q.csv', OVERDUE_CSV),
      settingsOf({ mapping: [...mapping] }),
    );
    expect(preview.messages).toContainEqual({ severity: 'problem', message });
    expect(tasks).toEqual([]);
    expect(preview).toMatchObject({ addCount: 0, fixCount: 0 });
    expect(new Set(preview.rows.map((r) => r.readiness))).toEqual(new Set(['not_run']));
    expect(evaluateReadiness).not.toHaveBeenCalled();
  });

  it('needs an answer path for a Reference value', async () => {
    const { preview } = await build(rowsOf('q.csv', OVERDUE_CSV), settingsOf({ answerPath: null }));
    expect(preview.messages).toContainEqual({
      severity: 'problem',
      message: 'Set the answer path: each Reference value goes in at that path.',
    });
  });

  it('needs the tasks the settings copy from to be in the draft', async () => {
    const { preview } = await build(
      rowsOf('q.csv', OVERDUE_CSV),
      settingsOf({ checks: { from: 'task', key: 'gone' }, workspace: { from: 'upload' } }),
      contextOf({ checksSource: null }),
    );
    expect(preview.messages.filter((m) => m.severity === 'problem')).toEqual([
      { severity: 'problem', message: 'Upload the workspace files, or choose None.' },
      { severity: 'problem', message: 'gone is not a task of the draft.' },
    ]);
  });
});

describe('references', () => {
  it('reads a CSV cell as JSON when it is JSON, and as text otherwise', async () => {
    const text =
      'key,question,expected\na,q?,true\nb,q?,007\nc,q?,Fjord Software\nd,q?,"[1, 2]"\ne,q?,\n';
    const { preview, tasks } = await build(
      rowsOf('q.csv', text),
      settingsOf({ appendAnswerInstructions: false }),
    );
    expect(tasks.map((t) => JSON.parse(t.reference!))).toEqual([
      { answer: true },
      { answer: '007' },
      { answer: 'Fjord Software' },
      { answer: [1, 2] },
      { answer: '' },
    ]);
    expect(preview.rows[4]!.problems).toEqual([
      { field: 'reference', message: 'Row 5: no value for expected.' },
    ]);
    expect(tasks[0]!.prompt).toBe('q?\n');
  });

  it('places the value at a nested answer path, from JSONL', async () => {
    const rows = rowsOf(
      'vat.jsonl',
      '{"id":"vat_a","ask":"VAT?","value":2.5}\n{"id":"vat_b","ask":"VAT?","value":{"rate":0.2}}\n',
    );
    const { tasks } = await build(
      rows,
      settingsOf({
        mapping: [
          { column: 'id', use: 'task_key' },
          { column: 'ask', use: 'prompt' },
          { column: 'value', use: 'reference_value' },
        ],
        answerPath: 'totals.vat',
      }),
    );
    expect(JSON.parse(tasks[0]!.reference!)).toEqual({ totals: { vat: 2.5 } });
    expect(JSON.parse(tasks[1]!.reference!)).toEqual({ totals: { vat: { rate: 0.2 } } });
    expect(tasks[0]!.prompt).toContain('{ "totals": { "vat": 0.0 } }');
    expect(tasks[0]!.taskYaml).toContain('  path: totals.vat\n');
  });

  it('keeps a whole-JSON cell verbatim, and reports one that is not JSON', async () => {
    const text = 'key,question,answer\na,q?,"{""duplicates"": [""INV-7""]}"\nb,q?,not json\n';
    const { preview, tasks } = await build(
      rowsOf('q.csv', text),
      settingsOf({
        mapping: [
          { column: 'key', use: 'task_key' },
          { column: 'question', use: 'prompt' },
          { column: 'answer', use: 'reference' },
        ],
        answerPath: null,
        appendAnswerInstructions: true,
      }),
    );
    expect(tasks.map((t) => t.reference)).toEqual(['{"duplicates": ["INV-7"]}\n', 'not json\n']);
    expect(preview.rows.map((r) => r.referenceValue)).toEqual([
      '{"duplicates":["INV-7"]}',
      'not json',
    ]);
    expect(preview.rows[1]!.problems[0]!.message).toMatch(/^Row 2: answer is not valid JSON \(/);
    expect(preview.rows[1]!.needsFix).toBe(false);
    expect(tasks[0]!.prompt).toContain('{ "duplicates": [] }');
    expect(tasks[0]!.taskYaml).not.toContain('path:');
  });

  it('writes a JSONL whole reference as indented JSON', async () => {
    const rows = rowsOf('t.jsonl', '{"k":"a","p":"q?","r":{"total":3,"ids":["x"]}}\n');
    const { tasks } = await build(
      rows,
      settingsOf({
        mapping: [
          { column: 'k', use: 'task_key' },
          { column: 'p', use: 'prompt' },
          { column: 'r', use: 'reference' },
        ],
      }),
    );
    expect(tasks[0]!.reference).toBe('{\n  "total": 3,\n  "ids": [\n    "x"\n  ]\n}\n');
  });
});

describe('shared settings', () => {
  it('copies the checks of a task with the rubrics and scripts they read', async () => {
    const { tasks } = await build(
      rowsOf('q.csv', OVERDUE_CSV),
      settingsOf({ checks: { from: 'task', key: 'total_due' }, workspace: { from: 'none' } }),
    );
    const task = tasks[0]!;
    expect(task.rubrics).toEqual({ 'rubric.md': 'Be fair.\n' });
    expect(task.files.map((f) => f.path)).toEqual(['verify/check.py', 'verify/expected.json']);
    expect(task.taskYaml).toContain(`verification:
  - key: answer
    type: numeric_tolerance
    primary: true
    params: { path: total_due, abs: 0.01 }
  - key: judged
    type: llm_judge
    params: { rubric: rubric.md }
`);
    expect(task.taskYaml).not.toContain('#');
  });

  it('takes the uploaded workspace files', async () => {
    const upload = {
      path: 'fixtures/ledger.csv',
      kind: 'fixture' as const,
      sha256: SHA('f'),
      size: 5,
    };
    const { tasks } = await build(
      rowsOf('q.csv', OVERDUE_CSV),
      settingsOf({ workspace: { from: 'upload' } }),
      contextOf({ uploads: [upload] }),
    );
    expect(tasks[0]!.files).toEqual([upload]);
  });

  it('takes summaries from a Summary column, and from the prompt where a cell is empty', async () => {
    const text =
      'key,title,question,expected\na,Fjord count,How many?,1\nb,,How many for Granite?,2\n';
    const { tasks, preview } = await build(
      rowsOf('q.csv', text),
      settingsOf({
        mapping: [
          { column: 'key', use: 'task_key' },
          { column: 'title', use: 'summary' },
          { column: 'question', use: 'prompt' },
          { column: 'expected', use: 'reference_value' },
        ],
      }),
    );
    expect(preview.rows.map((r) => r.summary)).toEqual(['Fjord count', 'How many for Granite?']);
    expect(tasks[0]!.taskYaml).toMatch(/^summary: Fjord count\n/);
    expect(preview.messages).toEqual([]);
  });
});
