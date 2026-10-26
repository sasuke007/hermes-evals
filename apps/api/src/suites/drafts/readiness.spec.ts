/**
 * The 13 readiness rules of SA.8 on in-memory draft tasks: each rule's
 * passed line, and its problems and warnings with their Fix targets. The
 * self-check rows are in readiness-self-check.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { mentionedNames } from './readiness-cross.js';
import { jsonErrorMessage } from './readiness.js';
import { INVOICES, NOW, OVERDUE_YAML, readiness, status } from './readiness-testing.helper-spec.js';

describe('a ready task', () => {
  it('passes every rule, with the lines the panel shows', async () => {
    const r = await readiness();
    expect(r.summary).toBe('ready');
    expect(r.counts).toEqual({ problems: 0, warnings: 0, pending: 0 });
    expect(r.checkedAt).toBe(NOW.toISOString());
    expect(r.rule('checks').message).toBe('`answer` is primary · 1 check');
    expect(r.rule('reference_paths').message).toBe('`answer` reads `overdue_count`: 17.');
    expect(r.rule('expected_folders').message).toBe('No file checks.');
    expect(r.rule('mentioned_files').message).toBe('`invoices.csv` is in workspace files.');
    expect(r.rule('self_check').message).toBe(
      'Reference passes `answer` · checked live as you type',
    );
    expect(r.rule('negative_control').message).toBe(
      "Answer checks are ungradable with no answer, so doing nothing can't pass.",
    );
    expect(r.mentionedFiles).toEqual([{ name: 'invoices.csv', location: 'workspace' }]);
    expect(r.referenceValues).toEqual([
      { key: 'answer', path: 'overdue_count', found: true, preview: '17' },
    ]);
    expect(r.needsWorker).toBe(false);
    expect(r.issues).toEqual([]);
  });
});

describe('the SA.5 problems', () => {
  it('reports a bad path, a missing instruction, a missing file and a leak', async () => {
    const r = await readiness({
      taskYaml: OVERDUE_YAML.replace('path: overdue_count', 'path: overdue'),
      prompt: 'Read `invoices.csv` and `ledger.csv`. How many invoices are overdue?\n',
      reference: '{ "overdue_count": 17, "total_due": 99760.52 }',
      files: {
        'fixtures/invoices.csv': INVOICES,
        'fixtures/notes.txt': 'Reconciled total: 99760.52 EUR\n',
      },
    });
    expect(status(r.rule('reference_paths'))).toEqual([
      'problem',
      'No value at `overdue` (check `answer`).',
    ]);
    expect(r.rule('reference_paths').target).toEqual({ section: 'answer', field: 'answerPath' });
    expect(status(r.rule('answer_block'))).toEqual([
      'warning',
      "The prompt doesn't ask for a fenced json block.",
    ]);
    expect(status(r.rule('mentioned_files'))).toEqual([
      'warning',
      '`ledger.csv` is mentioned but not in workspace files.',
    ]);
    expect(status(r.rule('reference_leak'))).toEqual([
      'warning',
      '`fixtures/notes.txt` contains `99760.52`, the reference value at `total_due`. The agent could read the answer.',
    ]);
    expect(r.rule('reference_leak').target).toEqual({
      section: 'workspace',
      field: 'fixtures/notes.txt',
    });
    expect(status(r.rule('self_check'))).toEqual([
      'problem',
      'Reference fails `answer`: no value at `overdue`.',
    ]);
    expect(r.summary).toBe('problems');
    expect(r.counts).toEqual({ problems: 2, warnings: 3, pending: 0 });
    expect(r.mentionedFiles).toEqual([
      { name: 'invoices.csv', location: 'workspace' },
      { name: 'ledger.csv', location: 'missing' },
    ]);
  });

  it('does not count a value inside a longer number or word as a leak', async () => {
    const r = await readiness({
      reference: '{ "overdue_count": 1704, "vendor": "Fjord" }',
      files: {
        'fixtures/invoices.csv': 'id,amount,vendor\n1,17040,Fjords\n2,0.1704,Fjord Software Ltd\n',
      },
    });
    expect(status(r.rule('reference_leak'))).toEqual([
      'warning',
      '`fixtures/invoices.csv` contains `Fjord`, the reference value at `vendor`. The agent could read the answer.',
    ]);
    const clean = await readiness({
      reference: '{ "overdue_count": 1704 }',
      files: { 'fixtures/invoices.csv': 'id,amount\n1,17040\n2,0.1704\n' },
    });
    expect(clean.rule('reference_leak').status).toBe('passed');
  });

  it('lists several missing files in one line, and a file the agent writes', async () => {
    const r = await readiness({
      prompt:
        'Match `statements.csv` against `ledger.csv`, write `summary.csv`. ```json fenced json```\n',
      files: {},
    });
    expect(r.rule('mentioned_files').message).toBe(
      '`statements.csv`, `ledger.csv` and `summary.csv` are mentioned but not in workspace files.',
    );
  });
});

describe('the leak rule', () => {
  const PROMPT = 'Count the overdue invoices in `invoices.csv`. ```json fenced json```\n';

  it('looks for leaf values of 4 characters or more, numbers and strings alike', async () => {
    const number = await readiness({
      reference: '{ "overdue_count": 1704 }',
      files: { 'fixtures/invoices.csv': 'id,amount\n1,1704\n' },
    });
    expect(status(number.rule('reference_leak'))).toEqual([
      'warning',
      '`fixtures/invoices.csv` contains `1704`, the reference value at `overdue_count`. The agent could read the answer.',
    ]);
    const word = await readiness({
      reference: '{ "overdue_count": 17, "city": "Oslo" }',
      files: { 'fixtures/invoices.csv': 'id,city\n1,Oslo\n' },
    });
    expect(status(word.rule('reference_leak'))).toEqual([
      'warning',
      '`fixtures/invoices.csv` contains `Oslo`, the reference value at `city`. The agent could read the answer.',
    ]);
    const short = await readiness({
      reference: '{ "overdue_count": 170 }',
      files: { 'fixtures/invoices.csv': 'id,amount\n1,170\n' },
    });
    expect(short.rule('reference_leak').status).toBe('passed');
  });

  it('reads only workspace fixtures, never the files that are meant to hold the answer', async () => {
    const r = await readiness({
      prompt: PROMPT,
      reference: '{ "overdue_count": 99760.52 }',
      files: {
        'fixtures/invoices.csv': INVOICES,
        'expected/summary.csv': 'overdue_count\n99760.52\n',
        'verify/check.py': 'EXPECTED = 99760.52\n',
        'home/memories/MEMORY.md': 'The overdue total was 99760.52 last month.\n',
      },
      kinds: {
        'expected/summary.csv': 'expected',
        'verify/check.py': 'verifier',
        'home/memories/MEMORY.md': 'home_seed',
      },
    });
    expect(r.rule('reference_leak').status).toBe('passed');
  });
});

describe('the mentioned-files rule', () => {
  it('finds a memory file the prompt names in the home seeds', async () => {
    const r = await readiness({
      prompt: 'Read `MEMORY.md` and `invoices.csv`, then answer. ```json fenced json```\n',
      files: {
        'fixtures/invoices.csv': INVOICES,
        'home/memories/MEMORY.md': 'Overdue means past the due date.\n',
      },
      kinds: { 'home/memories/MEMORY.md': 'home_seed' },
    });
    expect(r.mentionedFiles).toContainEqual({ name: 'MEMORY.md', location: 'home' });
    expect(r.rule('mentioned_files').status).toBe('passed');
    expect(r.rule('mentioned_files').message).toContain('`MEMORY.md` is in the home seeds.');
  });

  it('matches a bare name to a nested fixture, but not a path to a file elsewhere', async () => {
    const nested = await readiness({
      prompt: 'Count the overdue invoices in `invoices.csv`. ```json fenced json```\n',
      files: { 'fixtures/data/invoices.csv': INVOICES },
    });
    expect(nested.mentionedFiles).toEqual([{ name: 'invoices.csv', location: 'workspace' }]);
    expect(nested.rule('mentioned_files').status).toBe('passed');
    const moved = await readiness({
      prompt: 'Reconcile `data/ledger.csv`. ```json fenced json```\n',
      files: { 'fixtures/ledger.csv': 'id\n1\n' },
    });
    expect(moved.mentionedFiles).toEqual([{ name: 'data/ledger.csv', location: 'missing' }]);
    expect(moved.rule('mentioned_files').status).toBe('warning');
  });
});

describe('key and summary', () => {
  it('needs a summary, a free key, and warns on a rename', async () => {
    const r = await readiness({
      key: 'total_due',
      taskYaml: OVERDUE_YAML.replace(/^summary: .*$/m, "summary: ''"),
      renamedFrom: 'total_open',
    });
    const messages = r.issues
      .filter((i) => i.rule === 'key_summary')
      .map((i) => [i.severity, i.message]);
    expect(messages).toEqual([
      ['problem', 'Add a one-line summary.'],
      ['problem', '`total_due` is already a task in `invoices-v1`.'],
      [
        'warning',
        "Renaming makes this a new task. Results recorded under `total_open` won't compare with results under the new key.",
      ],
    ]);
    expect(r.rule('key_summary').status).toBe('problem');
  });
});

describe('task.yaml', () => {
  it('names an unknown key with its line', async () => {
    const r = await readiness({
      taskYaml: OVERDUE_YAML.replace('    primary: true', '    prmary: true'),
    });
    expect(status(r.rule('task_yaml'))).toEqual(['problem', 'line 12: unknown key `prmary`']);
    expect(r.rule('task_yaml').target).toEqual({ section: 'yaml', field: null });
  });

  it('marks two primaries on rows 2 and 3', async () => {
    const yaml = `${OVERDUE_YAML}  - key: reads_ledger\n    type: trajectory_match\n    primary: true\n    params: { tool: read_file }\n`;
    const r = await readiness({ taskYaml: yaml });
    expect(status(r.rule('task_yaml'))).toEqual([
      'problem',
      'line 16: a second check has `primary: true`.',
    ]);
    expect(status(r.rule('checks'))).toEqual(['problem', 'Mark exactly one check as primary.']);
  });

  it('puts limits on their fields', async () => {
    const r = await readiness({
      taskYaml: OVERDUE_YAML.replace('max_turns: 20', 'max_turns: 250').replace(
        'run_budget_seconds: 300',
        'run_budget_seconds: 10',
      ),
    });
    expect(r.issues.filter((i) => i.rule === 'task_yaml')).toEqual([
      {
        rule: 'task_yaml',
        severity: 'problem',
        target: { section: 'limits', field: 'maxTurns' },
        message: 'Max turns is 1 to 200.',
      },
      {
        rule: 'task_yaml',
        severity: 'problem',
        target: { section: 'limits', field: 'runBudgetSeconds' },
        message: 'Run budget is 30 to 3600 seconds.',
      },
    ]);
  });

  it('waits on rows that need a parsed task.yaml', async () => {
    const r = await readiness({ taskYaml: 'summary: [unclosed\n' });
    expect(r.rule('task_yaml').status).toBe('problem');
    expect(r.rule('task_yaml').message).toMatch(/^line 2, column \d+: /);
    for (const rule of ['checks', 'check_settings', 'reference_paths', 'self_check'] as const) {
      expect(status(r.rule(rule))).toEqual(['pending', 'Shown once `task.yaml` is valid.']);
    }
  });
});

describe('checks and their settings', () => {
  it('asks for a first check', async () => {
    const r = await readiness({
      taskYaml: OVERDUE_YAML.replace(/verification:[\s\S]*$/, 'verification: []\n'),
    });
    expect(status(r.rule('checks'))).toEqual(['problem', 'Add at least one check.']);
    expect(status(r.rule('reference_paths'))).toEqual([
      'pending',
      'Shown once a check reads a path.',
    ]);
    expect(status(r.rule('self_check'))).toEqual(['pending', 'Runs once there is a check.']);
    expect(status(r.rule('negative_control'))).toEqual(['pending', 'Shown once there is a check.']);
  });

  it('words settings errors as the card does, at the field', async () => {
    const yaml = `${OVERDUE_YAML.replace('{ abs: 0 }', '{ abs: -1 }')}  - key: answer
    type: file_check
    params: { path: summary.csv, format: csv, json_schema: { type: array } }
`;
    const r = await readiness({ taskYaml: yaml });
    const settings = r.issues.filter((i) => i.rule === 'check_settings');
    expect(settings.map((i) => [i.message, i.target.field])).toEqual([
      ['Two checks are named `answer`.', 'checks.1.key'],
      ["Tolerance can't be negative.", 'checks.0.params.abs'],
      ['A JSON Schema needs format json.', 'checks.1.params.json_schema'],
    ]);
  });

  it('asks for the settings a new card has no value for, in plain words', async () => {
    const yaml = OVERDUE_YAML.replace(
      /verification:[\s\S]*$/,
      'verification:\n  - key: file\n    type: file_check\n    primary: true\n    params: {}\n  - key: reads\n    type: trajectory_match\n    params: {}\n',
    );
    const r = await readiness({ taskYaml: yaml });
    const settings = r.issues.filter((i) => i.rule === 'check_settings');
    expect(settings.map((i) => [i.message, i.target.field])).toEqual([
      ['Add the file path.', 'checks.0.params.path'],
      ['Add `tool`.', 'checks.1.params.tool'],
    ]);
  });

  it('warns when exact text compares an object', async () => {
    const r = await readiness({
      taskYaml: OVERDUE_YAML.replace('type: numeric_tolerance', 'type: exact_match').replace(
        '{ abs: 0 }',
        '{}',
      ),
      reference: '{ "overdue_count": { "Fjord Software": 3 } }',
    });
    expect(status(r.rule('reference_paths'))).toEqual([
      'warning',
      '`answer` compares the object `overdue_count` as text. JSON match fits an object.',
    ]);
  });

  it('passes a tool-use primary that needs a call, and refuses one that needs none', async () => {
    const tool = (min: number) =>
      OVERDUE_YAML.replace(
        /verification:[\s\S]*$/,
        `verification:\n  - key: reads_ledger\n    type: trajectory_match\n    primary: true\n    params: { tool: read_file, min_calls: ${min} }\n`,
      );
    const once = await readiness({ taskYaml: tool(1) });
    expect(status(once.rule('negative_control'))).toEqual([
      'passed',
      '`reads_ledger` needs at least one `read_file` call, so doing nothing fails.',
    ]);
    expect(once.rule('self_check').message).toBe(
      'No answer checks to self-check. `reads_ledger` is checked when runs are scored.',
    );
    expect(once.rule('reference_paths').message).toBe('No check reads the reference.');
    const never = await readiness({ taskYaml: tool(0) });
    expect(status(never.rule('negative_control'))).toEqual([
      'problem',
      '`reads_ledger` passes with no `read_file` call, so doing nothing would pass.',
    ]);
  });
});

describe('the reference', () => {
  it('asks for a missing reference and locates invalid JSON', async () => {
    const missing = await readiness({ reference: null });
    expect(status(missing.rule('reference_json'))).toEqual([
      'problem',
      'Add the reference answer.',
    ]);
    expect(status(missing.rule('reference_paths'))).toEqual([
      'pending',
      'Enter the reference to see the values the checks read.',
    ]);
    const invalid = await readiness({ reference: '{ "overdue_count": 17,, }' });
    expect(invalid.rule('reference_json').status).toBe('problem');
    expect(invalid.rule('reference_json').message).toMatch(
      /^line 1, col 23: Expected double-quoted property name\./,
    );
    expect(invalid.rule('reference_paths').message).toBe(
      'Values can be read once the reference is valid JSON.',
    );
    expect(invalid.rule('self_check').message).toBe('Runs once the reference is valid JSON.');
  });

  it('locates the error in a message', () => {
    expect(jsonErrorMessage('{\n  "a": 1\n  "b": 2\n}')).toMatch(/^line 3, col 3: /);
    expect(jsonErrorMessage('{"a": 1}')).toBeNull();
  });
});

describe('files', () => {
  it('refuses a file over 25 MB', async () => {
    const r = await readiness({
      files: {
        'fixtures/invoices.csv': INVOICES,
        'fixtures/ledger-2025.parquet': { size: 31_200_000 },
      },
    });
    expect(status(r.rule('file_limits'))).toEqual([
      'problem',
      '`ledger-2025.parquet` is over 25 MB.',
    ]);
    expect(r.rule('file_limits').target).toEqual({
      section: 'workspace',
      field: 'fixtures/ledger-2025.parquet',
    });
  });
});

describe('mentionedNames', () => {
  it('reads file names, not numbers, code blocks or configuration documents', () => {
    expect(
      mentionedNames(
        'Use `invoices.csv`, notes.txt and `docs/vendors.json`; amounts like `1234.50`.\n\n```json\n{ "file": "summary.csv" }\n```\nRead treasury_export.bx too.\n',
      ),
    ).toEqual(['invoices.csv', 'notes.txt']);
  });
});
