/**
 * The words of the Experiment list (ExperimentList board): what the Verdict column says when
 * there is no verdict chip, each chip's tooltip, the progress bar's tone and label, and the
 * search filter. Kept apart from the components so they are tested on their own.
 */
import type {
  ExperimentListRow,
  ExperimentListVerdict,
  NotComputableReason,
} from '@/api/types/experiments';
import { formatSigned, MISSING, plural } from '@/lib/format';
import type { ProgressSegment } from '@/components/ui/types';

/** Tasks in the experiment: runs = tasks × configurations × repetitions. */
export function taskCountOf(row: ExperimentListRow): number {
  const perTask = row.repetitions * (1 + row.candidates.length);
  return perTask > 0 ? Math.round(row.totalRuns / perTask) : 0;
}

/** A verdict needs at least this many tasks (statistics MIN_TASKS, too_few_tasks). */
export const MIN_TASKS_FOR_VERDICT = 3;

/**
 * Why a chip or a row has no interval, in the list's short form: "No interval (1 rep)" as the
 * board words single_repetition, and the same pattern for the other reasons.
 */
export function noIntervalText(reason: NotComputableReason | null, row: ExperimentListRow): string {
  switch (reason) {
    case 'single_repetition':
      return 'No interval (1 rep)';
    case 'too_few_tasks':
      return `No interval (${plural(taskCountOf(row), 'task')})`;
    case 'nothing_scored':
      return 'No interval (nothing scored)';
    case 'not_enough_runs':
      return 'No interval (too few runs)';
    default:
      return 'No interval';
  }
}

/**
 * The Verdict column of a row without chips. A running or paused experiment reads
 * "Provisional", unless it can never have an interval (one repetition, fewer than 3 tasks);
 * a failed one has nothing to say.
 */
export function noVerdictText(row: ExperimentListRow): string {
  if (row.status === 'failed' || row.status === 'completed') return MISSING;
  if (row.repetitions === 1) return noIntervalText('single_repetition', row);
  if (taskCountOf(row) < MIN_TASKS_FOR_VERDICT) return noIntervalText('too_few_tasks', row);
  return 'Provisional';
}

/** A chip's tooltip: "Δ +0.217, 95% CI [+0.117, +0.333]". */
export function verdictTitle(verdict: ExperimentListVerdict): string {
  if (verdict.delta === null) return 'No difference computed yet';
  const delta = `Δ ${formatSigned(verdict.delta)}`;
  if (verdict.lo === null || verdict.hi === null) return `${delta}, no interval`;
  return `${delta}, 95% CI [${formatSigned(verdict.lo)}, ${formatSigned(verdict.hi)}]`;
}

/** The progress bar: scored runs while live, settled runs once finished (doneRuns). */
export function progressTone(row: ExperimentListRow): ProgressSegment['tone'] {
  switch (row.status) {
    case 'running':
      return 'run';
    case 'failed':
      return 'err';
    case 'paused':
      return 'que';
    default:
      return 'muted';
  }
}

export function progressLabel(row: ExperimentListRow): string {
  const live = row.status === 'running' || row.status === 'paused';
  return `${row.doneRuns} of ${row.totalRuns} runs ${live ? 'scored' : 'done'}`;
}

/** "Filter by name, suite or configuration": every word must appear in one of them. */
export function matchesSearch(row: ExperimentListRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    row.name,
    row.suite.name,
    `v${row.suite.versionNumber}`,
    row.baseline.name,
    ...row.candidates.map((c) => c.name),
  ]
    .join(' ')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** "6 experiments", "1 experiment". */
export function experimentCount(n: number): string {
  return plural(n, 'experiment');
}
