/** The usage list's pass-rate and verdict rules, without a database. */
import { describe, expect, it } from 'vitest';
import type { VerdictEntry } from '@hermes-evals/shared';
import type { VerdictFigures } from '../experiments/comparison/verdicts.js';
import type { StatsResult } from '../statistics/contracts.js';
import { armDelta, armPassRate, armVerdict, armVerdictOf } from './usage.js';

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
  const completed = { status: 'completed' as const, repetitions: 3, taskIds: ['t1', 't2', 't3'] };

  it('is not computable with one repetition or nothing scored', () => {
    expect(armVerdict({ ...completed, repetitions: 1, verdictHistory: [] }, 'v2', 10)).toBe(
      'not_computable',
    );
    expect(armVerdict({ ...completed, verdictHistory: [] }, 'v2', 0)).toBe('not_computable');
  });

  it('says why there is no verdict, for the row to name it', () => {
    const running = { ...completed, status: 'running' as const, verdictHistory: [] };
    expect(armVerdictOf({ ...running, repetitions: 1 }, 'v2', 5)).toEqual({
      verdict: 'not_computable',
      reason: 'single_repetition',
    });
    expect(armVerdictOf({ ...running, taskIds: ['t1'] }, 'v2', 5)).toEqual({
      verdict: 'not_computable',
      reason: 'too_few_tasks',
    });
    expect(armVerdictOf(running, 'v2', 0)).toEqual({
      verdict: 'not_computable',
      reason: 'nothing_scored',
    });
    expect(armVerdictOf(running, 'v2', 5)).toEqual({ verdict: 'provisional', reason: null });
    const recorded = [{ ...entry('v2', 'not_computable'), reason: 'not_enough_runs' as const }];
    expect(armVerdictOf({ ...completed, verdictHistory: recorded }, 'v2', 5)).toEqual({
      verdict: 'not_computable',
      reason: 'not_enough_runs',
    });
    expect(
      armVerdictOf({ ...completed, verdictHistory: [entry('v2', 'better')] }, 'v2', 5),
    ).toEqual({ verdict: 'better', reason: null });
  });

  it('is not computable at once with fewer than 3 tasks, as the comparison is', () => {
    const twoTasks = { ...completed, status: 'running' as const, taskIds: ['t1', 't2'] };
    expect(armVerdict({ ...twoTasks, verdictHistory: [] }, 'v2', 5)).toBe('not_computable');
    expect(armVerdict({ ...twoTasks, status: 'paused', verdictHistory: [] }, 'v2', 5)).toBe(
      'not_computable',
    );
  });

  it('is provisional until the experiment completes', () => {
    expect(
      armVerdict(
        { ...completed, status: 'running', verdictHistory: [entry('v2', 'better')] },
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

  it("takes a completed experiment's entry first, even one that records no verdict", () => {
    const verdictHistory = [
      { ...entry('v2', 'not_computable'), reason: 'single_repetition' as const },
    ];
    expect(armVerdict({ ...completed, repetitions: 1, verdictHistory }, 'v2', 4)).toBe(
      'not_computable',
    );
    expect(armVerdict({ ...completed, verdictHistory: [entry('v2', 'worse')] }, 'v2', 0)).toBe(
      'worse',
    );
  });

  it('falls back to the current figures for a completed experiment recorded before verdict entries', () => {
    const stats = (verdict: 'better' | 'inconclusive') =>
      ({ computable: true, verdict }) as unknown as StatsResult;
    const figures: VerdictFigures = {
      resultsRevision: 7,
      status: 'completed',
      byCandidate: new Map([['v2', stats('better')]]),
    };
    expect(armVerdict({ ...completed, verdictHistory: [] }, 'v2', 5, figures)).toBe('better');
    // Unknown to the figures: the rules before Phase 4.
    expect(armVerdict({ ...completed, verdictHistory: [] }, 'v3', 5, figures)).toBe('provisional');
    // While it runs, figures never decide: provisional.
    expect(
      armVerdict({ ...completed, status: 'running', verdictHistory: [] }, 'v2', 5, figures),
    ).toBe('provisional');
  });
});

describe('armDelta', () => {
  const completed = { status: 'completed' as const, repetitions: 3 };
  const figuresWith = (stats: Partial<StatsResult>): VerdictFigures => ({
    resultsRevision: 4,
    status: 'running',
    byCandidate: new Map([['v2', stats as StatsResult]]),
  });

  it("takes a completed experiment's last entry, rounded as the Overview rounds it", () => {
    const verdictHistory = [
      { ...entry('v2', 'better'), delta: 0.3 },
      { ...entry('v2', 'inconclusive'), delta: 0.05555 },
    ];
    expect(armDelta({ ...completed, verdictHistory }, 'v2', null)).toBe(0.056);
    expect(armDelta({ ...completed, verdictHistory }, 'v3', null)).toBeNull();
  });

  it('keeps the observed Δ when the gate failed for too few tasks', () => {
    const verdictHistory = [
      { ...entry('v2', 'not_computable'), reason: 'too_few_tasks' as const, delta: -0.25 },
    ];
    expect(armDelta({ ...completed, verdictHistory }, 'v2', null)).toBe(-0.25);
  });

  it('is the provisional Δ of the figures while the experiment runs', () => {
    const running = { status: 'running' as const, repetitions: 3, verdictHistory: [] };
    const figures = figuresWith({ computable: true, observedDelta: 0.1234 } as never);
    expect(armDelta(running, 'v2', figures)).toBe(0.123);
    // A running experiment's history (from an earlier completion) does not decide.
    expect(
      armDelta(
        { ...running, verdictHistory: [{ ...entry('v2', 'better'), delta: 0.9 }] },
        'v2',
        figures,
      ),
    ).toBe(0.123);
    expect(armDelta(running, 'v2', null)).toBeNull();
    expect(
      armDelta(
        running,
        'v2',
        figuresWith({ computable: false, reason: 'nothing_scored', observedDelta: null } as never),
      ),
    ).toBeNull();
  });

  it('has none with one repetition', () => {
    const figures = figuresWith({ computable: true, observedDelta: 0.2 } as never);
    expect(
      armDelta({ status: 'running', repetitions: 1, verdictHistory: [] }, 'v2', figures),
    ).toBeNull();
    expect(
      armDelta(
        { ...completed, repetitions: 1, verdictHistory: [entry('v2', 'not_computable')] },
        'v2',
        null,
      ),
    ).toBeNull();
  });
});
