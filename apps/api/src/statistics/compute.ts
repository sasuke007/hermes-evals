/**
 * The comparison statistics (plan 10.2): the observed difference, the paired
 * bootstrap interval, the verdict or why there is none, the sensitivity
 * figure and the secondary metrics, from a StatsInput (./contracts.ts).
 * Pure: no database, no clock, and the same input and seed always give the
 * same interval.
 *
 * The algorithm, as decided for Phase 4:
 * - pass rate of a task under a configuration = passed / counted runs, where
 *   an execution error counts as not passed and cancelled runs are not in
 *   the input (plan 10.1);
 * - observed difference: the mean over tasks of (candidate rate − baseline
 *   rate), each task weighing the same however many runs it counted;
 * - bootstrap: resample the task list with replacement `resamples` times
 *   (10,000), each task's runs kept together, and recompute the mean
 *   difference; the interval is the (1 − confidence) / 2 and
 *   (1 + confidence) / 2 percentiles (2.5th and 97.5th), with linear
 *   interpolation between order statistics (the common "type 7"
 *   definition). ./bootstrap.ts has the details;
 * - the PRNG is mulberry32, seeded with seedFromExperimentId(experimentId),
 *   so every comparison of one experiment and every verdict entry resample
 *   alike;
 * - verdict: better if lo > 0, worse if hi < 0, else inconclusive;
 *   provisional while the experiment is running, paused or failed
 *   (StatsInput.provisional: Retry failed runs can resume a failed one).
 *   Bounds within 1e-9 of 0 are 0 (./tally.ts);
 * - gate: computed only when the experiment selected at least 3 tasks and
 *   every task has at least 2 counted runs per configuration; otherwise
 *   not_computable with, in this order, single_repetition (repetitions = 1,
 *   whatever has run), too_few_tasks (1 or 2 tasks, whatever has run),
 *   nothing_scored (no run of the two configurations counts yet: an
 *   execution error counts, so a comparison whose runs all failed to
 *   execute is computed, as a difference of 0 against 0) or
 *   not_enough_runs, and the sentence the panel shows;
 * - sensitivity: the same difference and interval without execution errors
 *   and runs whose selected key is `error` or `ungradable`, with the same
 *   seed (so both intervals resample the same tasks), under the same gate;
 *   null when nothing was excluded, and with single_repetition or
 *   nothing_scored, where there is no main figure to set it beside;
 * - secondary metrics per configuration: duration, tokens, execution errors
 *   and ungradable runs over its counted runs, the cost over every attempt
 *   of the arm (./secondary.ts).
 *
 * The task gate (Phase 4 question 3): with one task the bootstrap can only
 * redraw that task, so the interval collapses to the observed difference,
 * and with two it takes three values; neither says how sure the difference
 * is.
 */
import { createHash } from 'node:crypto';
import type { NotComputableReason, VerdictState } from '@hermes-evals/shared';
import { bootstrapInterval } from './bootstrap.js';
import {
  DEFAULT_CONFIDENCE,
  DEFAULT_RESAMPLES,
  type ExcludedRuns,
  type PassTally,
  type SensitivityResult,
  type StatsBase,
  type StatsInput,
  type StatsOptions,
  type StatsResult,
  type StatsRun,
  type StatsTask,
  type TaskStats,
} from './contracts.js';
import { secondaryDifference, secondaryMetrics } from './secondary.js';
import {
  changeOf,
  cleanZero,
  everyTaskHas,
  meanDelta,
  pooledTally,
  rateDelta,
  tallyOf,
  verdictOf,
} from './tally.js';

export { suggestRepetitions } from './repetitions.js';

/** A verdict needs this many counted runs of every task under each configuration. */
export const MIN_RUNS_PER_TASK = 2;

/** A verdict needs this many selected tasks: the bootstrap resamples tasks. */
export const MIN_TASKS = 3;

interface ResolvedOptions {
  seed: number;
  resamples: number;
  confidence: number;
}

function resolveOptions(options: StatsOptions): ResolvedOptions {
  const { seed } = options;
  const resamples = options.resamples ?? DEFAULT_RESAMPLES;
  const confidence = options.confidence ?? DEFAULT_CONFIDENCE;
  if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
    throw new RangeError(`seed must be an unsigned 32-bit integer, got ${seed}`);
  }
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new RangeError(`resamples must be a positive integer, got ${resamples}`);
  }
  if (!(confidence > 0 && confidence < 1)) {
    throw new RangeError(`confidence must be in (0, 1), got ${confidence}`);
  }
  return { seed, resamples, confidence };
}

/** Everything the comparison shows from the statistics, for one candidate against the baseline. */
export function computeComparisonStats(input: StatsInput, options: StatsOptions): StatsResult {
  const opts = resolveOptions(options);
  if (!Number.isInteger(input.repetitions) || input.repetitions < 1) {
    throw new RangeError(`repetitions must be a positive integer, got ${input.repetitions}`);
  }
  const tasks = input.tasks.map(taskStats);
  const baseline = pooledTally(input.tasks.map((t) => t.baseline));
  const candidate = pooledTally(input.tasks.map((t) => t.candidate));
  const reason = gateOf(input);
  const interval =
    reason === null
      ? boundsOf(
          tasks.map((t) => t.delta),
          opts,
        )
      : null;
  const mainVerdict: VerdictState =
    interval === null ? 'not_computable' : verdictOf(interval.lo, interval.hi, input.provisional);

  const secondaryBaseline = secondaryMetrics(
    input.tasks.flatMap((t) => t.baseline),
    input.costUsd.baseline,
  );
  const secondaryCandidate = secondaryMetrics(
    input.tasks.flatMap((t) => t.candidate),
    input.costUsd.candidate,
  );
  const base: StatsBase = {
    baseline,
    candidate,
    tasks,
    taskCounts: {
      improved: tasks.filter((t) => t.change === 'improved').length,
      regressed: tasks.filter((t) => t.change === 'regressed').length,
      unchanged: tasks.filter((t) => t.change === 'unchanged').length,
    },
    observedDelta: meanDelta(tasks.map((t) => t.delta)),
    sensitivity:
      reason === 'single_repetition' || reason === 'nothing_scored'
        ? null
        : sensitivityOf(input, mainVerdict, opts),
    secondary: {
      baseline: secondaryBaseline,
      candidate: secondaryCandidate,
      difference: secondaryDifference(secondaryBaseline, secondaryCandidate),
    },
  };

  if (reason !== null) {
    return {
      ...base,
      computable: false,
      reason,
      message: messageOf(reason, input, baseline, candidate),
    };
  }
  // The gate passed: the interval exists and every task counted runs on both sides.
  const { lo, hi } = interval!;
  return {
    ...base,
    computable: true,
    observedDelta: base.observedDelta!,
    lo,
    hi,
    resamples: opts.resamples,
    confidence: opts.confidence,
    verdict: verdictOf(lo, hi, input.provisional),
    provisional: input.provisional,
  };
}

/**
 * The bootstrap interval of the mean of the tasks' differences. Bounds in
 * float noise of 0 are made 0, and the bounds are kept within [−1, 1], where
 * every difference of two rates lies (deltaView refuses anything else).
 * Only called once the gate passed, when every task has a difference.
 */
function boundsOf(
  deltas: readonly (number | null)[],
  opts: ResolvedOptions,
): { lo: number; hi: number } {
  const defined = deltas.filter((d): d is number => d !== null);
  if (defined.length !== deltas.length) {
    throw new Error('a task without a difference passed the gate');
  }
  const { lo, hi } = bootstrapInterval(defined, opts);
  const bound = (x: number): number => Math.min(1, Math.max(-1, cleanZero(x)));
  return { lo: bound(lo), hi: bound(hi) };
}

function taskStats(task: StatsTask): TaskStats {
  const baseline = tallyOf(task.baseline);
  const candidate = tallyOf(task.candidate);
  const delta = rateDelta(baseline, candidate);
  return { taskKey: task.taskKey, baseline, candidate, delta, change: changeOf(delta) };
}

// ---------------------------------------------------------------------------
// The gate and its sentences
// ---------------------------------------------------------------------------

/**
 * Why there is no interval, or null when there are enough tasks and every
 * one has 2 counted runs per configuration. Decided from the experiment's
 * shape and the two configurations' counted runs alone, so another
 * candidate of the experiment never changes this one's answer.
 */
function gateOf(input: StatsInput): NotComputableReason | null {
  if (input.repetitions === 1) return 'single_repetition';
  if (input.tasks.length < MIN_TASKS) return 'too_few_tasks';
  if (input.tasks.every((t) => t.baseline.length === 0 && t.candidate.length === 0)) {
    return 'nothing_scored';
  }
  if (!everyTaskHas(input.tasks, MIN_RUNS_PER_TASK)) return 'not_enough_runs';
  return null;
}

const rateText = (tally: PassTally): string => tally.rate?.toFixed(2) ?? '—';
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

const PANEL_RULE = 'once every task has at least 2 scored repetitions per configuration.';

/**
 * The sentence the panel shows instead of the statistics (UI_FLOWS 16).
 * While the experiment runs, the design's sentences, which promise the
 * panel; once it has settled nothing more will run, so they say what is
 * missing instead.
 */
function messageOf(
  reason: NotComputableReason,
  input: StatsInput,
  baseline: PassTally,
  candidate: PassTally,
): string {
  const { labels, progress, provisional } = input;
  const rates = `${labels.baseline} ${rateText(baseline)}, ${labels.candidate} ${rateText(candidate)}`;
  const tasks = plural(input.tasks.length, 'task');
  switch (reason) {
    case 'single_repetition':
      // The design's sentence; with too few tasks as well, it names both fixes.
      return (
        `No interval with 1 repetition. Pass rates: ${rates} on ${tasks}. ` +
        (input.tasks.length < MIN_TASKS
          ? `Run at least 2 repetitions of at least ${MIN_TASKS} tasks for a verdict.`
          : 'Run at least 2 repetitions for a verdict.')
      );
    case 'too_few_tasks':
      return (
        `No interval with ${tasks}. Pass rates: ${rates}. ` +
        `A verdict needs at least ${MIN_TASKS} tasks: the interval resamples the tasks, ` +
        'and with fewer it cannot say how sure the difference is.'
      );
    case 'nothing_scored':
      return provisional
        ? `0 of ${progress.total} runs scored. Rows fill in as runs are scored; ` +
            `the statistics panel appears ${PANEL_RULE}`
        : `0 of ${progress.total} runs scored: there are no pass rates to compare.`;
    case 'not_enough_runs': {
      if (provisional) return `The statistics panel appears ${PANEL_RULE}`;
      // Some task is short: with no task at all, nothing counted (nothing_scored).
      const short = input.tasks
        .filter((t) => Math.min(t.baseline.length, t.candidate.length) < MIN_RUNS_PER_TASK)
        .map((t) => t.taskKey);
      const named = short.length <= 3 ? short.join(', ') : `${short.slice(0, 3).join(', ')}, …`;
      return (
        `No interval: ${plural(short.length, 'task')} (${named}) counted fewer than 2 runs ` +
        'under a configuration, and cancelled runs do not count. ' +
        'A verdict needs at least 2 per task and configuration.'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Sensitivity
// ---------------------------------------------------------------------------

/** A run that answered: not an execution error, and its selected key neither errored nor was ungradable. */
const answered = (run: StatsRun): boolean =>
  run.executionError === null && run.keyStatus !== 'error' && run.keyStatus !== 'ungradable';

function excludedOf(runs: readonly StatsRun[]): ExcludedRuns {
  return {
    executionErrors: runs.filter((r) => r.executionError !== null).length,
    ungradable: runs.filter((r) => r.executionError === null && r.keyStatus === 'ungradable')
      .length,
    error: runs.filter((r) => r.executionError === null && r.keyStatus === 'error').length,
  };
}

const excludedAny = (e: ExcludedRuns): boolean => e.executionErrors + e.ungradable + e.error > 0;

/** The figure without the runs that broke rather than answered; null when none broke. */
function sensitivityOf(
  input: StatsInput,
  mainVerdict: VerdictState,
  opts: ResolvedOptions,
): SensitivityResult | null {
  const excludedBaseline = excludedOf(input.tasks.flatMap((t) => t.baseline));
  const excludedCandidate = excludedOf(input.tasks.flatMap((t) => t.candidate));
  if (!excludedAny(excludedBaseline) && !excludedAny(excludedCandidate)) return null;

  const kept = input.tasks.map((t) => ({
    baseline: t.baseline.filter(answered),
    candidate: t.candidate.filter(answered),
  }));
  const deltas = kept.map((k) => rateDelta(tallyOf(k.baseline), tallyOf(k.candidate)));
  let lo: number | null = null;
  let hi: number | null = null;
  let verdict: VerdictState = 'not_computable';
  if (kept.length >= MIN_TASKS && everyTaskHas(kept, MIN_RUNS_PER_TASK)) {
    ({ lo, hi } = boundsOf(deltas, opts));
    verdict = verdictOf(lo, hi, input.provisional);
  }
  return {
    excludedBaseline,
    excludedCandidate,
    baseline: pooledTally(kept.map((k) => k.baseline)),
    candidate: pooledTally(kept.map((k) => k.candidate)),
    delta: meanDelta(deltas),
    lo,
    hi,
    verdict,
    verdictChanges: verdict !== mainVerdict,
  };
}

// ---------------------------------------------------------------------------
// The seed
// ---------------------------------------------------------------------------

/**
 * The bootstrap's seed for an experiment: the first four bytes of
 * sha256(experimentId) (the id's UTF-8 bytes), read big-endian as an
 * unsigned 32-bit integer. Every comparison of one experiment, and every
 * verdict entry, resamples the same way.
 */
export function seedFromExperimentId(experimentId: string): number {
  return createHash('sha256').update(experimentId, 'utf8').digest().readUInt32BE(0);
}
