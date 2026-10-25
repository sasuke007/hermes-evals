import type { SelfCheck } from '@hermes-evals/shared';
import { verdict } from './read-suite.js';
import { expectedWorkspace, suiteSelfCheckSeconds } from './task-self-check.js';
import type { StoredTaskFile } from './task-files.js';

const file = (path: string, kind: StoredTaskFile['kind'], text = path): StoredTaskFile => ({
  path,
  kind,
  content: Buffer.from(text),
  sha256: '0'.repeat(64),
  size: text.length,
});

describe('expectedWorkspace', () => {
  it('overlays the expected folder on the fixtures, expected files winning', () => {
    const tree = expectedWorkspace(
      [
        file('fixtures/a.csv', 'fixture', 'old'),
        file('fixtures/keep.txt', 'fixture'),
        file('fixtures/dir', 'fixture'),
        file('fixtures/sub/x', 'fixture'),
        file('expected/a.csv', 'expected', 'new'),
        file('expected/dir/inner', 'expected'),
        file('expected/sub', 'expected'),
        file('verify/check.py', 'verifier'),
      ],
      'expected',
    );
    expect([...tree.keys()].sort()).toEqual(['a.csv', 'dir/inner', 'keep.txt', 'sub']);
    expect(tree.get('a.csv')!.content.toString()).toBe('new');
  });
});

describe('verdict', () => {
  const check = (results: SelfCheck['results'], status: SelfCheck['status']): SelfCheck => ({
    status,
    ran_at: '2026-10-24T10:00:00.000Z',
    duration_ms: 5,
    results,
  });
  const result = (over: Partial<SelfCheck['results'][number]>): SelfCheck['results'][number] => ({
    key: 'k',
    type: 'verifier_script',
    mode: 'workspace',
    status: 'passed',
    score: 1,
    comment: 'ok',
    ...over,
  });

  it('is valid when every runnable check passed', () => {
    expect(verdict({ issues: [] }, check([result({})], 'passed'))).toEqual({
      valid: true,
      invalidReason: null,
    });
  });

  it('names the first load error, and how many more there are', () => {
    const issues = [
      { severity: 'warning' as const, code: 'prompt_no_fenced_json' as const, message: 'w' },
      { severity: 'error' as const, code: 'file_missing' as const, message: 'prompt.md not found' },
      { severity: 'error' as const, code: 'reference_invalid' as const, message: 'x' },
    ];
    expect(verdict({ issues }, check([], 'skipped'))).toEqual({
      valid: false,
      invalidReason: 'prompt.md not found (and 1 more)',
    });
  });

  it('explains a negative control that passed', () => {
    const results = [result({ expect: 'pass' }), result({ expect: 'fail', key: 'out' })];
    expect(verdict({ issues: [] }, check(results, 'failed')).invalidReason).toBe(
      'out: the check passes on the untouched fixtures, so it would pass any agent',
    );
  });

  it('quotes a failed check in one line', () => {
    const results = [result({ status: 'failed', score: 0, comment: 'line one\nline two' })];
    expect(verdict({ issues: [] }, check(results, 'failed')).invalidReason).toBe(
      'k (verifier_script) self-check failed: line one line two',
    );
  });
});

describe('suiteSelfCheckSeconds', () => {
  it('spreads the tasks over the concurrent slots, the longest one charged in full', () => {
    expect(suiteSelfCheckSeconds([], 4)).toBe(0);
    expect(suiteSelfCheckSeconds([0, 0, 0], 4)).toBe(0);
    // One task runs alone, whatever the concurrency.
    expect(suiteSelfCheckSeconds([620], 4)).toBe(620);
    // A bound for any finishing order, so it is not tight: four equal tasks
    // that could all run at once are charged 320 / 4 + 3/4 of 80.
    expect(suiteSelfCheckSeconds([80, 80, 80, 80], 4)).toBe(140);
    // Far below running them one by one.
    expect(
      suiteSelfCheckSeconds(
        Array.from({ length: 40 }, () => 80),
        4,
      ),
    ).toBe(860);
    // 0 + 0 + 0 + 80 + 40 over 4 slots: 30, plus 3/4 of the longest.
    expect(suiteSelfCheckSeconds([0, 0, 0, 80, 40], 4)).toBe(90);
    // Never below what one slot could take with every task on it in order.
    expect(suiteSelfCheckSeconds([100, 100, 100, 100, 100], 1)).toBe(500);
  });

  it('is never below the time p-limit can actually take for any order', () => {
    // Greedy list scheduling of these tasks over 2 slots ends at 15 at worst (5, 5, then 10).
    expect(suiteSelfCheckSeconds([5, 5, 10], 2)).toBeGreaterThanOrEqual(15);
  });
});
