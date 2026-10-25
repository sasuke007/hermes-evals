/**
 * The verdict on constructed inputs (./cases.support-spec.ts): worse,
 * provisional, a sensitivity figure that changes the verdict, the edge cases
 * (all passed, all failed, one task, float noise), the options, and the
 * secondary metrics.
 */
import { describe, expect, it } from 'vitest';
import { computed, input, stats } from './cases.support-spec.js';
import { computeComparisonStats } from './compute.js';
import type { StatsRun } from './contracts.js';

describe('verdicts', () => {
  it('is worse when the whole interval is below 0', () => {
    const rows: [string, string][] = [
      ['PPPP', 'PFFF'],
      ['PPPF', 'FFPF'],
      ['PPPP', 'PPFF'],
      ['PPFP', 'FFFF'],
      ['PPPP', 'PPPF'],
    ];
    const result = computed(stats(input(rows)));
    expect(result.hi).toBeLessThan(0);
    expect(result.verdict).toBe('worse');
    expect(result.taskCounts).toEqual({ improved: 0, regressed: 5, unchanged: 0 });
  });

  it('mirrors: swapping the configurations negates the difference and the interval', () => {
    const rows: [string, string][] = [
      ['PFPF', 'PPPP'],
      ['FFFP', 'PPFP'],
      ['PPPP', 'PPPP'],
    ];
    const forward = computed(stats(input(rows)));
    const back = computed(stats(input(rows.map(([b, c]) => [c, b]))));
    expect(back.observedDelta).toBeCloseTo(-forward.observedDelta, 12);
    expect(back.lo).toBeCloseTo(-forward.hi, 12);
    expect(back.hi).toBeCloseTo(-forward.lo, 12);
  });

  it('is provisional while the experiment runs or is paused', () => {
    const rows: [string, string][] = [
      ['FF', 'PP'],
      ['FF', 'PP'],
      ['PF', 'PP'],
    ];
    expect(computed(stats(input(rows))).verdict).toBe('better');
    const running = computed(stats(input(rows, { provisional: true })));
    expect(running).toMatchObject({ verdict: 'provisional', provisional: true });
    expect(running.lo).toBeGreaterThan(0);
  });
});

describe('sensitivity', () => {
  it('changes the verdict when the improvement came from the baseline breaking', () => {
    // Every baseline answer that ran passed; the candidate only looks better
    // because half the baseline's runs were execution errors or ungradable.
    const rows: [string, string][] = [
      ['PPEE', 'PPPP'],
      ['PPEU', 'PPPP'],
      ['PPPE', 'PPPP'],
      ['PPXE', 'PPPP'],
      ['PPEE', 'PPPP'],
    ];
    const result = computed(stats(input(rows)));
    expect(result.verdict).toBe('better');
    expect(result.sensitivity).toEqual({
      excludedBaseline: { executionErrors: 7, ungradable: 1, error: 1 },
      excludedCandidate: { executionErrors: 0, ungradable: 0, error: 0 },
      baseline: { passed: 11, counted: 11, rate: 1 },
      candidate: { passed: 20, counted: 20, rate: 1 },
      delta: 0,
      lo: 0,
      hi: 0,
      verdict: 'inconclusive',
      verdictChanges: true,
    });
  });

  it('cannot give a verdict when the kept runs fail the 2-runs gate', () => {
    const result = computed(
      stats(
        input([
          ['PE', 'PP'],
          ['PP', 'EE'],
          ['FF', 'PP'],
        ]),
      ),
    );
    expect(result.sensitivity).toMatchObject({
      candidate: { passed: 4, counted: 4, rate: 1 },
      // task_2 has no kept candidate run: the mean is over task_1 and task_3.
      delta: 0.5,
      lo: null,
      hi: null,
      verdict: 'not_computable',
      verdictChanges: true,
    });
  });

  it('is absent when nothing was excluded', () => {
    expect(
      stats(
        input([
          ['PF', 'PP'],
          ['FF', 'PF'],
        ]),
      ).sensitivity,
    ).toBeNull();
  });
});

describe('edge cases', () => {
  it('all passed on both sides: no difference, inconclusive', () => {
    const result = computed(
      stats(
        input([
          ['PPP', 'PPP'],
          ['PPP', 'PPP'],
          ['PPP', 'PPP'],
        ]),
      ),
    );
    expect(result).toMatchObject({ observedDelta: 0, lo: 0, hi: 0, verdict: 'inconclusive' });
    expect(result.taskCounts).toEqual({ improved: 0, regressed: 0, unchanged: 3 });
    expect(Object.is(result.lo, -0)).toBe(false);
  });

  it('all failed on both sides: no difference, inconclusive', () => {
    const result = computed(
      stats(
        input([
          ['FF', 'FF'],
          ['FF', 'FF'],
        ]),
      ),
    );
    expect(result).toMatchObject({ observedDelta: 0, lo: 0, hi: 0, verdict: 'inconclusive' });
  });

  it('everything failed against everything passed: +1, better', () => {
    const result = computed(
      stats(
        input([
          ['FF', 'PP'],
          ['FF', 'PP'],
          ['FF', 'PP'],
        ]),
      ),
    );
    expect(result).toMatchObject({ observedDelta: 1, lo: 1, hi: 1, verdict: 'better' });
  });

  it('one task: the bootstrap can only redraw it, so the interval is the observed difference', () => {
    const result = computed(stats(input([['PFFFF', 'PPPPF']])));
    expect(result.observedDelta).toBeCloseTo(0.6, 12);
    expect(result.lo).toBeCloseTo(0.6, 12);
    expect(result.hi).toBeCloseTo(0.6, 12);
    expect(result.verdict).toBe('better');
  });

  it('float noise does not leave a difference where there is none', () => {
    // The differences +0.2, +0.4 and −0.6 sum to 1.1e-16 in floats, and to 0.
    const rows: [string, string][] = [
      ['FFFFF', 'PFFFF'],
      ['FFFFF', 'PPFFF'],
      ['PPPFF', 'FFFFF'],
    ];
    const result = computed(stats(input(rows)));
    expect(result.observedDelta).toBe(0);
    expect(result.verdict).toBe('inconclusive');
  });

  it('refuses options it cannot use', () => {
    const ok = input([
      ['PP', 'PP'],
      ['PF', 'PP'],
    ]);
    expect(() => computeComparisonStats(ok, { seed: -1 })).toThrow(RangeError);
    expect(() => computeComparisonStats(ok, { seed: 1, resamples: 0 })).toThrow(RangeError);
    expect(() => computeComparisonStats(ok, { seed: 1, confidence: 1 })).toThrow(RangeError);
    expect(() => computeComparisonStats({ ...ok, repetitions: 0 }, { seed: 1 })).toThrow(
      RangeError,
    );
  });

  it('honours the resample count and confidence it is given', () => {
    const rows: [string, string][] = [
      ['PFPF', 'PPPP'],
      ['FFFP', 'PPFP'],
      ['PPPP', 'PPPF'],
    ];
    const narrow = computed(computeComparisonStats(input(rows), { seed: 7, confidence: 0.5 }));
    const wide = computed(computeComparisonStats(input(rows), { seed: 7, confidence: 0.99 }));
    expect(narrow.hi - narrow.lo).toBeLessThan(wide.hi - wide.lo);
    expect(
      computed(computeComparisonStats(input(rows), { seed: 7, resamples: 500 })),
    ).toMatchObject({ resamples: 500, confidence: 0.95 });
  });
});

describe('secondary metrics', () => {
  it('summarises each configuration over its counted runs, and the difference', () => {
    const result = stats(
      input([
        ['PE', 'PP'],
        ['PF', 'PU'],
      ]),
    );
    expect(result.secondary.baseline.costUsd).toBeCloseTo(0.05, 12);
    expect(result.secondary.baseline).toMatchObject({
      medianDurationS: 40,
      meanTokens: 14_000,
      executionErrors: 1,
      executionErrorCategories: ['timeout'],
      ungradable: 0,
    });
    expect(result.secondary.candidate).toMatchObject({ meanTokens: 12_000, ungradable: 1 });
    expect(result.secondary.difference).toMatchObject({
      medianDurationS: 0,
      meanTokensPct: (-2_000 / 14_000) * 100,
      executionErrors: -1,
      ungradable: 1,
    });
    expect(result.secondary.difference.costUsd).toBeCloseTo(-0.01, 12);
  });

  it('leaves unknown figures null rather than 0', () => {
    const unknown = (r: StatsRun): StatsRun => ({
      ...r,
      durationS: null,
      tokens: null,
      costUsd: null,
    });
    const i = input([
      ['PF', 'PP'],
      ['PP', 'FP'],
    ]);
    const blank = {
      ...i,
      tasks: i.tasks.map((t) => ({ ...t, baseline: t.baseline.map(unknown) })),
    };
    const { secondary } = stats(blank);
    expect(secondary.baseline).toMatchObject({
      medianDurationS: null,
      meanTokens: null,
      costUsd: null,
    });
    expect(secondary.difference).toMatchObject({
      medianDurationS: null,
      meanTokensPct: null,
      costUsd: null,
    });
  });
});
