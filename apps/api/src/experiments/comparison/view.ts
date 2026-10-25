/**
 * The Comparison tab's view model (ComparisonViewSchema, UI_FLOWS 16) from
 * one read of the results, the inputs of one candidate and key, and the
 * statistics over them. Pure: the service reads and caches, this shapes.
 *
 * Display rules, as the web fixtures draw them:
 * - a task's pass rates and Δ have two decimals (the grid's columns); the
 *   pooled rates, the observed difference and the interval bounds three;
 *   money six, mean tokens none, the token difference a whole percent. The
 *   statistics module's own numbers are unrounded, and a task's change is
 *   the sign of its unrounded Δ, as the task counts are;
 * - with one repetition there is no Δ column: per-task differences and
 *   changes are null, rows keep the experiment's task order, and there is
 *   no sensitivity figure;
 * - with more, rows are sorted by Δ descending (tasks without one last),
 *   then the baseline pass rate ascending, then the task key, and the
 *   filter keeps the rows whose change it names; the counts are of every
 *   row;
 * - a candidate's chip in the candidate select is `provisional` while the
 *   experiment runs, else its verdict on the primary key.
 */
import {
  SCORE_KEY_ANY_FAILED,
  SCORE_KEY_PRIMARY,
  ComparisonViewSchema,
  type ComparisonFilter,
  type ComparisonRow,
  type ComparisonView,
  type ExperimentConfigRef,
  type RepetitionCell,
  type SecondaryMetricsRow,
  type SensitivityView,
  type VerdictState,
} from '@hermes-evals/shared';
import type {
  PassTally,
  SecondaryMetrics,
  SensitivityResult,
  StatsResult,
} from '../../statistics/contracts.js';
import { round3, round6 } from '../views/numbers.js';
import type { ComparisonInputs, ComparisonRunInput } from './inputs.js';
import type { ExperimentResults } from './results.js';

export interface ComparisonViewInput {
  results: ExperimentResults;
  inputs: ComparisonInputs;
  stats: StatsResult;
  /** Each candidate's chip in the candidate select (comparison/verdicts.ts chipVerdict). */
  candidateVerdicts: ReadonlyMap<string, VerdictState>;
  filter: ComparisonFilter;
}

const nullable3 = (x: number | null): number | null => (x === null ? null : round3(x));

/** A task's rate or Δ in the grid: two decimals. */
const round2 = (x: number | null): number | null => (x === null ? null : Math.round(x * 100) / 100);

/** A bound or difference rounded, kept within [-1, 1] (deltaView). */
const delta3 = (x: number | null): number | null =>
  x === null ? null : Math.min(1, Math.max(-1, round3(x)));

function refOf(results: ExperimentResults, versionId: string): ExperimentConfigRef {
  const found = results.configs.find((c) => c.ref.versionId === versionId);
  if (!found)
    throw new Error(`configuration version ${versionId} is not in experiment ${results.id}`);
  return found.ref;
}

function cellOf(run: ComparisonRunInput): RepetitionCell {
  return {
    runId: run.runId,
    repetition: run.repetition,
    runStatus: run.status,
    scoreStatus: run.keyStatus,
    // The grid shows attempt 1 before the first attempt starts.
    attempt: Math.max(run.attemptCount, 1),
    durationS: run.status === 'queued' || run.status === 'running' ? null : run.durationS,
    comment: run.comment,
  };
}

function rowsOf(input: ComparisonViewInput): ComparisonRow[] {
  const multiRep = input.inputs.repetitions > 1;
  return input.inputs.tasks.map((task, i) => {
    const stats = input.stats.tasks[i];
    if (!stats || stats.taskKey !== task.taskKey) {
      throw new Error(`statistics task ${i} is not ${task.taskKey}`);
    }
    return {
      taskKey: task.taskKey,
      taskVersion: task.taskVersion,
      baseline: task.baseline.map(cellOf),
      candidate: task.candidate.map(cellOf),
      passBaseline: round2(stats.baseline.rate),
      passCandidate: round2(stats.candidate.rate),
      delta: multiRep ? round2(stats.delta) : null,
      change: multiRep ? stats.change : null,
    };
  });
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Δ descending (no Δ last), then the baseline pass rate ascending, then the task key. */
function sortRows(rows: readonly ComparisonRow[]): ComparisonRow[] {
  return rows.toSorted(
    (a, b) =>
      (b.delta ?? -Infinity) - (a.delta ?? -Infinity) ||
      (a.passBaseline ?? 0) - (b.passBaseline ?? 0) ||
      byKey(a.taskKey, b.taskKey),
  );
}

const tallyView = (t: PassTally) => ({ passed: t.passed, counted: t.counted });

function secondaryRow(ref: ExperimentConfigRef, m: SecondaryMetrics): SecondaryMetricsRow {
  return {
    configuration: ref,
    medianDurationS: m.medianDurationS,
    meanTokens: m.meanTokens === null ? null : Math.round(m.meanTokens),
    costUsd: m.costUsd === null ? null : round6(m.costUsd),
    executionErrors: m.executionErrors,
    executionErrorCategories: m.executionErrorCategories,
    ungradable: m.ungradable,
  };
}

function sensitivityView(s: SensitivityResult): SensitivityView {
  return {
    excludedBaseline: s.excludedBaseline,
    excludedCandidate: s.excludedCandidate,
    baseline: { ...tallyView(s.baseline), rate: nullable3(s.baseline.rate) },
    candidate: { ...tallyView(s.candidate), rate: nullable3(s.candidate.rate) },
    delta: delta3(s.delta),
    lo: delta3(s.lo),
    hi: delta3(s.hi),
    verdict: s.verdict,
    verdictChanges: s.verdictChanges,
  };
}

/** The key select: each task's primary key, every key all tasks declare, then any key failed. */
function scoreKeyOptions(inputs: ComparisonInputs, taskCount: number) {
  return [
    { value: SCORE_KEY_PRIMARY, label: 'Primary key per task' },
    ...inputs.commonKeys.map((key) => ({
      value: key,
      label: `${key} (all ${taskCount} task${taskCount === 1 ? '' : 's'})`,
    })),
    { value: SCORE_KEY_ANY_FAILED, label: 'Any key failed' },
  ];
}

/** GET /experiments/:id/comparison's answer, parsed with its schema. */
export function buildComparisonView(input: ComparisonViewInput): ComparisonView {
  const { results, inputs, stats, filter } = input;
  const all = rowsOf(input);
  const multiRep = inputs.repetitions > 1;
  const kept = filter === 'all' ? all : all.filter((r) => r.change === filter);
  const live = results.status === 'running' || results.status === 'paused';
  const baseline = refOf(results, inputs.baselineVersionId);
  const candidate = refOf(results, inputs.candidateVersionId);
  const { difference } = stats.secondary;
  return ComparisonViewSchema.parse({
    experimentId: results.id,
    experimentStatus: results.status,
    provisional: live,
    repetitions: inputs.repetitions,
    baseline,
    candidate,
    candidates: inputs.candidateVersionIds.map((id) => ({
      configuration: refOf(results, id),
      verdict: input.candidateVerdicts.get(id) ?? 'not_computable',
    })),
    scoreKey: inputs.scoreKey,
    scoreKeyOptions: scoreKeyOptions(inputs, results.tasks.length),
    filter,
    filterCounts: {
      all: all.length,
      improved: all.filter((r) => r.change === 'improved').length,
      regressed: all.filter((r) => r.change === 'regressed').length,
      unchanged: all.filter((r) => r.change === 'unchanged').length,
    },
    rows: multiRep ? sortRows(kept) : kept,
    passRates: {
      baseline: nullable3(stats.baseline.rate),
      candidate: nullable3(stats.candidate.rate),
    },
    passCounts: { baseline: tallyView(stats.baseline), candidate: tallyView(stats.candidate) },
    statistics: stats.computable
      ? {
          observedDelta: delta3(stats.observedDelta)!,
          lo: delta3(stats.lo)!,
          hi: delta3(stats.hi)!,
          resamples: stats.resamples,
          confidence: stats.confidence,
          verdict: stats.verdict,
          provisional: stats.provisional,
        }
      : null,
    statisticsUnavailable: stats.computable
      ? null
      : { reason: stats.reason, message: stats.message },
    secondary: [
      secondaryRow(baseline, stats.secondary.baseline),
      secondaryRow(candidate, stats.secondary.candidate),
    ],
    secondaryDifference: {
      medianDurationS:
        difference.medianDurationS === null ? null : round3(difference.medianDurationS),
      meanTokensPct:
        difference.meanTokensPct === null ? null : Math.round(difference.meanTokensPct),
      costUsd: difference.costUsd === null ? null : round6(difference.costUsd),
      executionErrors: difference.executionErrors,
      ungradable: difference.ungradable,
    },
    sensitivity: multiRep && stats.sensitivity ? sensitivityView(stats.sensitivity) : null,
    progress: inputs.progress,
  } satisfies ComparisonView);
}
