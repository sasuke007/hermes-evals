/**
 * Suite authoring's shared rules and the task editor's contracts (plan 4.6;
 * SA.4 to SA.8): the vocabularies migration 0009 checks, the verify/ rule,
 * the answer instructions, the editor's form, readiness, self-check and
 * Try it.
 */
import { describe, expect, it } from 'vitest';
import {
  answerInstructions,
  answerShape,
  appendParagraph,
  AUTHORING_LIMITS,
  DIRECTORY_KEY_MESSAGE,
  DRAFT_FILE_KINDS,
  DRAFT_FILE_VIEW_KINDS,
  DRAFT_ORIGINS,
  DRAFT_TASK_STATES,
  DraftFilePathSchema,
  DraftFileUploadFieldsSchema,
  DraftSelfCheckViewSchema,
  DraftTaskDetailSchema,
  DraftTaskKeySchema,
  generatedTaskKey,
  isVerifyPath,
  READINESS_RULE_LABELS,
  READINESS_RULES,
  suggestedCheckType,
  summariseReadiness,
  summaryFromPrompt,
  suiteVersionZipName,
  TaskFormSchema,
  TaskReadinessSchema,
  TryCheckRequestSchema,
  TryCheckResultSchema,
  UpdateDraftTaskRequestSchema,
  type ReadinessRuleResult,
  type TaskForm,
  type TaskReadiness,
} from '../src/index.js';

const hash = (c: string) => c.repeat(64);
const AT = '2026-10-26T16:31:00.000Z';

/** The loader's check that a prompt asks for the answer block (apps/api task.ts FENCED_JSON). */
const FENCED_JSON = /```\s*json|fenced\s+json/i;

describe('vocabularies (migration 0009 checks them)', () => {
  it('lists the draft task states, file kinds and origins', () => {
    expect(DRAFT_TASK_STATES).toEqual(['added', 'changed', 'removed', 'restored', 'unchanged']);
    expect(DRAFT_FILE_KINDS).toEqual([
      'fixture',
      'expected',
      'expected_home',
      'home_seed',
      'verifier',
      'other',
    ]);
    expect(DRAFT_ORIGINS).toEqual(['edit', 'empty', 'copy', 'zip']);
    expect(DRAFT_FILE_VIEW_KINDS.slice(0, 4)).toEqual([
      'task_yaml',
      'prompt',
      'reference',
      'rubric',
    ]);
  });
});

describe('isVerifyPath (R7: drafts never write code)', () => {
  it.each([
    'verify',
    'verify/check.py',
    './verify/check.py',
    'verify//deep/x.py',
    'Verify/check.py',
    'VERIFY/x',
    'fixtures/../verify/check.py',
    'verify\\check.py',
    '../outside.txt',
  ])('refuses %s', (path) => expect(isVerifyPath(path)).toBe(true));

  it.each([
    'fixtures/verify/x.csv',
    'verifyx/a',
    'fixtures/a.csv',
    'expected/verify.py',
    'rubric.md',
  ])('allows %s', (path) => expect(isVerifyPath(path)).toBe(false));
});

describe('DraftFilePathSchema and the upload fields', () => {
  it('takes a relative path in the task folder', () => {
    expect(DraftFilePathSchema.parse('fixtures/docs/payment-terms.pdf')).toBe(
      'fixtures/docs/payment-terms.pdf',
    );
  });

  it.each([
    'verify/check.py',
    '../x',
    '/etc/passwd',
    'a\\b',
    './x',
    'a/./b',
    'a//b',
    'a/',
    '.env',
    'fixtures/.hidden.csv',
    '',
  ])('refuses %j', (path) => expect(DraftFilePathSchema.safeParse(path).success).toBe(false));

  it('uploads only workspace, expected and home files', () => {
    expect(DraftFileUploadFieldsSchema.parse({ kind: 'fixture' })).toEqual({ kind: 'fixture' });
    expect(DraftFileUploadFieldsSchema.safeParse({ kind: 'verifier' }).success).toBe(false);
    expect(DraftFileUploadFieldsSchema.safeParse({ kind: 'other' }).success).toBe(false);
    expect(
      DraftFileUploadFieldsSchema.safeParse({ kind: 'fixture', path: 'verify/x.py' }).success,
    ).toBe(false);
  });
});

describe('answer instructions (SA.4 Add answer instructions, SA.9 step 3)', () => {
  it('shows the shape with a placeholder of the reference type, never the answer', () => {
    expect(answerShape('total_due', { total_due: 99760.52 })).toBe('{ "total_due": 0.0 }');
    expect(answerShape('overdue_count', { overdue_count: 17 })).toBe('{ "overdue_count": 0 }');
    expect(answerShape('answer', undefined)).toBe('{ "answer": 0 }');
    expect(answerShape('totals.vat', { totals: { vat: 'x' } })).toBe('{ "totals": { "vat": "" } }');
    expect(answerShape('bands[2].net', { bands: [] })).toBe('{ "bands": [{ "net": 0 }] }');
    expect(answerShape(null, { duplicates: [['a', 'b']], note: 'n' })).toBe(
      '{ "duplicates": [], "note": "" }',
    );
    expect(answerShape(null, 4)).toBe('0');
    expect(answerShape('', true)).toBe('false');
  });

  it('writes the paragraph the loader accepts as an answer-block instruction', () => {
    const paragraph = answerInstructions('answer', { answer: 3 });
    expect(paragraph).toBe(
      'End your reply with your answer as a fenced JSON block, exactly in this shape:\n\n```json\n{ "answer": 0 }\n```',
    );
    expect(FENCED_JSON.test(paragraph)).toBe(true);
    expect(appendParagraph('How many?\n\n', paragraph)).toBe(`How many?\n\n${paragraph}\n`);
    expect(appendParagraph('', paragraph)).toBe(`${paragraph}\n`);
  });
});

describe('import and download names', () => {
  it('suggests a check from the reference value (SA.7)', () => {
    expect(suggestedCheckType(17)).toBe('numeric_tolerance');
    expect(suggestedCheckType({ 'Fjord Software': 3 })).toBe('json_match');
    expect(suggestedCheckType([1])).toBe('json_match');
    expect(suggestedCheckType('INV-1042')).toBe('exact_match');
    expect(suggestedCheckType(undefined)).toBeNull();
    expect(suggestedCheckType(null)).toBeNull();
  });

  it('generates keys, summaries and zip names as SA.9 and SA.10 show them', () => {
    expect(generatedTaskKey('overdue_q', 1, 6)).toBe('overdue_q01');
    expect(generatedTaskKey('overdue_q', 7, 120)).toBe('overdue_q007');
    expect(DraftTaskKeySchema.safeParse(generatedTaskKey('overdue_q', 1, 6)).success).toBe(true);
    const long = `How many overdue invoices\n  does ${'a'.repeat(100)}`;
    expect(summaryFromPrompt(long)).toHaveLength(AUTHORING_LIMITS.summaryFromPromptChars);
    expect(summaryFromPrompt(long).startsWith('How many overdue invoices does a')).toBe(true);
    expect(summaryFromPrompt('  Short one.  ')).toBe('Short one.');
    expect(suiteVersionZipName('invoices-v1', 6)).toBe('invoices-v1-v6.zip');
  });

  it('refuses a task key that is not a folder name, in the editor’s words', () => {
    const result = DraftTaskKeySchema.safeParse('overdue 90');
    expect(result.error?.issues[0]?.message).toBe(DIRECTORY_KEY_MESSAGE);
  });
});

const FORM: TaskForm = {
  summary: 'Count invoices past due as of 1 Oct 2026',
  maxTurns: 20,
  runBudgetSeconds: 300,
  toolsetsNeeded: ['file', 'terminal'],
  answerPath: 'overdue_count',
  checks: [{ key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0 } }],
  expectedWorkspace: null,
  expectedHome: null,
  negativeControl: null,
};

describe('the task form and its edits', () => {
  it('keeps out-of-range values, which readiness reports, and refuses unknown keys', () => {
    expect(TaskFormSchema.parse({ ...FORM, maxTurns: 250, runBudgetSeconds: 10 }).maxTurns).toBe(
      250,
    );
    expect(TaskFormSchema.safeParse({ ...FORM, prmary: true }).success).toBe(false);
    const check = { ...FORM.checks[0], prmary: true };
    expect(TaskFormSchema.safeParse({ ...FORM, checks: [check] }).success).toBe(false);
  });

  it('takes the form or task.yaml, never both, and never a rubric under verify/', () => {
    expect(UpdateDraftTaskRequestSchema.parse({ form: FORM, revision: 3 }).revision).toBe(3);
    expect(UpdateDraftTaskRequestSchema.safeParse({ form: FORM, taskYaml: 'x: 1' }).success).toBe(
      false,
    );
    const rubric = (path: string) => ({ rubrics: [{ path, text: 'Grade it.' }] });
    expect(UpdateDraftTaskRequestSchema.safeParse(rubric('rubric.md')).success).toBe(true);
    expect(UpdateDraftTaskRequestSchema.safeParse(rubric('verify/rubric.md')).success).toBe(false);
    expect(
      UpdateDraftTaskRequestSchema.safeParse({
        rubrics: [rubric('a.md').rubrics[0], rubric('a.md').rubrics[0]],
      }).success,
    ).toBe(false);
    expect(UpdateDraftTaskRequestSchema.safeParse({ removed: false }).success).toBe(true);
    expect(UpdateDraftTaskRequestSchema.safeParse({ removed: true }).success).toBe(false);
    expect(UpdateDraftTaskRequestSchema.safeParse({ key: 'overdue by vendor' }).success).toBe(
      false,
    );
  });
});

/** ReadinessPanel's labels, word for word (SA.8, ReadinessPanel LABELS). */
const DESIGN_LABELS = [
  'Key and summary are set',
  '`task.yaml` is valid',
  'At least one check, exactly one primary',
  "Every check's settings are valid",
  'The reference is valid JSON',
  'The reference has a value at every path a check reads',
  'File checks have an expected workspace',
  'The prompt asks for a fenced json block',
  'Every file the prompt mentions is in the workspace',
  'No workspace file contains a reference value',
  'Files are within limits',
  'Self-check',
  "Doing nothing doesn't pass",
];

/** Every rule passed, then `set` applied by rule number (1-based), as the board does. */
function rules(set: Record<number, Partial<ReadinessRuleResult>> = {}): ReadinessRuleResult[] {
  return READINESS_RULES.map((rule, i) => ({
    rule,
    status: 'passed',
    message: '',
    target: null,
    ...set[i + 1],
  }));
}

function readiness(list: ReadinessRuleResult[]): TaskReadiness {
  return {
    ...summariseReadiness(list),
    rules: list,
    issues: [],
    mentionedFiles: [{ name: 'invoices.csv', location: 'workspace' }],
    referenceValues: [{ key: 'answer', path: 'overdue_count', found: true, preview: '17' }],
    needsWorker: false,
    checkedAt: AT,
  };
}

describe('readiness (SA.8)', () => {
  it('has the 13 rules of the panel, labelled as the board labels them', () => {
    expect(READINESS_RULES).toHaveLength(13);
    expect(READINESS_RULES.map((r) => READINESS_RULE_LABELS[r])).toEqual(DESIGN_LABELS);
  });

  it('sums the rows up as the panel heading and the task table do', () => {
    const fix = (status: ReadinessRuleResult['status']) => ({ status, message: 'x' });
    const problems = rules({ 6: fix('problem'), 8: fix('warning'), 9: fix('warning') });
    expect(summariseReadiness(problems)).toEqual({
      summary: 'problems',
      counts: { problems: 1, warnings: 2, pending: 0 },
    });
    expect(summariseReadiness(rules({ 8: fix('warning') })).summary).toBe('warnings');
    expect(summariseReadiness(rules({ 12: fix('pending'), 13: fix('pending') })).summary).toBe(
      'not_run',
    );
    expect(summariseReadiness(rules()).summary).toBe('ready');
  });

  it('parses the problems state, with a Fix target per failing row', () => {
    const state = readiness(
      rules({
        6: {
          status: 'problem',
          message: 'No value at `overdue` (check `answer`).',
          target: { section: 'answer', field: 'answerPath' },
        },
        10: {
          status: 'warning',
          message:
            '`fixtures/notes.txt` contains `99760.52`, the reference value at `total_due`. The agent could read the answer.',
          target: { section: 'workspace', field: 'fixtures/notes.txt' },
        },
      }),
    );
    expect(TaskReadinessSchema.parse(state).counts).toEqual({
      problems: 1,
      warnings: 1,
      pending: 0,
    });
  });

  it('refuses rows out of order, a missing row, or a summary the rows do not give', () => {
    const list = rules();
    expect(TaskReadinessSchema.safeParse(readiness([...list].reverse())).success).toBe(false);
    expect(TaskReadinessSchema.safeParse(readiness(list.slice(1))).success).toBe(false);
    expect(TaskReadinessSchema.safeParse({ ...readiness(list), summary: 'problems' }).success).toBe(
      false,
    );
  });
});

const DETAIL = {
  draft: {
    id: 'draft-1',
    folder: 'invoices-v1',
    path: './suites/invoices-v1',
    name: 'invoices-v1',
    baseVersion: 6,
    nextVersion: 7,
  },
  key: 'overdue_count',
  position: 2,
  state: 'added',
  base: null,
  restoredFrom: null,
  taskYaml: 'summary: Count invoices past due as of 1 Oct 2026\n',
  prompt: 'How many invoices are overdue?\n',
  reference: '{ "overdue_count": 17 }\n',
  rubrics: [],
  form: FORM,
  formLock: null,
  files: [
    {
      path: 'fixtures/invoices.csv',
      kind: 'fixture',
      visibility: 'agent',
      agentPath: '/workspace/invoices.csv',
      sizeBytes: 4403,
      sha256: hash('c'),
      typeLabel: 'CSV · 48 rows · 8 columns',
    },
  ],
  readiness: readiness(rules()),
  selfCheck: null,
  revision: 4,
  updatedAt: AT,
};

describe('the draft task (SA.4, SA.6)', () => {
  it('parses an editable task and a locked one', () => {
    expect(DraftTaskDetailSchema.parse(DETAIL).files[0]?.agentPath).toBe('/workspace/invoices.csv');
    const locked = {
      ...DETAIL,
      form: null,
      formLock: { line: 9, column: 7, message: 'unknown key `prmary`. Did you mean `primary`?' },
    };
    expect(DraftTaskDetailSchema.parse(locked).formLock?.line).toBe(9);
    expect(DraftTaskDetailSchema.safeParse({ ...DETAIL, form: null }).success).toBe(false);
    expect(DraftTaskDetailSchema.safeParse({ ...locked, form: FORM }).success).toBe(false);
  });

  it('carries a worker self-check with its transcript, marked out of date after an edit', () => {
    const selfCheck = DraftSelfCheckViewSchema.parse({
      status: 'error',
      ranAt: AT,
      durationMs: 200,
      contentHash: hash('a'),
      current: false,
      results: [
        {
          key: 'totals',
          type: 'verifier_script',
          mode: 'workspace',
          expect: 'pass',
          status: 'error',
          score: null,
          comment: 'verifier check_summary.py exited with code 1',
          transcript:
            "$ python3 verify/check_summary.py --answer answer.json --workspace /tmp/selfcheck-3/expected\nKeyError: 'totals'\nexit status 1 · no result line · 0.2 s",
        },
      ],
    });
    expect(DraftTaskDetailSchema.parse({ ...DETAIL, selfCheck }).selfCheck?.current).toBe(false);
  });
});

describe('Try it (SA.7)', () => {
  it('tries the reference, or a pasted reply', () => {
    expect(TryCheckRequestSchema.parse({ key: 'answer', reply: null }).reply).toBeNull();
    expect(TryCheckRequestSchema.safeParse({ key: 'answer' }).success).toBe(false);
  });

  it('reports the block, the value at the path and the score', () => {
    const passed = TryCheckResultSchema.parse({
      key: 'answer',
      type: 'json_match',
      against: 'reply',
      extraction: { status: 'found', block: '{ "overdue_by_vendor": {} }', error: null },
      path: 'overdue_by_vendor',
      value: '{"Fjord Software":3}',
      status: 'passed',
      score: 0.8,
      comment: '4 of 5 keys match',
      passAt: 0.8,
      expected: { 'Fjord Software': 3 },
      observed: { 'Fjord Software': 3 },
      evidence: {
        json_match: { unit: 'keys', matched: 4, total: 5, mismatches: ['Granite Office'] },
      },
    });
    expect(passed.evidence?.json_match?.matched).toBe(4);
    const ungradable = TryCheckResultSchema.parse({
      ...passed,
      extraction: { status: 'missing', block: null, error: null },
      value: null,
      status: 'ungradable',
      score: null,
      comment: 'No fenced json block found in the reply',
      passAt: null,
      expected: undefined,
      observed: undefined,
      evidence: null,
    });
    expect(ungradable.observed).toBeUndefined();
  });
});
