import { beforeEach, describe, expect, it } from 'vitest';
import { EXPERIMENT_IDS, getExperiment } from '@/api/experiments';
import { setScenario } from '@/api/__tests__/scenario';
import type { RunCounts } from '@/api/types/experiments';
import {
  cancelSummary,
  configDetailLine,
  costSentence,
  formatRemaining,
  formatSeconds,
  historyLine,
  metaTail,
  notComputableSentence,
  pipelineSegments,
  provisionalLine,
  verdictSentence,
} from '../overview';

beforeEach(() => setScenario(null));

const counts = (c: Partial<RunCounts>): RunCounts => ({
  queued: 0,
  running: 0,
  executed: 0,
  scoring: 0,
  scored: 0,
  execution_error: 0,
  cancelled: 0,
  ...c,
});

describe('the Overview words and numbers', () => {
  it('writes the header caption running and complete (OverviewRunning, OverviewComplete)', async () => {
    const running = await getExperiment(EXPERIMENT_IDS.mcpVsBaseline);
    expect(metaTail(running)).toBe(
      '12 tasks × 2 configurations × 5 repetitions · launched 23 Oct 14:52',
    );
    const complete = await getExperiment(EXPERIMENT_IDS.skillVsNoSkill);
    expect(metaTail(complete)).toBe(
      '12 tasks × 2 configurations × 5 repetitions = 120 runs · concurrency 3 · finished 22 Oct 10:51, took 37m 04s',
    );
  });

  it('asks before cancelling with the numbers of the board', () => {
    const { title, consequence } = cancelSummary(
      counts({ queued: 28, running: 3, scoring: 1, scored: 87, execution_error: 1 }),
    );
    expect(title).toBe('Cancel 32 unfinished runs?');
    expect(consequence).toBe(
      '28 queued runs will not start. 3 running runs are stopped and marked cancelled. 1 run being scored finishes scoring. The 87 scored runs and 1 execution_error are kept, and the comparison is computed from what has finished. This cannot be resumed.',
    );
  });

  it('orders the breakdown as the pipeline, hatching the queue and pulsing live work', () => {
    const segments = pipelineSegments(
      counts({ queued: 28, running: 3, scoring: 1, scored: 87, execution_error: 1 }),
    );
    expect(segments.map((s) => `${s.status} ${s.value}`)).toEqual([
      'scored 87',
      'execution_error 1',
      'scoring 1',
      'executed 0',
      'running 3',
      'queued 28',
    ]);
    expect(segments.find((s) => s.status === 'queued')?.pattern).toBe('hatch');
    expect(segments.filter((s) => s.pulse).map((s) => s.status)).toEqual(['scoring', 'running']);
    expect(pipelineSegments(counts({ cancelled: 2 }), false).some((s) => s.pulse)).toBe(false);
    expect(pipelineSegments(counts({ cancelled: 2 })).map((s) => s.status)).toContain('cancelled');
  });

  it('writes each configuration line as the board does', async () => {
    const e = await getExperiment(EXPERIMENT_IDS.mcpVsBaseline);
    expect(e.perConfiguration.map(configDetailLine)).toEqual([
      '46 scored · 2 running · 12 queued · 0 execution errors · provisional pass rate 0.630',
      '41 scored · 1 execution_error · 1 running · 1 scoring · 16 queued · provisional pass rate 0.683',
    ]);
  });

  it('reads the verdict and the cost of acting on it (OverviewComplete)', async () => {
    const e = await getExperiment(EXPERIMENT_IDS.skillVsNoSkill);
    const v = e.verdicts[0]!;
    expect(verdictSentence(v, e.suite.name)).toBe(
      'The interval lies entirely above zero, so with-skill is better on invoices-v1 at 95% confidence.',
    );
    expect(costSentence(e.aggregates[0], e.aggregates[1])).toBe(
      'Before acting on it, check the costs: the candidate is also 13 s slower and uses 39% more tokens per run.',
    );
  });

  it('says when a verdict was recomputed (Flow B)', async () => {
    setScenario('verdict-updated');
    const e = await getExperiment(EXPERIMENT_IDS.mcpSmoke);
    expect(historyLine(e.verdicts[0]!.history)).toBe(
      'Updated 23 Oct 14:20 after 1 retry · previously +0.056 [−0.111, +0.250]',
    );
    setScenario(null);
    const once = await getExperiment(EXPERIMENT_IDS.mcpSmoke);
    expect(historyLine(once.verdicts[0]!.history)).toBeNull();
  });

  it('explains a missing interval and the provisional figures', async () => {
    expect(notComputableSentence('single_repetition')).toBe(
      'Needs at least 2 repetitions per task to compute an interval.',
    );
    expect(notComputableSentence('too_few_tasks')).toContain('at least 3 tasks');
    const e = await getExperiment(EXPERIMENT_IDS.mcpVsBaseline);
    expect(provisionalLine(e)).toBe(
      'Based on 87 of 120 runs scored so far. The interval will change.',
    );
  });

  it('formats the remaining time and whole-second durations', () => {
    expect(formatRemaining(600)).toBe('≈ 10 min');
    expect(formatRemaining(20)).toBe('≈ 1 min');
    expect(formatRemaining(3900)).toBe('≈ 1h 05m');
    expect(formatRemaining(null)).toBe('–');
    expect(formatSeconds(300)).toBe('300 s');
    expect(formatSeconds(null)).toBe('–');
  });
});
