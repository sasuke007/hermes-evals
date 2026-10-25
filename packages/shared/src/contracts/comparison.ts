/**
 * View models for the Comparison tab (plan section 10, UI_FLOWS 16): one
 * candidate against the baseline, task by task, with the bootstrap
 * statistics, secondary metrics and the sensitivity figure, as
 * GET /experiments/:id/comparison answers them (Phase 4).
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import {
  EXECUTION_ERROR_CATEGORIES,
  EXPERIMENT_STATUSES,
  NOT_COMPUTABLE_REASONS,
  RUN_STATUSES,
  SCORE_STATUSES,
} from '../status.js';
import { countView, deltaView, rateView, secondsView, usdView } from './common.js';
import { ExperimentConfigRefSchema, PassCountSchema, VerdictStateSchema } from './experiments.js';

export const COMPARISON_FILTERS = ['all', 'improved', 'regressed', 'unchanged'] as const;
export const ComparisonFilterSchema = z.enum(COMPARISON_FILTERS);
export type ComparisonFilter = z.infer<typeof ComparisonFilterSchema>;

/** The selection that grades each task by its own primary key (the default). */
export const SCORE_KEY_PRIMARY = 'primary';
/** The selection under which a run passes only when none of its keys failed, errored or was ungradable. */
export const SCORE_KEY_ANY_FAILED = 'any_failed';

/** `primary`, `any_failed`, or a key every selected task has (e.g. `answer`). */
export const ScoreKeySelectionSchema = z.string().min(1);
export type ScoreKeySelection = z.infer<typeof ScoreKeySelectionSchema>;

export const TASK_CHANGES = ['improved', 'regressed', 'unchanged'] as const;
export const TaskChangeSchema = z.enum(TASK_CHANGES);
export type TaskChange = z.infer<typeof TaskChangeSchema>;

/** One repetition of one task under one configuration: a 16px button in the grid. */
export const RepetitionCellSchema = z.object({
  runId: z.string(),
  repetition: z.number().int().positive(),
  runStatus: z.enum(RUN_STATUSES),
  /** Status of the selected key; null until scored and for execution_error or cancelled runs. */
  scoreStatus: z.enum(SCORE_STATUSES).nullable(),
  attempt: z.number().int().positive(),
  durationS: secondsView.nullable(),
  /** Primary score comment, or the execution error line, for the tooltip. */
  comment: z.string().nullable(),
});
export type RepetitionCell = z.infer<typeof RepetitionCellSchema>;

export const ComparisonRowSchema = z.object({
  taskKey: z.string(),
  taskVersion: z.number().int().positive(),
  baseline: z.array(RepetitionCellSchema),
  candidate: z.array(RepetitionCellSchema),
  passBaseline: rateView.nullable(),
  passCandidate: rateView.nullable(),
  /** Null with one repetition (no Δ column) or before both sides have counted runs. */
  delta: deltaView.nullable(),
  change: TaskChangeSchema.nullable(),
});
export type ComparisonRow = z.infer<typeof ComparisonRowSchema>;

export const ComparisonStatisticsSchema = z.object({
  observedDelta: deltaView,
  lo: deltaView,
  hi: deltaView,
  resamples: z.number().int().positive(),
  confidence: z.number().gt(0).lt(1),
  verdict: VerdictStateSchema,
  provisional: z.boolean(),
});
export type ComparisonStatistics = z.infer<typeof ComparisonStatisticsSchema>;

export const SecondaryMetricsRowSchema = z.object({
  configuration: ExperimentConfigRefSchema,
  medianDurationS: secondsView.nullable(),
  meanTokens: z.number().nonnegative().nullable(),
  costUsd: usdView.nullable(),
  executionErrors: countView,
  executionErrorCategories: z.array(z.enum(EXECUTION_ERROR_CATEGORIES)),
  ungradable: countView,
});
export type SecondaryMetricsRow = z.infer<typeof SecondaryMetricsRowSchema>;

/** Candidate minus baseline, for the "Difference" row; any value may be negative. */
export const SecondaryMetricsDifferenceSchema = z.object({
  medianDurationS: z.number().nullable(),
  meanTokensPct: z.number().nullable(),
  costUsd: z.number().nullable(),
  executionErrors: z.number().int(),
  ungradable: z.number().int(),
});
export type SecondaryMetricsDifference = z.infer<typeof SecondaryMetricsDifferenceSchema>;

const excludedRuns = z.object({
  executionErrors: countView,
  ungradable: countView,
  error: countView,
});
const keptRate = PassCountSchema.extend({ rate: rateView.nullable() });

/**
 * The same difference and interval computed without runs that broke rather
 * than answered: execution errors, and runs whose selected key is `error`
 * or `ungradable` (plan 10.2). Null on the view when nothing was excluded.
 */
export const SensitivityViewSchema = z.object({
  excludedBaseline: excludedRuns,
  excludedCandidate: excludedRuns,
  baseline: keptRate,
  candidate: keptRate,
  delta: deltaView.nullable(),
  /** The bootstrap interval over the kept runs; null when they fail the 2-runs gate. */
  lo: deltaView.nullable(),
  hi: deltaView.nullable(),
  /** The verdict the kept runs give: `not_computable` when they fail the gate, `provisional` while running. */
  verdict: VerdictStateSchema,
  /** True when `verdict` differs from the statistics' verdict. */
  verdictChanges: z.boolean(),
});
export type SensitivityView = z.infer<typeof SensitivityViewSchema>;

export const ComparisonCandidateOptionSchema = z.object({
  configuration: ExperimentConfigRefSchema,
  verdict: VerdictStateSchema,
});
export type ComparisonCandidateOption = z.infer<typeof ComparisonCandidateOptionSchema>;

export const ScoreKeyOptionSchema = z.object({
  value: ScoreKeySelectionSchema,
  label: z.string(),
});
export type ScoreKeyOption = z.infer<typeof ScoreKeyOptionSchema>;

/**
 * Why the statistics panel is replaced (plan 10.2's gate, UI_FLOWS 16), with
 * the sentence the panel shows in its place, e.g. "No interval with 1
 * repetition. Pass rates: baseline 0.58, with-skill 0.83 on 12 tasks. Run at
 * least 2 repetitions for a verdict."
 */
export const StatisticsUnavailableSchema = z.object({
  reason: z.enum(NOT_COMPUTABLE_REASONS),
  message: z.string(),
});
export type StatisticsUnavailable = z.infer<typeof StatisticsUnavailableSchema>;

/** GET /experiments/:id/comparison: always one candidate against the baseline. */
export const ComparisonViewSchema = z
  .object({
    experimentId: z.string(),
    experimentStatus: z.enum(EXPERIMENT_STATUSES),
    /** True while running: unscored cells show queued or running, the panel reads "Provisional". */
    provisional: z.boolean(),
    repetitions: z.number().int().positive(),
    baseline: ExperimentConfigRefSchema,
    candidate: ExperimentConfigRefSchema,
    candidates: z.array(ComparisonCandidateOptionSchema),
    scoreKey: ScoreKeySelectionSchema,
    scoreKeyOptions: z.array(ScoreKeyOptionSchema),
    filter: ComparisonFilterSchema,
    filterCounts: z.record(ComparisonFilterSchema, countView),
    /** Rows after the filter, sorted by Δ descending, then baseline pass rate, then task. */
    rows: z.array(ComparisonRowSchema),
    passRates: z.object({ baseline: rateView.nullable(), candidate: rateView.nullable() }),
    passCounts: z.object({ baseline: PassCountSchema, candidate: PassCountSchema }),
    statistics: ComparisonStatisticsSchema.nullable(),
    /** Why there is no statistics panel; set exactly when statistics is null. */
    statisticsUnavailable: StatisticsUnavailableSchema.nullable(),
    secondary: z.array(SecondaryMetricsRowSchema),
    secondaryDifference: SecondaryMetricsDifferenceSchema.nullable(),
    sensitivity: SensitivityViewSchema.nullable(),
    progress: z.object({ scored: countView, total: countView }),
  })
  .superRefine((v, ctx) => {
    if ((v.statistics === null) === (v.statisticsUnavailable === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['statisticsUnavailable'],
        message: 'statisticsUnavailable is set exactly when there are no statistics',
      });
    }
  });
export type ComparisonView = z.infer<typeof ComparisonViewSchema>;

/** Query of GET /experiments/:id/comparison (`?candidate=&key=&filter=`). */
export const ComparisonQuerySchema = z.object({
  /** Candidate configuration version id; defaults to the first candidate. */
  candidate: z.string().min(1).optional(),
  key: ScoreKeySelectionSchema.optional(),
  filter: ComparisonFilterSchema.optional(),
});
export type ComparisonQuery = z.infer<typeof ComparisonQuerySchema>;
