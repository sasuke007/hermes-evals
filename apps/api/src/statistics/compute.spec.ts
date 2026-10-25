/**
 * The statistics on the design's own datasets (plan 10.4), read from the web
 * fixtures (./design-data.support-spec.ts): Skill vs no skill reproduces the
 * VerdictCard's numbers, Flow B stays inconclusive, and across every fixture
 * scenario the module agrees with what the web draws.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { bootstrapMeans } from './bootstrap.js';
import { computeComparisonStats, seedFromExperimentId } from './compute.js';
import type { ComputedStats, StatsInput, StatsResult } from './contracts.js';
import { DesignData, type DesignSeed } from './design-data.support-spec.js';

let data: DesignData;
beforeAll(async () => {
  data = await DesignData.load();
});

const statsOf = (seed: DesignSeed, candidate?: string, key?: string): StatsResult =>
  computeComparisonStats(data.statsInput(seed, candidate, key), {
    seed: seedFromExperimentId(seed.id),
  });

function computed(result: StatsResult): ComputedStats {
  if (!result.computable) throw new Error(`not computable: ${result.reason}`);
  return result;
}

describe('plan 10.4: Skill vs no skill, 12 tasks × 5 repetitions × 2 configurations', () => {
  it('reproduces the design: 0.633, 0.850, +0.217, [+0.117, +0.333], better', () => {
    const svn = data.seed('skillVsNoSkill');
    const stats = computed(statsOf(svn));

    expect(stats.baseline).toEqual({ passed: 38, counted: 60, rate: 38 / 60 });
    expect(stats.candidate).toEqual({ passed: 51, counted: 60, rate: 51 / 60 });
    expect(stats.baseline.rate).toBeCloseTo(0.633, 3);
    expect(stats.candidate.rate).toBeCloseTo(0.85, 3);
    expect(stats.observedDelta).toBeCloseTo(13 / 60, 12);
    expect(stats.observedDelta).toBeCloseTo(0.217, 3);
    // Within 0.02 of the design's interval, as plan 10.4 asks…
    expect(Math.abs(stats.lo - 0.117)).toBeLessThan(0.02);
    expect(Math.abs(stats.hi - 0.333)).toBeLessThan(0.02);
    // …and, with this experiment's seed, exactly it: 7/60 and 20/60.
    expect(stats.lo).toBeCloseTo(7 / 60, 12);
    expect(stats.hi).toBeCloseTo(20 / 60, 12);
    expect(stats.taskCounts).toEqual({ improved: 8, regressed: 0, unchanged: 4 });
    expect(stats).toMatchObject({
      verdict: 'better',
      provisional: false,
      resamples: 10_000,
      confidence: 0.95,
    });
  });

  it('agrees with the web comparison of the same experiment', () => {
    const svn = data.seed('skillVsNoSkill');
    const stats = computed(statsOf(svn));
    const view = data.comparisonView(svn, 'with-skill');
    const design = view.statistics!;

    expect(stats.observedDelta).toBeCloseTo(design.observedDelta, 3);
    expect(stats.lo).toBeCloseTo(design.lo, 3);
    expect(stats.hi).toBeCloseTo(design.hi, 3);
    expect(stats.verdict).toBe(design.verdict);
    expect(view.filterCounts).toEqual({ all: 12, ...stats.taskCounts });
    for (const row of view.rows) {
      const task = stats.tasks.find((t) => t.taskKey === row.taskKey)!;
      expect(task.delta).toBeCloseTo(row.delta!, 2);
      expect(task.change).toBe(row.change);
    }
  });

  it('keeps the secondary metrics the brief states', () => {
    const { secondary } = statsOf(data.seed('skillVsNoSkill'));
    expect(secondary.baseline.medianDurationS).toBe(48);
    expect(secondary.candidate.medianDurationS).toBe(61);
    expect(secondary.baseline.meanTokens).toBeCloseTo(14_200, 6);
    expect(secondary.candidate.meanTokens).toBeCloseTo(19_800, 6);
    expect(secondary.difference.medianDurationS).toBe(13);
    expect(secondary.difference.meanTokensPct).toBeCloseTo((5_600 / 14_200) * 100, 9);
    // disputed · baseline · rep 4 timed out; two baseline answers were ungradable.
    expect(secondary.baseline).toMatchObject({
      executionErrors: 1,
      executionErrorCategories: ['timeout'],
      ungradable: 2,
    });
    expect(secondary.candidate).toMatchObject({
      executionErrors: 0,
      executionErrorCategories: [],
      ungradable: 0,
    });
    expect(secondary.difference).toMatchObject({ executionErrors: -1, ungradable: -2 });
  });

  it('counts an execution error as not passed: the retried run that then failed changes nothing', () => {
    // multi-attempt: disputed · baseline · rep 4 was an execution error and failed on retry.
    const before = computed(statsOf(data.seed('skillVsNoSkill')));
    const after = computed(statsOf(data.seed('skillVsNoSkill', 'multi-attempt')));
    expect(after.baseline).toEqual(before.baseline);
    expect([after.observedDelta, after.lo, after.hi]).toEqual([
      before.observedDelta,
      before.lo,
      before.hi,
    ]);
    expect(after.verdict).toBe('better');
    // The sensitivity figure does see the difference: the error was left out, the failure is kept.
    expect(before.sensitivity!.excludedBaseline.executionErrors).toBe(1);
    expect(after.sensitivity!.excludedBaseline.executionErrors).toBe(0);
  });
});

describe('plan 10.4: Flow B, the MCP smoke test (3 repetitions)', () => {
  it('is inconclusive: the interval straddles 0', () => {
    const stats = computed(statsOf(data.seed('mcpSmoke')));
    expect(stats.observedDelta).toBeCloseTo(2 / 36, 12);
    expect(stats.lo).toBeLessThan(0);
    expect(stats.hi).toBeGreaterThan(0);
    expect(stats.verdict).toBe('inconclusive');
    expect(stats.taskCounts).toEqual({ improved: 2, regressed: 2, unchanged: 8 });
  });

  it('stays inconclusive after the retry of its execution error (verdict-updated)', () => {
    const stats = computed(statsOf(data.seed('mcpSmoke', 'verdict-updated')));
    expect(stats.observedDelta).toBeCloseTo(1 / 12, 12);
    expect(stats.verdict).toBe('inconclusive');
    // Nothing is left to exclude once the error was retried into a pass.
    expect(stats.sensitivity).toBeNull();
  });

  it('lists every execution-error category it saw, in vocabulary order (token-cap)', () => {
    // currency_mix · rep 2 timed out; vat_split · rep 3 hit the token cap.
    const { secondary } = statsOf(data.seed('mcpSmoke', 'token-cap'));
    expect(secondary.candidate.executionErrors).toBe(2);
    expect(secondary.candidate.executionErrorCategories).toEqual(['timeout', 'limit']);
  });
});

describe('every fixture scenario', () => {
  const close = (a: number | null, b: number | null, digits: number) =>
    a === null || b === null ? a === b : Math.abs(a - b) <= 0.5 * 10 ** -digits + 1e-12;

  it('computes, refuses, counts and flags exactly where the web comparison does', () => {
    let compared = 0;
    for (const scenario of [null, ...data.scenarios]) {
      for (const seed of data.seeds(scenario)) {
        for (const [candidate, key] of seed.candidates.flatMap((c) =>
          ['primary', 'any_failed'].map((k) => [c, k] as const),
        )) {
          const where = `${scenario ?? 'default'} · ${seed.key} · ${candidate} · ${key}`;
          const input: StatsInput = data.statsInput(seed, candidate, key);
          // Another key's interval is not compared (the fixtures' is a stand-in): fewer resamples do.
          const stats = computeComparisonStats(input, {
            seed: seedFromExperimentId(seed.id),
            ...(key === 'primary' ? {} : { resamples: 200 }),
          });
          const view = data.comparisonView(seed, candidate, key);
          compared += 1;

          expect(stats.computable, where).toBe(view.statistics !== null);
          if (stats.computable) {
            // On the primary key the fixtures state the design's figures; on another
            // they compute Δ and set a stand-in interval around it.
            if (key === 'primary') expect(stats.verdict, where).toBe(view.statistics!.verdict);
            else
              expect(close(stats.observedDelta, view.statistics!.observedDelta, 3), where).toBe(
                true,
              );
          } else {
            expect(stats.reason, where).toBe(view.statisticsUnavailable!.reason);
            // Settled experiments get a sentence of their own (compute.ts, messageOf).
            if (input.provisional || stats.reason === 'single_repetition') {
              expect(stats.message, where).toBe(view.statisticsUnavailable!.message);
            }
          }
          expect(close(stats.baseline.rate, view.passRates.baseline, 3), where).toBe(true);
          expect(close(stats.candidate.rate, view.passRates.candidate, 3), where).toBe(true);
          expect(
            {
              baseline: [stats.baseline.passed, stats.baseline.counted],
              candidate: [stats.candidate.passed, stats.candidate.counted],
            },
            where,
          ).toEqual({
            baseline: [view.passCounts.baseline.passed, view.passCounts.baseline.counted],
            candidate: [view.passCounts.candidate.passed, view.passCounts.candidate.counted],
          });
          const ungradable = [
            stats.secondary.baseline.ungradable,
            stats.secondary.candidate.ungradable,
          ];
          expect(ungradable, where).toEqual(view.secondary.map((r) => r.ungradable));
          for (const row of view.rows) {
            const task = stats.tasks.find((t) => t.taskKey === row.taskKey)!;
            expect(close(task.baseline.rate, row.passBaseline, 2), where).toBe(true);
            expect(close(task.candidate.rate, row.passCandidate, 2), where).toBe(true);
            if (seed.repetitions > 1) expect(task.change, where).toBe(row.change);
          }

          expect(stats.sensitivity === null, where).toBe(view.sensitivity === null);
          if (stats.sensitivity && view.sensitivity) {
            expect(stats.sensitivity.excludedBaseline, where).toEqual(
              view.sensitivity.excludedBaseline,
            );
            expect(stats.sensitivity.excludedCandidate, where).toEqual(
              view.sensitivity.excludedCandidate,
            );
            expect(close(stats.sensitivity.delta, view.sensitivity.delta, 3), where).toBe(true);
            expect(stats.sensitivity.baseline.passed, where).toBe(view.sensitivity.baseline.passed);
            expect(stats.sensitivity.candidate.passed, where).toBe(
              view.sensitivity.candidate.passed,
            );
            if (key === 'primary') {
              expect(stats.sensitivity.verdict, where).toBe(view.sensitivity.verdict);
            }
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(200);
  });
});

describe('the selected key', () => {
  it('grades by a named key every task has, the way the web grid does', () => {
    const svn = data.seed('skillVsNoSkill');
    const stats = computed(statsOf(svn, 'with-skill', 'answer'));
    const view = data.comparisonView(svn, 'with-skill', 'answer');
    // `answer` is every invoices-v1 task's primary key: the same figure as `primary`.
    expect(stats.observedDelta).toBeCloseTo(13 / 60, 12);
    for (const row of view.rows) {
      const task = stats.tasks.find((t) => t.taskKey === row.taskKey)!;
      expect(task.baseline.rate).toBeCloseTo(row.passBaseline!, 2);
      expect(task.candidate.rate).toBeCloseTo(row.passCandidate!, 2);
    }
  });

  it('under any_failed passes a run only when none of its keys failed, errored or was ungradable', () => {
    const svn = data.seed('skillVsNoSkill');
    const stats = computed(statsOf(svn, 'with-skill', 'any_failed'));
    const view = data.comparisonView(svn, 'with-skill', 'any_failed');
    expect(stats.baseline.passed).toBeLessThan(38);
    expect(stats.candidate.passed).toBeLessThan(51);
    for (const row of view.rows) {
      const task = stats.tasks.find((t) => t.taskKey === row.taskKey)!;
      expect(task.baseline.rate).toBeCloseTo(row.passBaseline!, 2);
      expect(task.candidate.rate).toBeCloseTo(row.passCandidate!, 2);
      expect(task.change).toBe(row.change);
    }
    // credit_notes · with-skill · rep 4 passed its primary key, but its `method` key errored.
    expect(stats.sensitivity!.excludedCandidate).toEqual({
      executionErrors: 0,
      ungradable: 0,
      error: 1,
    });
    const primary = computed(statsOf(svn));
    expect(primary.sensitivity!.excludedCandidate.error).toBe(0);
  });
});

describe('determinism', () => {
  it('gives the same result for the same input and seed, every time', () => {
    const svn = data.seed('mcpSmoke');
    const first = statsOf(svn);
    const again = computeComparisonStats(structuredClone(data.statsInput(svn)), {
      seed: seedFromExperimentId(svn.id),
    });
    expect(again).toEqual(first);
  });

  it('resamples differently for different experiment ids', () => {
    const input = data.statsInput(data.seed('mcpSmoke'));
    const deltas = computed(statsOf(data.seed('mcpSmoke'))).tasks.map((t) => t.delta!);
    const a = bootstrapMeans(deltas, 10_000, seedFromExperimentId('exp_01JBCMCPSM'));
    const b = bootstrapMeans(deltas, 10_000, seedFromExperimentId('exp_01JBCMCPSN'));
    expect(Array.from(a)).not.toEqual(Array.from(b));
    // The same data under another seed still lands on a nearby interval.
    const other = computed(
      computeComparisonStats(input, { seed: seedFromExperimentId('exp_01JBCMCPSN') }),
    );
    expect(other.verdict).toBe('inconclusive');
  });
});

describe('speed', () => {
  it('runs 10,000 resamples over 12 tasks, sensitivity included, well under 100 ms', () => {
    const input = data.statsInput(data.seed('skillVsNoSkill'));
    const options = { seed: seedFromExperimentId('exp_01JBB7SVNS') };
    const started = performance.now();
    const stats = computeComparisonStats(input, options);
    const elapsed = performance.now() - started;
    expect(stats.computable && stats.sensitivity?.lo !== null).toBe(true);
    expect(elapsed).toBeLessThan(100);
  });
});
