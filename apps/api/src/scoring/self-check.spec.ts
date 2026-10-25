import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfCheckResultSchema } from '@hermes-evals/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  runSelfChecks,
  selfCheckStatus,
  type SelfCheckInput,
  type SelfCheckResult,
} from './self-check.js';

const PRELUDE = `import argparse, csv, json, os
parser = argparse.ArgumentParser()
parser.add_argument("--answer", required=True)
parser.add_argument("--workspace", required=True)
args = parser.parse_args()
`;

describe('runSelfChecks', () => {
  let root: string;
  let base: Omit<SelfCheckInput, 'entries'>;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'self-check-'));
    const fixtures = join(root, 'fixtures');
    const expected = join(root, 'expected-workspace');
    const verify = join(root, 'verify');
    mkdirSync(fixtures);
    mkdirSync(verify);
    writeFileSync(join(fixtures, 'invoices.csv'), 'vendor,amount\nACME,1\nGlobex,2\n');
    cpSync(fixtures, expected, { recursive: true });
    writeFileSync(join(expected, 'summary.csv'), 'vendor,outstanding\nACME,1\nGlobex,2\n');
    writeFileSync(
      join(verify, 'check_summary.py'),
      `${PRELUDE}rows = list(csv.DictReader(open(os.path.join(args.workspace, "summary.csv"))))\n` +
        'print(json.dumps({"score": 1 if len(rows) == 2 else 0, "comment": f"{len(rows)} rows"}))\n',
    );
    writeFileSync(
      join(verify, 'check_answer.py'),
      `${PRELUDE}answer = json.load(open(args.answer))\n` +
        'print(json.dumps({"score": 1 if answer["total"] == 3 else 0}))\n',
    );
    writeFileSync(join(verify, 'always_pass.py'), `${PRELUDE}print(json.dumps({"score": 1}))\n`);
    base = {
      reference: { total: 3, vendors: ['ACME', 'Globex'] },
      fixturesDir: fixtures,
      expectedWorkspaceDir: expected,
      negativeControl: true,
      verifyDir: verify,
      scratch: async (prefix) => {
        const path = mkdtempSync(join(root, `${prefix}-`));
        return { path, dispose: () => rm(path, { recursive: true, force: true }) };
      },
    };
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const shape = (results: SelfCheckResult[]) => {
    for (const r of results) expect(SelfCheckResultSchema.safeParse(r).success).toBe(true);
    return results.map((r) => [r.key, r.mode, r.expect ?? null, r.status]);
  };

  it('checks answer keys against the reference and verifiers with it', async () => {
    const results = await runSelfChecks({
      ...base,
      expectedWorkspaceDir: null,
      negativeControl: false,
      entries: [
        { key: 'answer', type: 'numeric_tolerance', params: { path: 'total', abs: 0.01 } },
        { key: 'vendors', type: 'json_match', params: { path: 'vendors', unordered: true } },
        { key: 'check', type: 'verifier_script', params: { script: 'check_answer.py' } },
        { key: 'reads', type: 'trajectory_match', params: { tool: 'read_file' } },
        { key: 'method', type: 'llm_judge', params: { rubric: 'rubric.md' } },
      ],
    });
    expect(shape(results)).toEqual([
      ['answer', 'answer', null, 'passed'],
      ['vendors', 'answer', null, 'passed'],
      ['check', 'script', null, 'passed'],
      ['reads', 'none', null, 'skipped'],
      ['method', 'none', null, 'skipped'],
    ]);
    expect(results[2]).toMatchObject({ exit_code: 0, timed_out: false, score: 1 });
    expect(results[2]!.argv).toContain('--answer');
    expect(selfCheckStatus(results)).toBe('passed');
  });

  it('checks text_match against the reference: it must hold the phrases and the pattern', async () => {
    const results = await runSelfChecks({
      ...base,
      reference: {
        rule: 'Invoices unpaid 30 days after the due date are charged a late fee of 1.5% per month.',
      },
      expectedWorkspaceDir: null,
      negativeControl: false,
      entries: [
        {
          key: 'answer',
          type: 'text_match',
          params: { path: 'rule', contains: ['1.5%', '30 DAYS'] },
        },
        { key: 'pattern', type: 'text_match', params: { path: 'rule', pattern: '\\d+ days' } },
        { key: 'monthly', type: 'text_match', params: { path: 'rule', contains: ['monthly'] } },
        { key: 'elsewhere', type: 'text_match', params: { path: 'fee', contains: ['1.5%'] } },
        { key: 'broken', type: 'text_match', params: { path: 'rule', pattern: '(per' } },
      ],
    });
    expect(shape(results)).toEqual([
      ['answer', 'answer', null, 'passed'],
      ['pattern', 'answer', null, 'passed'],
      ['monthly', 'answer', null, 'failed'],
      ['elsewhere', 'answer', null, 'error'],
      ['broken', 'answer', null, 'error'],
    ]);
    expect(results[0]).toMatchObject({ score: 1, comment: 'found 2 of 2: "1.5%" ✓ "30 DAYS" ✓' });
    expect(results[2]).toMatchObject({ score: 0, comment: 'found 0 of 1: "monthly" ✗' });
    expect(results[3]!.comment).toBe('the reference has no value at fee');
    expect(results[4]!.comment).toBe('The pattern is not valid: unterminated group.');
    expect(selfCheckStatus(results)).toBe('error');
  });

  it('runs file checks on the expected workspace, then a negative control on the fixtures', async () => {
    const results = await runSelfChecks({
      ...base,
      entries: [
        {
          key: 'file',
          type: 'file_check',
          params: { path: 'summary.csv', format: 'csv', row_count: 2 },
        },
        { key: 'check', type: 'verifier_script', params: { script: 'check_summary.py' } },
      ],
    });
    expect(shape(results)).toEqual([
      ['file', 'workspace', 'pass', 'passed'],
      ['file', 'workspace', 'fail', 'failed'],
      ['check', 'workspace', 'pass', 'passed'],
      // The script crashes on the bare fixtures (no summary.csv): not a pass, as required.
      ['check', 'workspace', 'fail', 'error'],
    ]);
    expect(results[1]!.comment).toBe('negative control: summary.csv does not exist');
    expect(selfCheckStatus(results)).toBe('passed');
  });

  it('fails a task whose verifier passes the untouched fixtures', async () => {
    const results = await runSelfChecks({
      ...base,
      entries: [{ key: 'check', type: 'verifier_script', params: { script: 'always_pass.py' } }],
    });
    expect(shape(results)).toEqual([
      ['check', 'workspace', 'pass', 'passed'],
      ['check', 'workspace', 'fail', 'passed'],
    ]);
    expect(results[1]!.comment).toMatch(/would pass any agent/);
    expect(selfCheckStatus(results)).toBe('failed');
  });

  it('skips the negative control when the task turns it off', async () => {
    const results = await runSelfChecks({
      ...base,
      negativeControl: false,
      entries: [{ key: 'check', type: 'verifier_script', params: { script: 'always_pass.py' } }],
    });
    expect(shape(results)).toEqual([['check', 'workspace', 'pass', 'passed']]);
  });

  it('errors on a file check with no expected workspace and on invalid params', async () => {
    const results = await runSelfChecks({
      ...base,
      expectedWorkspaceDir: null,
      entries: [
        { key: 'file', type: 'file_check', params: { path: 'summary.csv' } },
        { key: 'answer', type: 'numeric_tolerance', params: { path: 'total', abs: '0.01' } },
        { key: 'wrong', type: 'exact_match', params: { path: 'total' } },
      ],
    });
    expect(shape(results)).toEqual([
      ['file', 'workspace', null, 'error'],
      ['answer', 'answer', null, 'error'],
      // exact_match compares "3" with "3": passes, as the reference is its own answer.
      ['wrong', 'answer', null, 'passed'],
    ]);
    expect(results[1]!.comment).toMatch(/^invalid params: /);
    expect(selfCheckStatus(results)).toBe('error');
  });
});

describe('selfCheckStatus', () => {
  const r = (status: SelfCheckResult['status'], expect?: 'pass' | 'fail'): SelfCheckResult => ({
    key: 'k',
    type: 'file_check',
    mode: 'workspace',
    ...(expect ? { expect } : {}),
    status,
    score: null,
    comment: '',
  });

  it('ranks error over failed over passed and ignores skipped checks', () => {
    expect(selfCheckStatus([])).toBe('passed');
    expect(selfCheckStatus([r('skipped')])).toBe('passed');
    expect(selfCheckStatus([r('passed'), r('ungradable')])).toBe('failed');
    expect(selfCheckStatus([r('failed'), r('error')])).toBe('error');
    expect(selfCheckStatus([r('passed', 'pass'), r('failed', 'fail')])).toBe('passed');
    expect(selfCheckStatus([r('passed', 'pass'), r('error', 'fail')])).toBe('passed');
    expect(selfCheckStatus([r('passed', 'pass'), r('passed', 'fail')])).toBe('failed');
  });
});
