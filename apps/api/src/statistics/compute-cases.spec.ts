/**
 * The statistics on constructed inputs (./cases.support-spec.ts): every
 * not-computable reason and its sentence, and the counting rules (an
 * execution error is not passed, a cancelled run is not counted).
 */
import { describe, expect, it } from 'vitest';
import { computed, input, refused, stats } from './cases.support-spec.js';

describe('the gate', () => {
  it('refuses one repetition whatever has run, and says the pass rates', () => {
    const result = refused(
      stats(
        input([
          ['P', 'P'],
          ['F', 'P'],
          ['F', 'P'],
          ['P', 'F'],
        ]),
      ),
    );
    expect(result.reason).toBe('single_repetition');
    expect(result.message).toBe(
      'No interval with 1 repetition. Pass rates: baseline 0.50, with-skill 0.75 on 4 tasks. ' +
        'Run at least 2 repetitions for a verdict.',
    );
    expect(result.sensitivity).toBeNull();
    // The rates and changes are still there for the grid.
    expect(result.baseline.rate).toBe(0.5);
    expect(result.taskCounts).toEqual({ improved: 2, regressed: 1, unchanged: 1 });
    expect(result.observedDelta).toBe(0.25);
  });

  it('says nothing is scored until a run of the two configurations counts', () => {
    const empty = input(
      [
        ['', ''],
        ['', ''],
      ],
      {
        repetitions: 5,
        provisional: true,
        progress: { scored: 0, total: 20 },
      },
    );
    const running = refused(stats(empty));
    expect(running.reason).toBe('nothing_scored');
    expect(running.message).toBe(
      '0 of 20 runs scored. Rows fill in as runs are scored; the statistics panel appears once ' +
        'every task has at least 2 scored repetitions per configuration.',
    );
    expect(running.baseline).toEqual({ passed: 0, counted: 0, rate: null });
    expect(running.observedDelta).toBeNull();
    expect(running.tasks.every((t) => t.delta === null && t.change === null)).toBe(true);

    // Every run cancelled and the experiment over: nothing more will fill in.
    const cancelled = refused(stats({ ...empty, provisional: false, repetitions: 2 }));
    expect(cancelled.reason).toBe('nothing_scored');
    expect(cancelled.message).toBe('0 of 20 runs scored: there are no pass rates to compare.');
    expect(cancelled.sensitivity).toBeNull();
  });

  it('computes a pair whose runs all failed to execute: 0 against 0, whatever else scored', () => {
    // An execution error counts as a run that did not pass (plan 10.1), so the gate passes.
    const rows: [string, string][] = [
      ['EE', 'EE'],
      ['EE', 'EE'],
    ];
    const alone = computed(stats(input(rows)));
    expect(alone).toMatchObject({
      baseline: { passed: 0, counted: 4, rate: 0 },
      candidate: { passed: 0, counted: 4, rate: 0 },
      observedDelta: 0,
      lo: 0,
      hi: 0,
      verdict: 'inconclusive',
    });
    // Nothing answered, so the figure without execution errors has nothing to compare.
    expect(alone.sensitivity).toMatchObject({
      excludedBaseline: { executionErrors: 4, ungradable: 0, error: 0 },
      delta: null,
      verdict: 'not_computable',
      verdictChanges: true,
    });
    // A third configuration that scored runs of its own changes nothing for this pair.
    const beside = computed(stats(input(rows, { progress: { scored: 4, total: 12 } })));
    expect([beside.verdict, beside.lo, beside.hi]).toEqual([alone.verdict, alone.lo, alone.hi]);
  });

  it('waits for 2 counted runs of every task under each configuration', () => {
    const rows: [string, string][] = [
      ['PP', 'PP'],
      ['PF', 'P'],
      ['F', 'PP'],
      ['PP', 'PF'],
    ];
    const running = refused(stats(input(rows, { provisional: true })));
    expect(running.reason).toBe('not_enough_runs');
    expect(running.message).toBe(
      'The statistics panel appears once every task has at least 2 scored repetitions per configuration.',
    );
    // Nothing was excluded, so there is no sensitivity figure either.
    expect(running.sensitivity).toBeNull();

    const settled = refused(stats(input(rows)));
    expect(settled.message).toBe(
      'No interval: 2 tasks (task_2, task_3) counted fewer than 2 runs under a configuration, ' +
        'and cancelled runs do not count. A verdict needs at least 2 per task and configuration.',
    );
  });

  it('counts runs, not repetitions: a task whose runs were cancelled has too few', () => {
    // 5 repetitions, but 4 of task_2's candidate runs were cancelled and are not in the input.
    const result = refused(
      stats(
        input([
          ['PPPPP', 'PPPPP'],
          ['PFPFP', 'P'],
        ]),
      ),
    );
    expect(result.reason).toBe('not_enough_runs');
    expect(result.candidate).toEqual({ passed: 6, counted: 6, rate: 1 });
    expect(result.tasks[1]!.candidate).toEqual({ passed: 1, counted: 1, rate: 1 });
  });

  it('reports the kept runs beside a refusal when it excluded some', () => {
    const result = refused(
      stats(
        input([
          ['PE', 'PP'],
          ['PF', 'P'],
        ]),
      ),
    );
    expect(result.reason).toBe('not_enough_runs');
    expect(result.sensitivity).toMatchObject({
      excludedBaseline: { executionErrors: 1, ungradable: 0, error: 0 },
      lo: null,
      hi: null,
      verdict: 'not_computable',
      verdictChanges: false,
    });
  });
});

describe('counting', () => {
  it('counts an execution error as a run that did not pass', () => {
    const withErrors = computed(
      stats(
        input([
          ['PE', 'PP'],
          ['EE', 'PP'],
          ['PP', 'PP'],
        ]),
      ),
    );
    expect(withErrors.baseline).toEqual({ passed: 3, counted: 6, rate: 0.5 });
    expect(withErrors.tasks.map((t) => t.delta)).toEqual([0.5, 1, 0]);
    const asFailures = computed(
      stats(
        input([
          ['PF', 'PP'],
          ['FF', 'PP'],
          ['PP', 'PP'],
        ]),
      ),
    );
    expect([withErrors.observedDelta, withErrors.lo, withErrors.hi]).toEqual([
      asFailures.observedDelta,
      asFailures.lo,
      asFailures.hi,
    ]);
  });

  it('weighs every task the same, however many runs it counted', () => {
    const result = computed(
      stats(
        input([
          ['PPPP', 'PPPP'],
          ['FF', 'PP'],
        ]),
      ),
    );
    // Pooled, 6 of 6 against 4 of 6; per task, +0 and +1: the difference is +0.5.
    expect(result.observedDelta).toBe(0.5);
    expect(result.candidate.rate! - result.baseline.rate!).toBeCloseTo(1 / 3, 12);
  });

  it('reports ungradable and scorer-error runs as not passed, and separately', () => {
    const result = computed(
      stats(
        input([
          ['PUX', 'PPP'],
          ['PPF', 'PPP'],
        ]),
      ),
    );
    expect(result.baseline).toEqual({ passed: 3, counted: 6, rate: 0.5 });
    expect(result.secondary.baseline.ungradable).toBe(1);
    expect(result.sensitivity!.excludedBaseline).toEqual({
      executionErrors: 0,
      ungradable: 1,
      error: 1,
    });
  });
});
