/**
 * Time on the Overview header: how long the experiment has run and how long
 * the rest should take (plan 7.2). Estimates use what this experiment has
 * measured so far, falling back to what the launch estimated.
 */
import type { ExperimentEstimate, ExperimentStatus, RunCounts } from '@hermes-evals/shared';
import { effectiveBudgetS } from '../../execution/budget.js';
import type { ConfigFacts, RunFacts } from './facts.js';
import { attemptSeconds, isLive, median, waitingRuns } from './numbers.js';

export interface TimeInput {
  status: ExperimentStatus;
  concurrency: number;
  counts: RunCounts;
  estimate: ExperimentEstimate | null;
  runs: readonly RunFacts[];
  configs: readonly ConfigFacts[];
  timeBudgetOverrideS: number | null;
}

/**
 * Seconds one run takes: the median of this experiment's finished attempts,
 * else the launch estimate's time per wave, else a quarter of the time
 * budget (plan 7.2's fallback).
 */
function perRunSeconds(input: TimeInput): number {
  const measured = median(
    input.runs.map((r) => attemptSeconds(r.attempt)).filter((s): s is number => s !== null),
  );
  if (measured !== null) return measured;
  const e = input.estimate;
  if (e && e.runs > 0 && e.duration_s > 0) {
    return e.duration_s / Math.ceil(e.runs / input.concurrency);
  }
  const budgets = input.configs.map((c) =>
    effectiveBudgetS(c.timeBudgetS, input.timeBudgetOverrideS),
  );
  return budgets.length === 0 ? 0 : budgets.reduce((a, b) => a + b, 0) / budgets.length / 4;
}

/**
 * Time left for the runs that still need a worker: ceil(waiting ÷
 * concurrency) waves of one run each (plan 7.2's formula), in whole seconds.
 * Null once the experiment has finished.
 */
export function remainingSeconds(input: TimeInput): number | null {
  if (!isLive(input.status)) return null;
  const waiting = waitingRuns(input.counts);
  if (waiting === 0) return 0;
  return Math.round(Math.ceil(waiting / input.concurrency) * perRunSeconds(input));
}

/**
 * Wall time since launch: until it finished, until it was paused, or until
 * now. A resumed experiment counts its pauses (they are not recorded).
 */
export function elapsedSeconds(
  e: { createdAt: Date; finishedAt: Date | null; pausedAt: Date | null },
  now: Date,
): number {
  const end = e.finishedAt ?? e.pausedAt ?? now;
  return Math.max(0, Math.round((end.getTime() - e.createdAt.getTime()) / 1000));
}
