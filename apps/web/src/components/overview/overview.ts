/**
 * The words and numbers of the experiment Overview, worked out once from the view model
 * (OverviewRunning, OverviewComplete, ExperimentStates, Components 2 › VerdictCard and
 * ProgressBreakdown). Pure functions, so the panels stay thin and the sentences are tested in
 * one place.
 */
import type {
  ConfigAggregate,
  ConfigProgress,
  ExperimentDetail,
  NotComputableReason,
  RunCounts,
  VerdictHistoryEntry,
  VerdictSummary,
} from '@/api/types/experiments';
import type { ProgressSegment } from '@/components/ui/types';
import {
  formatClock,
  formatDateTime,
  formatDuration,
  formatRate,
  formatSigned,
  plural,
} from '@/lib/format';
import type { Tone } from '@/lib/statusTones';
import type { RunStatus } from '@hermes-evals/shared';

/** Durations in the feed and the Runs table are whole seconds: "44 s", "300 s". */
export function formatSeconds(seconds: number | null | undefined): string {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? `${Math.round(seconds).toLocaleString('en-US')} s`
    : '–';
}

/** "≈ 10 min" for the Remaining (est.) stat; hours as 1h 05m. */
export function formatRemaining(seconds: number | null): string {
  if (seconds === null) return '–';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `≈ ${Math.max(1, minutes)} min`;
  return `≈ ${formatDuration(seconds)}`;
}

/** The selected tasks of the experiment (the suite may hold more). */
export function taskCount(detail: ExperimentDetail): number {
  return detail.suite.tasks.length;
}

/**
 * The caption under the title, after "baseline vs with-mcp":
 *   running   "12 tasks × 2 configurations × 5 repetitions · launched 23 Oct 14:52"
 *   complete  "12 tasks × 2 configurations × 5 repetitions = 120 runs · concurrency 3 ·
 *              finished 22 Oct 10:51, took 37m 04s"
 */
export function metaTail(detail: ExperimentDetail): string {
  const shape = [
    plural(taskCount(detail), 'task'),
    plural(1 + detail.candidates.length, 'configuration'),
    plural(detail.repetitions, 'repetition'),
  ].join(' × ');
  if (detail.status === 'completed') {
    const finished = detail.finishedAt ? `finished ${formatDateTime(detail.finishedAt)}, ` : '';
    return `${shape} = ${plural(detail.totalRuns, 'run')} · concurrency ${detail.concurrency} · ${finished}took ${formatDuration(detail.elapsedS)}`;
  }
  return `${shape} · launched ${formatDateTime(detail.createdAt)}`;
}

/** Runs not yet finished: what Cancel stops or waits for. */
export function unfinished(counts: RunCounts): number {
  return counts.queued + counts.running + counts.executed + counts.scoring;
}

/**
 * The cancel confirmation (OverviewRunning): the question with the number in it, and what is
 * lost and kept. Executed and scoring runs finish scoring (plan 7.3); only running ones stop.
 */
export function cancelSummary(counts: RunCounts): { title: string; consequence: string } {
  const n = unfinished(counts);
  const parts: string[] = [];
  if (counts.queued) {
    parts.push(`${plural(counts.queued, 'queued run')} will not start.`);
  }
  if (counts.running) {
    parts.push(
      `${plural(counts.running, 'running run')} ${counts.running === 1 ? 'is' : 'are'} stopped and marked cancelled.`,
    );
  }
  const scoring = counts.executed + counts.scoring;
  if (scoring) {
    parts.push(
      `${plural(scoring, 'run')} being scored ${scoring === 1 ? 'finishes' : 'finish'} scoring.`,
    );
  }
  const kept = [plural(counts.scored, 'scored run')];
  if (counts.execution_error) kept.push(`${counts.execution_error} execution_error`);
  const verb = kept.length > 1 || counts.scored !== 1 ? 'are' : 'is';
  parts.push(
    `The ${kept.join(' and ')} ${verb} kept, and the comparison is computed from what has finished. This cannot be resumed.`,
  );
  return { title: `Cancel ${plural(n, 'unfinished run')}?`, consequence: parts.join(' ') };
}

/** One status of the progress breakdown: its share of the bar and its legend entry. */
export interface PipelineSegment extends ProgressSegment {
  status: RunStatus;
  value: number;
}

const PIPELINE: { status: RunStatus; tone: Tone; pattern?: 'hatch'; pulse?: boolean }[] = [
  { status: 'scored', tone: 'pass' },
  { status: 'execution_error', tone: 'err' },
  { status: 'cancelled', tone: 'que' },
  { status: 'scoring', tone: 'run', pulse: true },
  { status: 'executed', tone: 'run' },
  { status: 'running', tone: 'run', pulse: true },
  { status: 'queued', tone: 'que', pattern: 'hatch' },
];

/**
 * The breakdown in pipeline order (Components 2 › ProgressBreakdown): scored, execution_error,
 * scoring, executed, running, queued; cancelled after the errors, only when there are any.
 * `live` false (paused, stream lost) stops the pulse.
 */
export function pipelineSegments(counts: RunCounts, live = true): PipelineSegment[] {
  return PIPELINE.filter((p) => p.status !== 'cancelled' || counts.cancelled > 0).map((p) => ({
    status: p.status,
    value: counts[p.status],
    tone: p.tone,
    pattern: p.pattern ?? 'solid',
    pulse: live && !!p.pulse,
    label: `${p.status} ${counts[p.status]}`,
  }));
}

/** A configuration's thin bar: scored, errors, in flight, queued (OverviewRunning). */
export function configSegments(progress: ConfigProgress): ProgressSegment[] {
  const c = progress.counts;
  const segments: ProgressSegment[] = [
    { value: c.scored, tone: 'pass', label: `scored ${c.scored}` },
    { value: c.execution_error, tone: 'err', label: `execution_error ${c.execution_error}` },
    {
      value: c.running + c.executed + c.scoring,
      tone: 'run',
      label: `in flight ${c.running + c.executed + c.scoring}`,
    },
    { value: c.queued, tone: 'que', pattern: 'hatch', label: `queued ${c.queued}` },
    { value: c.cancelled, tone: 'que', label: `cancelled ${c.cancelled}` },
  ];
  return segments.filter((s) => s.value > 0);
}

/**
 * "46 scored · 2 running · 12 queued · 0 execution errors · provisional pass rate 0.630", or
 * with errors "41 scored · 1 execution_error · 1 running · 1 scoring · 16 queued · …".
 */
export function configDetailLine(progress: ConfigProgress): string {
  const c = progress.counts;
  const parts = [`${c.scored} scored`];
  if (c.execution_error) parts.push(`${c.execution_error} execution_error`);
  for (const status of ['running', 'scoring', 'executed', 'queued', 'cancelled'] as const) {
    if (c[status]) parts.push(`${c[status]} ${status}`);
  }
  if (!c.execution_error) parts.push('0 execution errors');
  parts.push(`provisional pass rate ${formatRate(progress.provisionalPassRate)}`);
  return parts.join(' · ');
}

/** "[+0.117, +0.333]". */
export function intervalText(lo: number | null, hi: number | null): string {
  return lo === null || hi === null ? 'no interval' : `[${formatSigned(lo)}, ${formatSigned(hi)}]`;
}

/** Why a VerdictCard has no interval, in the dashed box where the interval would be. */
export function notComputableSentence(reason: NotComputableReason | null): string {
  switch (reason) {
    case 'single_repetition':
      return 'Needs at least 2 repetitions per task to compute an interval.';
    case 'too_few_tasks':
      return 'Needs at least 3 tasks to compute an interval: the interval resamples the tasks.';
    case 'nothing_scored':
      return 'Nothing is scored yet on either side.';
    case 'not_enough_runs':
      return 'Needs at least 2 counted runs per task and configuration to compute an interval.';
    default:
      return 'No interval yet.';
  }
}

/**
 * The VerdictCard's history line once a verdict was recomputed (Flow B):
 * "Updated 23 Oct 14:20 after 1 retry · previously +0.056 [−0.083, +0.194]". Null with a
 * single entry.
 */
export function historyLine(history: VerdictHistoryEntry[]): string | null {
  if (history.length < 2) return null;
  const last = history[history.length - 1];
  const previous = history[history.length - 2];
  if (!last || !previous) return null;
  const why = last.note ? `after ${last.note}` : `after a ${last.cause}`;
  const was =
    previous.delta === null
      ? previous.verdict.replace('_', ' ')
      : `${formatSigned(previous.delta)} ${intervalText(previous.lo, previous.hi)}`.replace(
          ' no interval',
          '',
        );
  return `Updated ${formatDateTime(last.at)} ${why} · previously ${was}`;
}

/** "The interval lies entirely above zero, so with-skill is better on invoices-v1 at 95% …". */
export function verdictSentence(verdict: VerdictSummary, suiteName: string): string | null {
  const confidence = `${Math.round(verdict.method.confidence * 100)}%`;
  const name = verdict.candidate.name;
  switch (verdict.verdict) {
    case 'better':
      return `The interval lies entirely above zero, so ${name} is better on ${suiteName} at ${confidence} confidence.`;
    case 'worse':
      return `The interval lies entirely below zero, so ${name} is worse on ${suiteName} at ${confidence} confidence.`;
    case 'inconclusive':
      return `The interval crosses zero, so this experiment cannot tell whether ${name} is better or worse on ${suiteName}.`;
    default:
      return null;
  }
}

/**
 * "Before acting on it, check the costs: the candidate is also 13 s slower and uses 39% more
 * tokens per run." From the aggregates of the two configurations; null when they are missing.
 */
export function costSentence(
  baseline: ConfigAggregate | undefined,
  candidate: ConfigAggregate | undefined,
): string | null {
  if (!baseline || !candidate) return null;
  const clauses: string[] = [];
  const bd = baseline.medianDurationS;
  const cd = candidate.medianDurationS;
  if (bd !== null && cd !== null) {
    const diff = Math.round(cd - bd);
    clauses.push(
      `is also ${diff === 0 ? 'as fast' : `${Math.abs(diff)} s ${diff > 0 ? 'slower' : 'faster'}`}`,
    );
  }
  const bt = baseline.meanTokens;
  const ct = candidate.meanTokens;
  if (bt && ct !== null) {
    const pct = Math.round((ct / bt - 1) * 100);
    clauses.push(
      pct === 0
        ? 'uses as many tokens per run'
        : `uses ${Math.abs(pct)}% ${pct > 0 ? 'more' : 'fewer'} tokens per run`,
    );
  }
  if (!clauses.length) return null;
  return `Before acting on it, check the costs: the candidate ${clauses.join(' and ')}.`;
}

/** "Based on 87 of 120 runs scored so far. The interval will change." */
export function provisionalLine(detail: ExperimentDetail): string {
  return `Based on ${detail.counts.scored} of ${detail.totalRuns} runs scored so far. The interval will change.`;
}

/** "hermes-agent v0.22.4 @ 4d04303": the revision as its first 7 characters. */
export function hermesLabel(detail: ExperimentDetail): string {
  const { package: pkg, version, revision } = detail.hermes;
  return `${pkg} ${version} @ ${revision.slice(0, 7)}`;
}

/** The suite's tasks in this experiment: "all 12 tasks" or "11 of 12 tasks". */
export function suiteTasksLabel(detail: ExperimentDetail): string {
  const n = taskCount(detail);
  return n === detail.suite.taskCount
    ? `all ${plural(n, 'task')}`
    : `${n} of ${plural(detail.suite.taskCount, 'task')}`;
}

/** "15:08": a time of day to the minute, for the pause lines. */
export function formatHourMinute(value: string | null): string {
  return value ? formatClock(value).slice(0, 5) : '–';
}
