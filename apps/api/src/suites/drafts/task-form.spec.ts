import { describe, expect, it } from 'vitest';
import { TaskFormSchema } from '@hermes-evals/shared';
import { applyForm, BLANK_FORM, FormLockedError, formOf, newTaskYaml } from './task-form.js';

/** A hand-written task.yaml: comments, a flow map, a block map, an explicit `primary: false`. */
const SUMMARY_FILE = `# Written by hand; the form must keep this.
summary: Write summary.csv with one row per vendor
limits:
  max_turns: 20
  run_budget_seconds: 300 # five minutes
  toolsets_needed: [file, terminal]
answer:
  format: fenced_json
verification:
  - key: summary_csv
    type: file_check
    primary: true
    params:
      path: summary.csv
      format: csv
      columns: [vendor, unpaid_invoices, outstanding]
      row_count: 8
  - key: totals
    type: verifier_script
    primary: false
    params: { script: check_summary.py, timeout_s: 30 }
self_check:
  expected_workspace: expected
  negative_control: true
`;

const formOfText = (text: string) => {
  const read = formOf(text);
  if (read.form === null) throw new Error(read.lock.message);
  return TaskFormSchema.parse(read.form);
};

describe('formOf', () => {
  it('reads task.yaml into the form fields', () => {
    expect(formOfText(SUMMARY_FILE)).toEqual({
      summary: 'Write summary.csv with one row per vendor',
      maxTurns: 20,
      runBudgetSeconds: 300,
      toolsetsNeeded: ['file', 'terminal'],
      answerPath: null,
      checks: [
        {
          key: 'summary_csv',
          type: 'file_check',
          primary: true,
          params: {
            path: 'summary.csv',
            format: 'csv',
            columns: ['vendor', 'unpaid_invoices', 'outstanding'],
            row_count: 8,
          },
        },
        {
          key: 'totals',
          type: 'verifier_script',
          primary: false,
          params: { script: 'check_summary.py', timeout_s: 30 },
        },
      ],
      expectedWorkspace: 'expected',
      expectedHome: null,
      negativeControl: true,
    });
  });

  it('shows values the rules refuse, without locking', () => {
    const form = formOfText(SUMMARY_FILE.replace('max_turns: 20', 'max_turns: 250'));
    expect(form.maxTurns).toBe(250);
  });

  it('locks on an unknown key, located, with the key it may mean', () => {
    const read = formOf(SUMMARY_FILE.replace('    primary: false', '    prmary: false'));
    expect(read.form).toBeNull();
    expect(read.lock).toEqual({
      line: 20,
      column: 5,
      message: 'unknown key `prmary`. Did you mean `primary`?',
    });
  });

  it('locks on a second primary check, at its line', () => {
    const read = formOf(SUMMARY_FILE.replace('primary: false', 'primary: true'));
    expect(read.lock).toMatchObject({
      line: 20,
      message: 'a second check is marked primary. Mark exactly one check as primary.',
    });
  });

  it('locks on a value no field can hold, and on YAML that does not parse', () => {
    expect(formOf(SUMMARY_FILE.replace('max_turns: 20', 'max_turns: [20]')).lock?.message).toBe(
      'max_turns must be a whole number.',
    );
    expect(formOf('summary: [unclosed\n').lock?.line).toBe(2);
  });
});

describe('applyForm', () => {
  it('writes nothing when nothing changed', () => {
    expect(applyForm(SUMMARY_FILE, formOfText(SUMMARY_FILE))).toBe(SUMMARY_FILE);
  });

  it('changes one field and keeps every comment and the key order', () => {
    const form = { ...formOfText(SUMMARY_FILE), runBudgetSeconds: 600 };
    expect(applyForm(SUMMARY_FILE, form)).toBe(
      SUMMARY_FILE.replace('run_budget_seconds: 300 #', 'run_budget_seconds: 600 #'),
    );
  });

  it('edits one param of one check', () => {
    const form = formOfText(SUMMARY_FILE);
    form.checks[0]!.params.row_count = 9;
    form.checks[1]!.params.timeout_s = 60;
    const out = applyForm(SUMMARY_FILE, form);
    expect(out).toBe(
      SUMMARY_FILE.replace('row_count: 8', 'row_count: 9').replace(
        'timeout_s: 30 }',
        'timeout_s: 60 }',
      ),
    );
  });

  it('adds a check without writing primary: false, and clears the answer path', () => {
    const text = SUMMARY_FILE.replace(
      '  format: fenced_json\n',
      '  format: fenced_json\n  path: rows\n',
    );
    const form = formOfText(text);
    form.answerPath = null;
    form.checks.push({
      key: 'reads',
      type: 'trajectory_match',
      primary: false,
      params: { tool: 'read_file' },
    });
    const out = applyForm(text, form);
    expect(out).toContain('answer:\n  format: fenced_json\nverification:');
    expect(out).toContain(
      '    params: { script: check_summary.py, timeout_s: 30 }\n  - key: reads\n    type: trajectory_match\n    params: { tool: read_file }\nself_check:',
    );
    expect(formOfText(out)).toEqual(form);
  });

  it('turns the negative control off and removes the expected workspace', () => {
    const form = { ...formOfText(SUMMARY_FILE), expectedWorkspace: null, negativeControl: null };
    expect(
      applyForm(SUMMARY_FILE, form).endsWith(
        '    params: { script: check_summary.py, timeout_s: 30 }\n',
      ),
    ).toBe(true);
  });

  it("writes a blank task's first summary plain, and keeps quotes the author chose", () => {
    const blank = newTaskYaml(BLANK_FORM);
    const named = applyForm(blank, { ...BLANK_FORM, summary: 'Sum the amounts' });
    expect(named).toBe(blank.replace("summary: ''", 'summary: Sum the amounts'));
    const quoted = "summary: 'Sum the amounts'\n";
    expect(applyForm(quoted, { ...formOfText(quoted), summary: 'Sum the amount column' })).toBe(
      "summary: 'Sum the amount column'\n",
    );
  });

  it("writes a blank task's first checks as a new task.yaml would, in block style", () => {
    const form = {
      ...BLANK_FORM,
      summary: 'Total of the unpaid invoices',
      answerPath: 'unpaid_total',
      checks: [
        { key: 'answer', type: 'numeric_tolerance' as const, primary: true, params: { abs: 0.01 } },
      ],
    };
    const out = applyForm(newTaskYaml(BLANK_FORM), form);
    expect(out).toBe(newTaskYaml(form));
    expect(out).toContain(
      'verification:\n  - key: answer\n    type: numeric_tolerance\n    primary: true\n    params: { abs: 0.01 }\n',
    );
  });

  it('refuses a form while task.yaml locks it', () => {
    expect(() => applyForm('summary: x\nprmary: 1\n', BLANK_FORM)).toThrow(FormLockedError);
  });
});

describe('newTaskYaml', () => {
  it('writes a blank task in the canonical style', () => {
    expect(newTaskYaml(BLANK_FORM)).toBe(`summary: ''
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file, terminal]
answer:
  format: fenced_json
verification: []
`);
  });
});
