/** suggestRepetitions (for the Phase 8 report) and the normal quantile it uses. */
import { beforeAll, describe, expect, it } from 'vitest';
import { suggestRepetitions } from './compute.js';
import type { StatsInput, StatsRun } from './contracts.js';
import { DesignData } from './design-data.support-spec.js';
import { normalQuantile } from './repetitions.js';

let data: DesignData;
beforeAll(async () => {
  data = await DesignData.load();
});

const run = (passed: boolean): StatsRun => ({
  passed,
  keyStatus: passed ? 'passed' : 'failed',
  executionError: null,
  durationS: null,
  tokens: null,
  costUsd: null,
});

/** Tasks as [baseline, candidate] strings of P and F. */
const input = (rows: [string, string][]): StatsInput => ({
  tasks: rows.map(([b, c], i) => ({
    taskKey: `task_${i + 1}`,
    baseline: b.split('').map((x) => run(x === 'P')),
    candidate: c.split('').map((x) => run(x === 'P')),
  })),
  repetitions: Math.max(...rows.map(([b]) => b.length)),
  provisional: false,
  labels: { baseline: 'baseline', candidate: 'candidate' },
  progress: { scored: 1, total: 1 },
});

describe('normalQuantile', () => {
  it('matches the standard normal table', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 12);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963985, 8);
    expect(normalQuantile(0.995)).toBeCloseTo(2.575829304, 8);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.326347874, 8);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232306, 8);
    expect(normalQuantile(0.8)).toBeCloseTo(-normalQuantile(0.2), 9);
  });

  it('refuses p outside (0, 1)', () => {
    for (const p of [0, 1, -1, Number.NaN]) expect(() => normalQuantile(p)).toThrow(RangeError);
  });
});

describe('suggestRepetitions', () => {
  it('on Skill vs no skill: ±0.10 needs 8 repetitions, and a tighter interval more', () => {
    const svn = data.statsInput(data.seed('skillVsNoSkill'));
    // The tasks' spread is all binomial noise there: 0.2583 / 0.0341 = 7.6, so 8.
    expect(suggestRepetitions(svn, 0.1)).toBe(8);
    expect(suggestRepetitions(svn, 0.15)).toBe(4);
    expect(suggestRepetitions(svn, 0.05)).toBe(31);
    const widths = [0.05, 0.08, 0.1, 0.15, 0.2, 0.3];
    const reps = widths.map((w) => suggestRepetitions(svn, w)!);
    for (let i = 1; i < reps.length; i++) expect(reps[i]).toBeLessThanOrEqual(reps[i - 1]!);
    expect(suggestRepetitions(svn, 0.1, { confidence: 0.99 })).toBeGreaterThan(8);
    expect(suggestRepetitions(svn, 0.1, { confidence: 0.8 })).toBeLessThan(8);
  });

  it('on Flow B: no number of repetitions reaches ±0.05, because the tasks themselves differ', () => {
    const smoke = data.statsInput(data.seed('mcpSmoke'));
    // late_fees went from 0 of 3 to 3 of 3, while most tasks did not move.
    expect(suggestRepetitions(smoke, 0.05)).toBeNull();
    expect(suggestRepetitions(smoke, 0.1)).toBeNull();
    expect(suggestRepetitions(smoke, 0.15)).toBe(7);
  });

  it('asks for the gate minimum when the runs never vary', () => {
    expect(
      suggestRepetitions(
        input([
          ['PPP', 'PPP'],
          ['FFF', 'FFF'],
        ]),
        0.01,
      ),
    ).toBe(2);
    // No noise, but the tasks differ by 1: ±0.01 is out of reach.
    expect(
      suggestRepetitions(
        input([
          ['FFF', 'PPP'],
          ['FFF', 'FFF'],
        ]),
        0.01,
      ),
    ).toBeNull();
  });

  it('has nothing to estimate from with one task or one run per side', () => {
    expect(suggestRepetitions(input([['PFPF', 'PPPF']]), 0.1)).toBeNull();
    expect(
      suggestRepetitions(
        input([
          ['P', 'F'],
          ['F', 'P'],
          ['P', 'P'],
        ]),
        0.1,
      ),
    ).toBeNull();
  });

  it('refuses a half-width that is not a positive number, and a bad confidence', () => {
    const svn = input([
      ['PF', 'PP'],
      ['FF', 'PF'],
    ]);
    for (const w of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => suggestRepetitions(svn, w)).toThrow(RangeError);
    }
    expect(() => suggestRepetitions(svn, 0.1, { confidence: 1 })).toThrow(RangeError);
  });
});
