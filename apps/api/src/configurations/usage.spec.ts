/** The usage list's pass-rate and verdict rules, without a database. */
import { describe, expect, it } from 'vitest';
import type { VerdictEntry } from '@hermes-evals/shared';
import { armPassRate, armVerdict } from './usage.js';

const arm = (
  scored: number,
  passed: number,
  executionErrors = 0,
  total = scored + executionErrors,
) => ({
  total,
  scored,
  executionErrors,
  passed,
});

const entry = (candidate: string, verdict: VerdictEntry['verdict']): VerdictEntry => ({
  at: '2026-10-23T10:00:00.000Z',
  cause: 'initial',
  candidate_version_id: candidate,
  key: 'answer',
  delta: 0.1,
  lo: 0.02,
  hi: 0.2,
  verdict,
  reason: null,
});

describe('armPassRate', () => {
  it('counts only scored runs while the experiment runs', () => {
    expect(armPassRate('running', arm(3, 2, 1))).toBe(0.667);
    expect(armPassRate('paused', arm(0, 0, 2))).toBeNull();
  });

  it('counts execution errors as not passed once it has finished', () => {
    expect(armPassRate('completed', arm(3, 2, 1))).toBe(0.5);
    expect(armPassRate('failed', arm(0, 0, 2))).toBe(0);
    expect(armPassRate('completed', arm(0, 0, 0, 4))).toBeNull();
  });
});

describe('armVerdict', () => {
  const completed = { status: 'completed' as const, repetitions: 3 };

  it('is not computable with one repetition or nothing scored', () => {
    expect(armVerdict({ ...completed, repetitions: 1, verdictHistory: [] }, 'v2', 10)).toBe(
      'not_computable',
    );
    expect(armVerdict({ ...completed, verdictHistory: [] }, 'v2', 0)).toBe('not_computable');
  });

  it('is provisional until the experiment completes', () => {
    expect(
      armVerdict(
        { status: 'running', repetitions: 3, verdictHistory: [entry('v2', 'better')] },
        'v2',
        5,
      ),
    ).toBe('provisional');
  });

  it("takes the candidate's last recorded verdict", () => {
    const verdictHistory = [
      entry('v2', 'better'),
      entry('v3', 'worse'),
      entry('v2', 'inconclusive'),
    ];
    expect(armVerdict({ ...completed, verdictHistory }, 'v2', 5)).toBe('inconclusive');
    expect(armVerdict({ ...completed, verdictHistory }, 'v3', 5)).toBe('worse');
    expect(armVerdict({ ...completed, verdictHistory }, 'v4', 5)).toBe('provisional');
  });
});
