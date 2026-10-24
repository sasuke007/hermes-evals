import { describe, expect, it } from 'vitest';
import {
  SCORER_PARAM_SCHEMAS,
  SuiteYamlSchema,
  TaskYamlSchema,
  type ScorerParams,
} from '../src/suite-files.js';
import { SCORER_TYPES, type ScorerType } from '../src/vocab.js';

/**
 * suites/invoices-v1/total_due/task.yaml as the YAML parser returns it. The
 * package has no YAML parser of its own; the suite loader's tests read the
 * file itself.
 */
const TOTAL_DUE_TASK = {
  summary: 'Total amount still due across invoices that are not paid',
  limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file', 'terminal'] },
  answer: { format: 'fenced_json', path: 'total_due' },
  verification: [
    {
      key: 'answer',
      type: 'numeric_tolerance',
      primary: true,
      params: { path: 'total_due', abs: 0.01 },
    },
  ],
};

const params = (type: ScorerType, value: unknown) => SCORER_PARAM_SCHEMAS[type].safeParse(value);

/** The issue paths a failed parse reports, joined with dots. */
function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  expect(result.success).toBe(false);
  return result.error!.issues.map((i) => i.path.join('.'));
}

describe('suite.yaml', () => {
  it('parses the sample suite and keeps a numeric label as a string', () => {
    const suite = SuiteYamlSchema.parse({
      name: 'invoices-v1',
      version_label: '0.1',
      description: 'Accounts-payable questions over one family of invoice fixtures.',
    });
    expect(suite).toMatchObject({ name: 'invoices-v1', version_label: '0.1' });
    expect(SuiteYamlSchema.parse({ name: 'x', version_label: 2 }).version_label).toBe('2');
  });

  it('refuses bad names, unknown keys and repeated task keys', () => {
    expect(SuiteYamlSchema.safeParse({ name: '-x', version_label: '1' }).success).toBe(false);
    expect(SuiteYamlSchema.safeParse({ name: 'a/b', version_label: '1' }).success).toBe(false);
    expect(SuiteYamlSchema.safeParse({ name: 'x', version_label: '' }).success).toBe(false);
    expect(SuiteYamlSchema.safeParse({ name: 'x' }).success).toBe(false);
    expect(
      issuePaths(SuiteYamlSchema.safeParse({ name: 'x', version_label: '1', verison: 2 })),
    ).toEqual(['']);
    expect(
      SuiteYamlSchema.safeParse({ name: 'x', version_label: '1', tasks: ['a', 'b', 'a'] }).success,
    ).toBe(false);
    expect(
      SuiteYamlSchema.parse({ name: 'x', version_label: '1', tasks: ['total_due', 'vat.split'] })
        .tasks,
    ).toEqual(['total_due', 'vat.split']);
  });
});

describe('task.yaml', () => {
  it('parses total_due and fills the defaults', () => {
    const task = TaskYamlSchema.parse(TOTAL_DUE_TASK);
    expect(task.verification[0]).toEqual({
      key: 'answer',
      type: 'numeric_tolerance',
      primary: true,
      params: { path: 'total_due', abs: 0.01 },
    });
    expect(task.self_check).toBeUndefined();
    const minimal = TaskYamlSchema.parse({
      ...TOTAL_DUE_TASK,
      verification: [{ key: 'reads', type: 'trajectory_match' }],
    });
    expect(minimal.verification[0]).toMatchObject({ primary: false, params: {} });
  });

  it('accepts a file-producing task with an expected workspace', () => {
    const task = TaskYamlSchema.parse({
      ...TOTAL_DUE_TASK,
      self_check: { expected_workspace: 'expected', negative_control: true },
    });
    expect(task.self_check).toEqual({ expected_workspace: 'expected', negative_control: true });
  });

  it('refuses unknown keys at every level', () => {
    expect(issuePaths(TaskYamlSchema.safeParse({ ...TOTAL_DUE_TASK, notes: 'x' }))).toEqual(['']);
    const typo = {
      ...TOTAL_DUE_TASK,
      verification: [{ key: 'answer', type: 'exact_match', primary: true, parms: {} }],
    };
    expect(issuePaths(TaskYamlSchema.safeParse(typo))).toEqual(['verification.0']);
    const limits = { ...TOTAL_DUE_TASK, limits: { ...TOTAL_DUE_TASK.limits, max_turn: 3 } };
    expect(issuePaths(TaskYamlSchema.safeParse(limits))).toEqual(['limits']);
  });

  it('refuses an empty verification list, unknown types, bad keys and other formats', () => {
    const bad = [
      { ...TOTAL_DUE_TASK, verification: [] },
      { ...TOTAL_DUE_TASK, verification: [{ key: 'answer', type: 'regex_match' }] },
      { ...TOTAL_DUE_TASK, verification: [{ key: 'Answer', type: 'exact_match' }] },
      { ...TOTAL_DUE_TASK, answer: { format: 'json' } },
      { ...TOTAL_DUE_TASK, limits: { ...TOTAL_DUE_TASK.limits, max_turns: 0 } },
      { ...TOTAL_DUE_TASK, self_check: { expected_workspace: '../elsewhere' } },
      { ...TOTAL_DUE_TASK, self_check: { negative_control: true } },
    ];
    for (const value of bad) expect(TaskYamlSchema.safeParse(value).success).toBe(false);
  });
});

describe('scorer params', () => {
  it('has a schema for every scorer type', () => {
    expect(Object.keys(SCORER_PARAM_SCHEMAS).sort()).toEqual([...SCORER_TYPES].sort());
  });

  it('accepts the plan and fixture examples, with defaults filled in', () => {
    const json: ScorerParams<'json_match'> = SCORER_PARAM_SCHEMAS.json_match.parse({
      path: 'duplicates',
      unordered: true,
      inner_unordered: true,
      pass_at: 1.0,
    });
    expect(json.pass_at).toBe(1);
    expect(params('json_match', { path: 'late', exclude_keys: ['note'] }).data).toEqual({
      path: 'late',
      exclude_keys: ['note'],
      pass_at: 1,
    });
    expect(params('numeric_tolerance', { path: 'total_vat', abs: 0.01 }).data).toEqual({
      path: 'total_vat',
      abs: 0.01,
    });
    expect(params('numeric_tolerance', { rel: 0.001 }).success).toBe(true);
    expect(params('exact_match', { path: 'missing_po' }).data).toEqual({
      path: 'missing_po',
      trim: true,
      case_sensitive: true,
    });
    expect(
      params('file_check', {
        path: 'summary.csv',
        must_exist: true,
        format: 'csv',
        columns: ['vendor', 'outstanding'],
        row_count: 5,
      }).success,
    ).toBe(true);
    expect(params('file_check', { path: 'out/report.md', contains: ['Total'] }).data).toEqual({
      path: 'out/report.md',
      must_exist: true,
      contains: ['Total'],
    });
    expect(
      params('file_check', {
        path: 'result.json',
        format: 'json',
        json_schema: { type: 'object', required: ['total'] },
      }).success,
    ).toBe(true);
    expect(
      params('trajectory_match', {
        tool: 'read_file',
        args: { path: 'invoices.csv' },
        min_calls: 1,
      }).success,
    ).toBe(true);
    expect(params('trajectory_match', { tool: 'invoice-db.list_invoices' }).data).toEqual({
      tool: 'invoice-db.list_invoices',
      min_calls: 1,
    });
    expect(
      params('trajectory_match', { tool: 'read_file', min_calls: 1, max_calls: 3, mode: 'subset' })
        .success,
    ).toBe(true);
    expect(
      params('verifier_script', { script: 'check_late_fees.py', timeout_s: 30, pass_at: 1.0 })
        .success,
    ).toBe(true);
    expect(params('verifier_script', { script: 'check.py' }).data).toEqual({
      script: 'check.py',
      timeout_s: 30,
      pass_at: 1,
    });
    expect(params('llm_judge', { rubric: 'credit_method.md', pass_at: 0.7 }).success).toBe(true);
    expect(params('llm_judge', { rubric: 'rubric.md', model: 'openai/gpt-6.1-sol' }).data).toEqual({
      rubric: 'rubric.md',
      pass_at: 0.7,
      model: 'openai/gpt-6.1-sol',
    });
  });

  it('refuses unknown keys for every type', () => {
    const valid: Record<ScorerType, Record<string, unknown>> = {
      numeric_tolerance: {},
      json_match: {},
      exact_match: {},
      file_check: { path: 'a.csv' },
      trajectory_match: { tool: 'read_file' },
      verifier_script: { script: 'check.py' },
      llm_judge: { rubric: 'rubric.md' },
    };
    for (const type of SCORER_TYPES) {
      expect(params(type, valid[type]).success).toBe(true);
      // The misspelling the strict schemas exist for: `tolerance` instead of `abs`.
      expect(params(type, { ...valid[type], tolerance: 0.01 }).success).toBe(false);
    }
  });

  it('refuses bad variants', () => {
    const bad: [ScorerType, unknown][] = [
      ['numeric_tolerance', { abs: -1 }],
      ['numeric_tolerance', { rel: '0.1' }],
      ['numeric_tolerance', { path: '' }],
      ['json_match', { pass_at: 1.5 }],
      ['json_match', { exclude_keys: 'note' }],
      ['json_match', { unordered: 'yes' }],
      ['exact_match', { trim: 'false' }],
      ['file_check', {}],
      ['file_check', { path: '/etc/passwd' }],
      ['file_check', { path: '../outside.csv' }],
      ['file_check', { path: 'a/../../b.csv' }],
      ['file_check', { path: 'a.csv', format: 'xlsx' }],
      ['file_check', { path: 'a.csv', row_count: -1, format: 'csv' }],
      ['file_check', { path: 'a.csv', row_count: 1.5, format: 'csv' }],
      ['file_check', { path: 'a.csv', columns: ['vendor'] }],
      ['file_check', { path: 'a.json', format: 'csv', json_schema: { type: 'object' } }],
      ['file_check', { path: 'a.json', format: 'json', json_schema: ['type'] }],
      ['trajectory_match', {}],
      ['trajectory_match', { tool: 'read_file', min_calls: -1 }],
      ['trajectory_match', { tool: 'read_file', min_calls: 3, max_calls: 2 }],
      ['trajectory_match', { tool: 'read_file', mode: 'exact' }],
      ['verifier_script', {}],
      ['verifier_script', { script: '../check.py' }],
      ['verifier_script', { script: 'check.py', timeout_s: 0 }],
      ['verifier_script', { script: 'check.py', timeout_s: 301 }],
      ['verifier_script', { script: 'check.py', timeout_s: 2.5 }],
      ['verifier_script', { script: 'check.py', pass_at: -0.1 }],
      ['llm_judge', {}],
      ['llm_judge', { rubric: '/rubric.md' }],
      ['llm_judge', { rubric: 'rubric.md', pass_at: 2 }],
      ['llm_judge', { rubric: 'rubric.md', model: '' }],
    ];
    for (const [type, value] of bad) {
      expect(params(type, value).success, `${type} ${JSON.stringify(value)}`).toBe(false);
    }
  });

  it('reports refinement issues on the offending param', () => {
    expect(issuePaths(params('file_check', { path: 'a.csv', columns: ['x'] }))).toEqual([
      'columns',
    ]);
    expect(issuePaths(params('trajectory_match', { tool: 't', max_calls: 0 }))).toEqual([
      'max_calls',
    ]);
  });
});
