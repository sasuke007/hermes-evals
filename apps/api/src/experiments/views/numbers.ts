/**
 * Small numeric rules every experiment figure follows, so the list, the
 * Overview and the live counts round the same way.
 */
import { RUN_STATUSES, type ExperimentStatus, type RunCounts } from '@hermes-evals/shared';
import type { AttemptFacts } from './facts.js';

/** Rates and mean scores: three decimals, as the configuration usage list rounds them. */
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Money: six decimals, the precision of attempts.cost_usd (numeric(12,6)). */
export const round6 = (x: number): number => Math.round(x * 1_000_000) / 1_000_000;

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Run counts with every status present, all 0. */
export const emptyCounts = (): RunCounts =>
  Object.fromEntries(RUN_STATUSES.map((s) => [s, 0])) as RunCounts;

/** Running or paused: the experiment still has work to do and estimates make sense. */
export const isLive = (status: ExperimentStatus): boolean =>
  status === 'running' || status === 'paused';

/** Runs that have not finished execution: they still need a worker. */
export const waitingRuns = (counts: RunCounts): number => counts.queued + counts.running;

/**
 * What the progress bar counts as done (ExperimentListRow.doneRuns). Running
 * or paused: scored runs. Completed or failed: every settled run (scored,
 * execution_error, cancelled), so a finished experiment's bar is full and a
 * breaker-stopped one counts its errors.
 */
export const doneRuns = (status: ExperimentStatus, counts: RunCounts): number =>
  isLive(status) ? counts.scored : counts.scored + counts.execution_error + counts.cancelled;

/**
 * How long a finished attempt ran, in seconds: its recorded duration, else
 * the time between its start and end. Null while it runs.
 */
export function attemptSeconds(attempt: AttemptFacts | null): number | null {
  if (attempt === null || attempt.finishedAt === null) return null;
  const ms = attempt.durationMs ?? attempt.finishedAt.getTime() - attempt.startedAt.getTime();
  return Math.max(0, ms) / 1000;
}
