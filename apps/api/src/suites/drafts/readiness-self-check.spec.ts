/**
 * Rows 12 and 13 of SA.8 on in-memory draft tasks: answer checks
 * self-checked live, file checks and verifier scripts waiting for the
 * worker until a run on the task's current content, and the negative
 * control.
 */
import { describe, expect, it } from 'vitest';
import type { SelfCheck } from '@hermes-evals/shared';
import type { DraftSelfCheckRecord } from '../../database/schema/index.js';
import { INVOICES, NOW, readiness, status } from './readiness-testing.helper-spec.js';

const SUMMARY_YAML = `summary: Write summary.csv
limits:
  max_turns: 20
  run_budget_seconds: 300
  toolsets_needed: [file]
answer:
  format: fenced_json
verification:
  - key: file
    type: file_check
    primary: true
    params: { path: summary.csv, format: csv }
  - key: totals
    type: verifier_script
    params: { script: check_summary.py }
self_check:
  expected_workspace: expected
`;

const SUMMARY_FILES = {
  'fixtures/invoices.csv': INVOICES,
  'expected/summary.csv': 'vendor,total\n',
  'verify/check_summary.py': 'print(1)\n',
};
const SUMMARY_KINDS = { 'expected/summary.csv': 'expected' } as const;

describe('file checks and the worker self-check', () => {
  const base = {
    taskYaml: SUMMARY_YAML,
    prompt: 'Write `summary.csv` from `invoices.csv`. fenced json\n',
    reference: '{ "rows": 8 }',
    files: SUMMARY_FILES,
    kinds: SUMMARY_KINDS,
  };

  it('needs an expected workspace for a file check', async () => {
    const r = await readiness({
      ...base,
      taskYaml: SUMMARY_YAML.replace(/self_check:[\s\S]*$/, ''),
    });
    expect(status(r.rule('expected_folders'))).toEqual([
      'problem',
      '`file` needs an expected workspace.',
    ]);
  });

  it('waits for the worker until a run on this content', async () => {
    const r = await readiness(base);
    expect(r.needsWorker).toBe(true);
    expect(status(r.rule('expected_folders'))).toEqual(['passed', '`expected/` has 1 file.']);
    expect(status(r.rule('self_check'))).toEqual([
      'pending',
      'File checks and verifier scripts run in the worker. Takes seconds.',
    ]);
    expect(status(r.rule('negative_control'))).toEqual(['pending', 'Shown after the self-check.']);
    expect(r.rule('mentioned_files').message).toBe(
      '`invoices.csv` is in workspace files. `summary.csv` is in the expected workspace (written by the agent).',
    );
    expect(r.summary).toBe('not_run');
  });

  const run = (contentHash: string, results: SelfCheck['results']): DraftSelfCheckRecord => ({
    status: results.every((x) => (x.expect === 'fail') !== (x.status === 'passed'))
      ? 'passed'
      : 'failed',
    ran_at: NOW.toISOString(),
    duration_ms: 400,
    results,
    content_hash: contentHash,
  });
  const result = (
    key: string,
    type: 'file_check' | 'verifier_script',
    expect: 'pass' | 'fail',
    passed: boolean,
    extra = {},
  ) => ({
    key,
    type,
    mode: 'workspace' as const,
    expect,
    status: passed ? ('passed' as const) : ('failed' as const),
    score: passed ? 1 : 0,
    comment: passed ? 'ok' : 'summary.csv has 8 data rows; the check needs 9',
    ...extra,
  });

  it('shows a current run, passed and with its negative control', async () => {
    const first = await readiness(base);
    const hash = first.analysis.contentHash;
    const r = await readiness({
      ...base,
      lastSelfCheck: run(hash, [
        result('file', 'file_check', 'pass', true),
        result('file', 'file_check', 'fail', false),
        result('totals', 'verifier_script', 'pass', true),
      ]),
    });
    expect(status(r.rule('self_check'))).toEqual([
      'passed',
      'Self-check passed · 0.4 s. `file` passes on the expected workspace; `totals` scores 1.0.',
    ]);
    expect(status(r.rule('negative_control'))).toEqual([
      'passed',
      '`file` fails on the untouched workspace, as it should.',
    ]);
    expect(r.summary).toBe('ready');
  });

  it('shows a failed run, a passing negative control, and ignores a run on other content', async () => {
    const hash = (await readiness(base)).analysis.contentHash;
    const failed = await readiness({
      ...base,
      lastSelfCheck: run(hash, [result('file', 'file_check', 'pass', false)]),
    });
    expect(status(failed.rule('self_check'))).toEqual([
      'problem',
      '`file`: summary.csv has 8 data rows; the check needs 9.',
    ]);
    expect(status(failed.rule('negative_control'))).toEqual([
      'pending',
      'Shown after the self-check passes.',
    ]);
    const negative = await readiness({
      ...base,
      lastSelfCheck: run(hash, [
        result('file', 'file_check', 'pass', true),
        result('file', 'file_check', 'fail', true),
      ]),
    });
    expect(status(negative.rule('self_check'))).toEqual([
      'problem',
      '`file` passed on the untouched workspace, so doing nothing would pass. Make the check depend on what the agent writes.',
    ]);
    expect(status(negative.rule('negative_control'))).toEqual([
      'problem',
      '`file` passes on the untouched workspace.',
    ]);
    const crashed = await readiness({
      ...base,
      lastSelfCheck: run(hash, [
        result('file', 'file_check', 'pass', true),
        {
          ...result('totals', 'verifier_script', 'pass', false),
          status: 'error' as const,
          exit_code: 1,
        },
      ]),
    });
    expect(crashed.rule('self_check').message).toBe(
      '`totals`: the verifier script exited with status 1, so the check is error.',
    );
    const stale = await readiness({
      ...base,
      lastSelfCheck: run('0'.repeat(64), [result('file', 'file_check', 'pass', false)]),
    });
    expect(stale.rule('self_check').status).toBe('pending');
  });

  it('warns when the negative control is off', async () => {
    const r = await readiness({ ...base, taskYaml: `${SUMMARY_YAML}  negative_control: false\n` });
    expect(status(r.rule('negative_control'))).toEqual([
      'warning',
      'The negative control is off, so nothing checks that doing nothing fails.',
    ]);
  });
});
