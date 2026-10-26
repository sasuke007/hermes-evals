import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SelfCheckResultSchema } from '@hermes-evals/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { KEY_SETUP_SECONDS } from './scoring-time.js';
import {
  runSelfChecks,
  selfCheckSeconds,
  selfCheckStatus,
  type SelfCheckInput,
  type SelfCheckResult,
} from './self-check.js';

const PRELUDE = `import argparse, csv, json, os
parser = argparse.ArgumentParser()
parser.add_argument("--answer", required=True)
parser.add_argument("--workspace", required=True)
parser.add_argument("--home", required=True)
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
    const home = join(root, 'home');
    mkdirSync(fixtures);
    mkdirSync(verify);
    mkdirSync(home);
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
      homeDir: home,
      expectedHomeDir: null,
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

describe('runSelfChecks on the home (Phase 6 P2)', () => {
  let root: string;
  let base: Omit<SelfCheckInput, 'entries'>;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'self-check-home-'));
    const fixtures = join(root, 'fixtures');
    const verify = join(root, 'verify');
    const seeds = join(root, 'home');
    const expectedHome = join(root, 'expected-home');
    mkdirSync(fixtures);
    mkdirSync(verify);
    mkdirSync(join(seeds, 'memories'), { recursive: true });
    mkdirSync(join(expectedHome, 'memories'), { recursive: true });
    writeFileSync(join(fixtures, 'invoices.csv'), 'vendor,amount\nACME,1\n');
    writeFileSync(join(seeds, 'memories', 'USER.md'), 'Works in Lisbon.');
    writeFileSync(
      join(expectedHome, 'memories', 'USER.md'),
      'Works in Lisbon.\n§\nReports in EUR.',
    );
    writeFileSync(
      join(verify, 'remembers.py'),
      `${PRELUDE}path = os.path.join(args.home, "memories", "USER.md")\n` +
        'text = open(path).read() if os.path.exists(path) else ""\n' +
        'seen = sorted(os.listdir(args.workspace))\n' +
        'print(json.dumps({"score": 1 if "EUR" in text else 0, "comment": f"workspace {seen}"}))\n',
    );
    base = {
      reference: { saved: true },
      fixturesDir: fixtures,
      expectedWorkspaceDir: null,
      homeDir: seeds,
      expectedHomeDir: expectedHome,
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
  const memoryCheck = {
    key: 'memory',
    type: 'file_check' as const,
    params: { root: 'home', path: 'memories/USER.md', contains: ['EUR'] },
  };
  const verifier = {
    key: 'saved',
    type: 'verifier_script' as const,
    params: { script: 'remembers.py' },
  };

  it('passes a home check on the expected home and fails it on the seeds alone', async () => {
    const results = await runSelfChecks({ ...base, entries: [memoryCheck, verifier] });
    expect(shape(results)).toEqual([
      ['memory', 'home', 'pass', 'passed'],
      ['memory', 'home', 'fail', 'failed'],
      ['saved', 'home', 'pass', 'passed'],
      ['saved', 'home', 'fail', 'failed'],
    ]);
    expect(results[1]!.comment).toBe('negative control: memories/USER.md: does not contain "EUR"');
    // The verifier's workspace is the untouched fixtures in both runs: the task has no expected workspace.
    expect(results[2]!.comment).toBe("workspace ['invoices.csv'] (score 1, pass at 1)");
    expect(results[2]!.argv?.slice(-2)).toEqual(['--home', base.expectedHomeDir]);
    expect(results[3]!.argv?.slice(-2)).toEqual(['--home', base.homeDir]);
    expect(selfCheckStatus(results)).toBe('passed');
  });

  it('fails a home check that already passes on the seeds, naming them', async () => {
    const results = await runSelfChecks({
      ...base,
      entries: [{ ...memoryCheck, params: { ...memoryCheck.params, contains: ['Lisbon'] } }],
    });
    expect(shape(results)).toEqual([
      ['memory', 'home', 'pass', 'passed'],
      ['memory', 'home', 'fail', 'passed'],
    ]);
    expect(results[1]!.comment).toMatch(
      /^the negative control passed on the home seeds alone, so this check would pass any agent/,
    );
    expect(selfCheckStatus(results)).toBe('failed');
  });

  it('gives a verifier both known-good folders when the task declares both', async () => {
    const expectedWorkspace = join(root, 'expected-workspace');
    mkdirSync(expectedWorkspace, { recursive: true });
    writeFileSync(join(expectedWorkspace, 'summary.csv'), 'vendor\nACME\n');
    const results = await runSelfChecks({
      ...base,
      expectedWorkspaceDir: expectedWorkspace,
      entries: [verifier],
    });
    expect(shape(results)).toEqual([
      ['saved', 'workspace', 'pass', 'passed'],
      ['saved', 'workspace', 'fail', 'failed'],
    ]);
    expect(results[0]!.argv?.slice(-4)).toEqual([
      '--workspace',
      expectedWorkspace,
      '--home',
      base.expectedHomeDir,
    ]);
    expect(results[1]!.argv?.slice(-4)).toEqual([
      '--workspace',
      base.fixturesDir,
      '--home',
      base.homeDir,
    ]);
  });

  it('gives an answer-based verifier the seeds as its home', async () => {
    const results = await runSelfChecks({ ...base, expectedHomeDir: null, entries: [verifier] });
    expect(shape(results)).toEqual([['saved', 'script', null, 'failed']]);
    expect(results[0]!.argv?.slice(-2)).toEqual(['--home', base.homeDir]);
  });

  it('errors on a home file check with no expected home', async () => {
    const results = await runSelfChecks({ ...base, expectedHomeDir: null, entries: [memoryCheck] });
    expect(shape(results)).toEqual([['memory', 'home', null, 'error']]);
    expect(results[0]!.comment).toMatch(/needs self_check.expected_home/);
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

describe('selfCheckSeconds', () => {
  const verifier = (key: string, timeout_s?: number) => ({
    key,
    type: 'verifier_script' as const,
    params: { script: `${key}.py`, ...(timeout_s === undefined ? {} : { timeout_s }) },
  });
  const fileCheck = { key: 'out', type: 'file_check' as const, params: { path: 'out.csv' } };
  const answer = { key: 'total', type: 'numeric_tolerance' as const, params: { path: 'total' } };
  const judge = { key: 'judge', type: 'llm_judge' as const, params: { rubric: 'rubric.md' } };

  it("counts each verifier's timeout_s and the setup, once without an expected workspace", () => {
    expect(
      selfCheckSeconds({
        entries: [answer, judge, verifier('a', 300), verifier('b')],
        expectedWorkspace: false,
        expectedHome: false,
        negativeControl: false,
      }),
    ).toBe(300 + KEY_SETUP_SECONDS + 30 + KEY_SETUP_SECONDS);
  });

  it('counts the workspace checks twice with a negative control, and once without', () => {
    const task = {
      entries: [verifier('a', 100), fileCheck],
      expectedWorkspace: true,
      expectedHome: false,
    };
    const once = 100 + KEY_SETUP_SECONDS + KEY_SETUP_SECONDS;
    expect(selfCheckSeconds({ ...task, negativeControl: true })).toBe(2 * once);
    expect(selfCheckSeconds({ ...task, negativeControl: false })).toBe(once);
  });

  it('counts the home checks the same way: twice with their negative control', () => {
    const memory = {
      key: 'memory',
      type: 'file_check' as const,
      params: { root: 'home', path: 'memories/USER.md' },
    };
    const task = { entries: [verifier('a', 100), memory], expectedWorkspace: false };
    const once = 100 + KEY_SETUP_SECONDS + KEY_SETUP_SECONDS;
    expect(selfCheckSeconds({ ...task, expectedHome: true, negativeControl: true })).toBe(2 * once);
    // Without an expected home the verifier is answer-based: one run.
    expect(selfCheckSeconds({ ...task, expectedHome: false, negativeControl: true })).toBe(
      100 + KEY_SETUP_SECONDS + 2 * KEY_SETUP_SECONDS,
    );
  });

  it('counts nothing for checks that run no file, nor for params that do not parse', () => {
    expect(
      selfCheckSeconds({
        entries: [answer, judge, { key: 'bad', type: 'verifier_script', params: { timeout_s: 0 } }],
        expectedWorkspace: true,
        expectedHome: false,
        negativeControl: true,
      }),
    ).toBe(0);
  });
});
