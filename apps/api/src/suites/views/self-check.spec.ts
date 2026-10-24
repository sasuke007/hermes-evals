import { describe, expect, it } from 'vitest';
import {
  SelfCheckFailureViewSchema,
  TaskSelfCheckViewSchema,
  type SelfCheck,
  type VerificationEntry,
} from '@hermes-evals/shared';
import { selfCheckView, type SelfCheckResult } from './self-check.js';
import { selfCheckFailureView, type FailureInput } from './self-check-failure.js';

const RAN_AT = '2026-10-23T15:41:07.000Z';
const V1_RAN_AT = '2026-10-23T09:12:04.000Z';

const LATE_FEES: VerificationEntry[] = [
  {
    key: 'answer',
    type: 'numeric_tolerance',
    primary: true,
    params: { path: 'late_fees_total', abs: 0.01 },
  },
  {
    key: 'check',
    type: 'verifier_script',
    primary: false,
    params: { script: 'check_late_fees.py', timeout_s: 30, pass_at: 1.0 },
  },
];

const ANSWER_PASSED: SelfCheckResult = {
  key: 'answer',
  type: 'numeric_tolerance',
  mode: 'answer',
  status: 'passed',
  score: 1,
  comment: 'within 0.01',
};

const TRACEBACK = `Traceback (most recent call last):
  File "verify/check_late_fees.py", line 31, in <module>
    rate = policy["late_fee_rate"]
KeyError: 'late_fee_rate'
`;

const scriptRun = (over: Partial<SelfCheckResult> = {}): SelfCheckResult => ({
  key: 'check',
  type: 'verifier_script',
  mode: 'script',
  status: 'error',
  score: null,
  comment: 'no result line on stdout',
  duration_ms: 300,
  argv: [
    'python3',
    'verify/check_late_fees.py',
    '--answer',
    'reference.json',
    '--workspace',
    'fixtures/',
  ],
  exit_code: 1,
  timed_out: false,
  stdout_tail: '',
  stderr_tail: TRACEBACK,
  ...over,
});

const check = (status: SelfCheck['status'], results: SelfCheckResult[]): SelfCheck => ({
  status,
  ran_at: RAN_AT,
  duration_ms: 320,
  results,
});

const failureInput = (over: Partial<FailureInput> = {}): FailureInput => ({
  sourcePath: 'invoices-v1',
  taskKey: 'late_fees',
  valid: false,
  invalidReason: 'verifier_script check_late_fees.py printed no result line',
  verification: LATE_FEES,
  selfCheck: check('error', [ANSWER_PASSED, scriptRun()]),
  loadIssues: [],
  loadedAt: RAN_AT,
  previous: {
    selfCheck: {
      ...check('passed', [
        ANSWER_PASSED,
        scriptRun({
          status: 'passed',
          score: 1,
          stdout_tail: '{"key": "check", "score": 1}',
          exit_code: 0,
          stderr_tail: '',
        }),
      ]),
      ran_at: V1_RAN_AT,
    },
    verification: LATE_FEES,
    ranAt: '2026-10-21T15:31:12.000Z',
  },
  changedSincePrevious: ['fixtures/policy_terms.json'],
  ...over,
});

describe('selfCheckView', () => {
  it('shows one row per entry with the fixture notes', () => {
    const verification: VerificationEntry[] = [
      { key: 'answer', type: 'json_match', primary: true, params: { path: 'duplicates' } },
      {
        key: 'reads_fixture',
        type: 'trajectory_match',
        primary: false,
        params: { tool: 'read_file' },
      },
      { key: 'method', type: 'llm_judge', primary: false, params: { rubric: 'r.md' } },
    ];
    const stored = check('passed', [
      {
        key: 'answer',
        type: 'json_match',
        mode: 'answer',
        status: 'passed',
        score: 1,
        comment: 'match',
      },
      {
        key: 'reads_fixture',
        type: 'trajectory_match',
        mode: 'none',
        status: 'skipped',
        score: null,
        comment: 'schema only',
      },
      {
        key: 'method',
        type: 'llm_judge',
        mode: 'none',
        status: 'skipped',
        score: null,
        comment: 'schema only',
      },
    ]);
    const view = selfCheckView(stored, verification, '2026-10-21T15:31:12.000Z');
    expect(TaskSelfCheckViewSchema.parse(view)).toEqual(view);
    expect(view).toEqual({
      status: 'passed',
      ranAt: RAN_AT,
      trigger: 'suite reload',
      results: [
        {
          key: 'answer',
          type: 'json_match',
          status: 'passed',
          score: 1,
          note: 'scored against the reference answer',
        },
        {
          key: 'reads_fixture',
          type: 'trajectory_match',
          status: 'skipped',
          score: null,
          note: 'definition valid · needs a trajectory, so it is not scored against the reference',
        },
        {
          key: 'method',
          type: 'llm_judge',
          status: 'skipped',
          score: null,
          note: 'definition valid · never called at load',
        },
      ],
    });
  });

  it('folds a negative control into its entry', () => {
    const entry: VerificationEntry = {
      key: 'summary',
      type: 'file_check',
      primary: true,
      params: { path: 'summary.csv', format: 'csv', columns: ['vendor'] },
    };
    const run: SelfCheckResult = {
      key: 'summary',
      type: 'file_check',
      mode: 'workspace',
      status: 'passed',
      score: 1,
      comment: 'ok',
    };
    const good = selfCheckView(
      check('passed', [
        run,
        { ...run, expect: 'fail', status: 'failed', score: 0, comment: 'summary.csv is missing' },
      ]),
      [entry],
      RAN_AT,
    );
    expect(good.results).toEqual([
      {
        key: 'summary',
        type: 'file_check',
        status: 'passed',
        score: 1,
        note: 'passes on the expected workspace; fails on the untouched fixtures, as it should',
      },
    ]);
    const bad = selfCheckView(check('failed', [run, { ...run, expect: 'fail' }]), [entry], RAN_AT);
    expect(bad.results[0]).toMatchObject({
      status: 'failed',
      note: 'passes on the untouched fixtures too, so it would pass any agent',
    });
  });

  it('marks entries of a task with load errors as not run, and dates them by the load', () => {
    const view = selfCheckView(
      { status: 'skipped', ran_at: null, duration_ms: null, results: [] },
      LATE_FEES,
      RAN_AT,
    );
    expect(view.ranAt).toBe(RAN_AT);
    expect(view.results.map((r) => [r.status, r.note])).toEqual([
      ['skipped', 'not run: the task has load errors'],
      ['skipped', 'not run: the task has load errors'],
    ]);
  });
});

describe('selfCheckFailureView', () => {
  it('reads like the design for a verifier that printed no result line', () => {
    const view = selfCheckFailureView(failureInput());
    expect(SelfCheckFailureViewSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      key: 'check',
      type: 'verifier_script',
      title:
        'verifier_script check_late_fees.py printed no result line on the reference answer · score status error',
      status: 'error',
      ranAt: RAN_AT,
      durationMs: 300,
      previousRun: { at: V1_RAN_AT, status: 'passed' },
    });
    expect(view?.transcript)
      .toBe(`$ python3 verify/check_late_fees.py --answer reference.json --workspace fixtures/
${TRACEBACK.trimEnd()}
exit code 1
expected on stdout: one JSON line {"key": "check", "score": …, "comment": "…"}
got: no line
status: error · no result line on stdout`);
    expect(view?.explanation).toBe(
      'The script must print one JSON line such as {"key": "check", "score": 1, "comment": "…"} on stdout, and printed none. ' +
        "It raised KeyError: 'late_fee_rate' first (see the traceback). " +
        'fixtures/policy_terms.json changed since the previous load, when this check passed, and its keys may no longer match what the script reads. ' +
        'Fix it in ./suites/invoices-v1/late_fees/, then reload.',
    );
  });

  it('is null for a valid task', () => {
    expect(selfCheckFailureView(failureInput({ valid: true }))).toBeNull();
  });

  it.each([
    [
      'timed out',
      scriptRun({ timed_out: true, exit_code: null, stderr_tail: '' }),
      'verifier_script check_late_fees.py timed out after 30 s on the reference answer · score status error',
      /ran past its 30 s timeout/,
    ],
    [
      'bad JSON',
      scriptRun({ stdout_tail: 'score: 1', exit_code: 0, stderr_tail: '' }),
      'verifier_script check_late_fees.py printed a result line that is not JSON on the reference answer · score status error',
      /not valid JSON/,
    ],
    [
      'below pass_at',
      scriptRun({
        status: 'failed',
        score: 0.5,
        stdout_tail: '{"key": "check", "score": 0.5}',
        exit_code: 0,
        stderr_tail: '',
      }),
      'verifier_script check_late_fees.py scored 0.5 on the reference answer, below pass at 1.0 · score status failed',
      /Either reference.json or the script is wrong/,
    ],
    [
      'no score',
      scriptRun({ stdout_tail: '{"key": "check"}', exit_code: 0, stderr_tail: '' }),
      'verifier_script check_late_fees.py printed a result line without a score on the reference answer · score status error',
      /no numeric "score"/,
    ],
    [
      'non-zero exit',
      scriptRun({ stdout_tail: '{"key": "check", "score": 1}', exit_code: 2, stderr_tail: '' }),
      'verifier_script check_late_fees.py exited with code 2 on the reference answer · score status error',
      /exited with code 2/,
    ],
  ])('explains a verifier that %s', (_name, run, title, explanation) => {
    const view = selfCheckFailureView(
      failureInput({ selfCheck: check('error', [ANSWER_PASSED, run]), changedSincePrevious: [] }),
    );
    expect(view?.title).toBe(title);
    expect(view?.explanation).toMatch(explanation);
    expect(view?.explanation).toMatch(
      /Fix it in \.\/suites\/invoices-v1\/late_fees\/, then reload\.$/,
    );
  });

  it('explains a reference answer that fails its own check', () => {
    const view = selfCheckFailureView(
      failureInput({
        selfCheck: check('failed', [
          { ...ANSWER_PASSED, status: 'failed', score: 0, comment: 'expected 30.95, got 31.2' },
        ]),
        previous: null,
      }),
    );
    expect(view).toMatchObject({
      key: 'answer',
      title:
        'numeric_tolerance on late_fees_total fails on the reference answer · score status failed',
      status: 'failed',
      previousRun: null,
    });
    expect(view?.explanation).toBe(
      'reference.json does not satisfy its own numeric_tolerance check: expected 30.95, got 31.2. ' +
        "Fix reference.json or the entry's params in task.yaml. Fix it in ./suites/invoices-v1/late_fees/, then reload.",
    );
    expect(view?.transcript).toContain('numeric_tolerance answer on the reference answer');
  });

  it('explains a negative control that passed', () => {
    const entry: VerificationEntry = {
      key: 'summary',
      type: 'file_check',
      primary: true,
      params: { path: 'summary.csv' },
    };
    const run: SelfCheckResult = {
      key: 'summary',
      type: 'file_check',
      mode: 'workspace',
      status: 'passed',
      score: 1,
      comment: 'ok',
    };
    const view = selfCheckFailureView(
      failureInput({
        verification: [entry],
        selfCheck: check('failed', [run, { ...run, expect: 'fail', duration_ms: 5 }]),
        previous: null,
      }),
    );
    expect(view).toMatchObject({
      title: 'file_check summary.csv passed on the untouched fixtures (negative control)',
      status: 'failed',
    });
    expect(view?.transcript).toContain('# negative control, on the untouched fixtures');
    expect(view?.transcript).toContain('expected the negative control not to pass');
    expect(view?.explanation).toMatch(/would pass an agent that did nothing/);
  });

  it('builds the panel from load issues when no check ran', () => {
    const view = selfCheckFailureView(
      failureInput({
        selfCheck: { status: 'skipped', ran_at: null, duration_ms: null, results: [] },
        loadIssues: [
          {
            severity: 'error',
            code: 'params_invalid',
            key: 'check',
            path: 'task.yaml#verification[1].params.timeout_s',
            message: 'Too big: expected number to be <=300',
          },
          {
            severity: 'warning',
            code: 'prompt_no_fenced_json',
            message: 'prompt.md does not ask for a fenced JSON block',
          },
        ],
      }),
    );
    expect(SelfCheckFailureViewSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({
      key: 'check',
      type: 'verifier_script',
      title: 'task.yaml#verification[1].params.timeout_s: Too big: expected number to be <=300',
      status: 'error',
      ranAt: RAN_AT,
      previousRun: { at: V1_RAN_AT, status: 'passed' },
    });
    expect(view?.transcript).toBe(
      'error  params_invalid  task.yaml#verification[1].params.timeout_s  Too big: expected number to be <=300\n' +
        'warning  prompt_no_fenced_json  prompt.md does not ask for a fenced JSON block',
    );
    expect(view?.explanation).toBe(
      'The task could not be loaded as written (1 error), so its checks did not run. Fix it in ./suites/invoices-v1/late_fees/, then reload.',
    );
  });

  it('has nothing to show for a task without a parseable entry', () => {
    expect(
      selfCheckFailureView(
        failureInput({
          verification: [],
          selfCheck: { status: 'skipped', ran_at: null, duration_ms: null, results: [] },
          loadIssues: [
            { severity: 'error', code: 'yaml_invalid', path: 'task.yaml', message: 'bad' },
          ],
        }),
      ),
    ).toBeNull();
  });
});
