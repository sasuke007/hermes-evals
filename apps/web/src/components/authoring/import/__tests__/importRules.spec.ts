import { describe, expect, it } from 'vitest';
import type { SuiteZipTask, TaskTableFile } from '@/api/types/authoring';
import {
  guessMapping,
  hasKeyColumn,
  mappingMessages,
  mappingReady,
  zoneOf,
  type ColumnMapping,
} from '../columnMapping';
import { checkSentence, initialSettings, newCheckFor, sampleReference } from '../importSettings';
import {
  newNameProblem,
  rootFilesSentence,
  scriptsCountLine,
  scriptsSentence,
  splitTasks,
  taskCountLine,
  taskLine,
  zipChip,
} from '../zipFormat';

const file: TaskTableFile = {
  fileName: 'overdue_questions.csv',
  format: 'csv',
  sizeBytes: 410,
  rowCount: 6,
  columns: [
    { name: 'key', samples: ['overdue_fjord', 'overdue_granite', 'overdue_over_5000'] },
    { name: 'question', samples: ['How many overdue invoices does Fjord Software have?'] },
    { name: 'expected', samples: ['3', '2', '6'] },
  ],
};
const map = (uses: [string, ColumnMapping['use']][]): ColumnMapping[] =>
  uses.map(([column, use]) => ({ column, use }));

describe('ColumnMapper rules (SA.9 step 2)', () => {
  it('maps a typical file by its column names: key, question, expected', () => {
    expect(guessMapping(file.columns)).toEqual(
      map([
        ['key', 'task_key'],
        ['question', 'prompt'],
        ['expected', 'reference_value'],
      ]),
    );
  });

  it('is ready with a prompt and a reference, noting the summaries taken from the prompts', () => {
    const valid = guessMapping(file.columns);
    expect(mappingReady(valid)).toBe(true);
    expect(mappingMessages(valid)).toEqual([
      {
        severity: 'info',
        message:
          'No column is mapped to Summary. Summaries are taken from the first 80 characters of each prompt.',
        column: null,
      },
    ]);
  });

  it('asks for a prompt, outlining the column set to Ignore', () => {
    const missing = map([
      ['key', 'task_key'],
      ['question', 'ignore'],
      ['expected', 'reference_value'],
    ]);
    expect(mappingReady(missing)).toBe(false);
    expect(mappingMessages(missing)[0]).toEqual({
      severity: 'problem',
      message: 'Map one column to Prompt.',
      column: 'question',
    });
  });

  it('asks for a reference, and refuses a use given twice or both kinds of reference', () => {
    const noReference = map([
      ['key', 'task_key'],
      ['question', 'prompt'],
      ['expected', 'ignore'],
    ]);
    expect(mappingMessages(noReference).map((m) => m.message)).toContain(
      'Map one column to Reference or Reference value.',
    );
    const twice = map([
      ['key', 'prompt'],
      ['question', 'prompt'],
      ['expected', 'reference_value'],
    ]);
    expect(mappingMessages(twice)[0]).toMatchObject({
      message: 'Map only one column to Prompt.',
      column: 'question',
    });
    const both = map([
      ['key', 'reference'],
      ['question', 'prompt'],
      ['expected', 'reference_value'],
    ]);
    expect(mappingMessages(both).map((m) => m.message)).toContain(
      'Map Reference or Reference value, not both.',
    );
  });

  it('generates keys when no column is the Task key, and says where each column goes', () => {
    expect(hasKeyColumn(map([['question', 'prompt']]))).toBe(false);
    expect([
      zoneOf('prompt'),
      zoneOf('reference_value'),
      zoneOf('task_key'),
      zoneOf('ignore'),
    ]).toEqual(['visible', 'hidden', 'metadata', 'none']);
  });
});

describe('shared settings (SA.9 step 3)', () => {
  it('starts from the guessed mapping, the first task, a suggested check and the board limits', () => {
    const settings = initialSettings(file, ['total_due', 'overdue_count']);
    expect(settings).toMatchObject({
      keyPrefix: 'overdue_q',
      answerPath: 'answer',
      workspace: { from: 'task', key: 'total_due' },
      checks: {
        from: 'new',
        checks: [{ key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0 } }],
      },
      limits: { maxTurns: 20, runBudgetSeconds: 300, toolsetsNeeded: ['file', 'terminal'] },
      appendAnswerInstructions: true,
      keyFixes: [],
    });
    expect(initialSettings(file, []).workspace).toEqual({ from: 'none' });
  });

  it('puts the value column at the answer path and words the new check', () => {
    expect(sampleReference(file, guessMapping(file.columns), 'answer')).toEqual({ answer: 3 });
    expect(newCheckFor('INV-1').type).toBe('exact_match');
    expect(checkSentence(newCheckFor(3), 'answer')).toBe('numeric_tolerance on answer, abs 0');
  });
});

const task = (key: string, over: Partial<SuiteZipTask> = {}): SuiteZipTask => ({
  key,
  summary: null,
  readiness: 'ready',
  problem: null,
  workspaceFiles: 1,
  checks: 1,
  ...over,
});

describe('zip review wording (SA.10)', () => {
  it('counts the tasks and words each line', () => {
    const tasks = [
      task('a'),
      task('late_fees', { readiness: 'problems', problem: 'bad' }),
      task('summary_file', { readiness: 'not_run' }),
    ];
    expect(taskCountLine(tasks)).toBe('3 · 1 valid · 1 self-check not run');
    expect(taskLine(task('unmatched_lines', { workspaceFiles: 2 }), true)).toBe(
      'valid · 2 workspace files · 1 check',
    );
    expect(zipChip({ tasks } as never)).toEqual({ text: '1 invalid task', tone: 'ung' });
    expect(scriptsSentence({ files: 2, checkScripts: 2 })).toBe(
      'The 2 scripts a check runs will run in the worker when the suite is checked and when runs are scored. Import only suites you trust.',
    );
  });

  it('counts the files under verify/ and, apart, the scripts a check runs (Phase 7)', () => {
    expect(scriptsCountLine({ files: 3, checkScripts: 2 })).toBe(
      '3 files under `verify/` · 2 scripts a check runs',
    );
    expect(scriptsCountLine({ files: 2, checkScripts: 1 })).toBe(
      '2 files under `verify/` · 1 script a check runs',
    );
    expect(scriptsCountLine({ files: 1, checkScripts: 0 })).toBe(
      '1 file under `verify/` · no check runs them',
    );
    expect(scriptsSentence({ files: 2, checkScripts: 1 })).toMatch(
      /^The script a check runs will run in the worker/,
    );
    expect(scriptsSentence({ files: 1, checkScripts: 0 })).toBe(
      'No check runs them now, but a check can name any of them later. Import only suites you trust.',
    );
  });

  it('names the root files the import leaves out (Phase 7)', () => {
    expect(rootFilesSentence([{ path: 'README.md', sizeBytes: 10 }])).toBe(
      '`README.md` at the suite root is not imported: a draft keeps `suite.yaml` and the task folders only.',
    );
    expect(
      rootFilesSentence([
        { path: 'LICENSE', sizeBytes: 1 },
        { path: 'README.md', sizeBytes: 1 },
      ]),
    ).toBe(
      '2 files at the suite root are not imported: a draft keeps `suite.yaml` and the task folders only.',
    );
  });

  it('lists eight tasks, every invalid one included, and sums up the valid rest', () => {
    const tasks = Array.from({ length: 12 }, (_, i) =>
      task(`t${i}`, i === 10 ? { readiness: 'problems' } : {}),
    );
    const split = splitTasks(tasks);
    expect(split.shown).toHaveLength(8);
    expect(split.shown.map((t) => t.key)).toContain('t10');
    expect(split.more).toEqual(['t7', 't8', 't9', 't11']);
  });

  it('checks a new name against the folder rule and the names held', () => {
    const holders = [{ name: 'invoices-v1', path: './suites/invoices-v1', draft: false }];
    expect(newNameProblem('invoices-v1', holders)).toBe('invoices-v1 already exists.');
    expect(newNameProblem('Invoices v2', holders)).toBe(
      'Use letters, digits, ., _ and -, starting with a letter or digit.',
    );
    expect(newNameProblem('invoices-v1-copy', holders)).toBeNull();
  });
});
