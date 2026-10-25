/**
 * View models for runs: the Runs tab table, its filters, and the run actions
 * (plan sections 8.4, 9 and 11, UI_FLOWS 17). The run inspector is in
 * ./run-detail.ts.
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import {
  EVALUATION_CAUSES,
  EXECUTION_ERROR_CATEGORIES,
  RUN_STATUSES,
  SCORE_STATUSES,
} from '../status.js';
import { PROVIDERS } from '../vocab.js';
import { countView, isoTimeView, isUnique, rateView, secondsView, usdView } from './common.js';
import { ExperimentConfigRefSchema } from './experiments.js';

const provider = z.enum(PROVIDERS);

export const TokenCountsSchema = z.object({
  input: countView,
  output: countView,
  total: countView,
});
export type TokenCounts = z.infer<typeof TokenCountsSchema>;

/** What a model-needing action on a run requires, for BlockedReason. */
export const RunModelNeedsSchema = z.object({
  /** Provider the run's configuration uses: Retry execution needs it connected. */
  provider,
  /** llm_judge keys of the task: Re-score needs the judge's provider for them. */
  judgeKeys: z.array(z.string()),
  judgeProvider: provider.nullable(),
});
export type RunModelNeeds = z.infer<typeof RunModelNeedsSchema>;

/** A run's evaluation number: 1 for the first, +1 per re-score (plan 9.4). */
const generation = z.number().int().positive();

/**
 * A queued or running evaluation of a run (plan 9.4): its first while the
 * run is `executed` or `scoring`, or a re-score of a `scored` run, which
 * keeps its status and current result until the new one publishes. The
 * database lets a run have at most one (evaluations_in_flight_uq).
 */
export const PendingEvaluationViewSchema = z.object({
  evaluationId: z.string(),
  generation,
  status: z.enum(['queued', 'running']),
  cause: z.enum(EVALUATION_CAUSES),
  requestedAt: isoTimeView,
});
export type PendingEvaluationView = z.infer<typeof PendingEvaluationViewSchema>;

/**
 * Which evaluation a run's scores come from (the inspector header and
 * Outcome), and what happened to any newer one.
 */
export const RunEvaluationViewSchema = z.object({
  /** Generation of the current (published, not superseded) evaluation; null until the first publishes. */
  generation: generation.nullable(),
  /** The run's queued or running evaluation, if any. */
  pending: PendingEvaluationViewSchema.nullable(),
  /**
   * The run's newest evaluation, when it is a re-score that failed (its
   * job died on every try): the result of `generation` stays current. Null
   * once a later re-score is pending or published.
   */
  lastFailure: z.object({ generation, error: z.string(), finishedAt: isoTimeView }).nullable(),
});
export type RunEvaluationView = z.infer<typeof RunEvaluationViewSchema>;

/** The primary key's result on a scored run. */
export const PrimaryScoreViewSchema = z.object({
  key: z.string(),
  status: z.enum(SCORE_STATUSES),
  score: rateView.nullable(),
});
export type PrimaryScoreView = z.infer<typeof PrimaryScoreViewSchema>;

// ---------------------------------------------------------------------------
// Runs tab
// ---------------------------------------------------------------------------

export const RUN_SORT_KEYS = [
  'task',
  'configuration',
  'repetition',
  'attempts',
  'status',
  'score',
  'duration',
  'tokens',
  'cost',
  'finished',
] as const;
export const RunSortKeySchema = z.enum(RUN_SORT_KEYS);
export type RunSortKey = z.infer<typeof RunSortKeySchema>;

export const SORT_DIRECTIONS = ['asc', 'desc'] as const;
export const SortDirectionSchema = z.enum(SORT_DIRECTIONS);
export type SortDirection = z.infer<typeof SortDirectionSchema>;

/** Runs tab filters and sort, as the page holds them; mirrored in the URL query by the page. */
export const RunFiltersSchema = z.object({
  /** Configuration name or version id; omitted (or `all`) for every configuration. */
  configuration: z.string().min(1).optional(),
  task: z.string().min(1).optional(),
  status: z.enum(RUN_STATUSES).optional(),
  scoreStatus: z.enum(SCORE_STATUSES).optional(),
  hasExecutionError: z.boolean().optional(),
  ungradable: z.boolean().optional(),
  sort: RunSortKeySchema.optional(),
  dir: SortDirectionSchema.optional(),
});
export type RunFilters = z.infer<typeof RunFiltersSchema>;

/** A query-string flag: `true` or `1` turn it on, `false` or `0` off (the web sends `1`). */
const flag = z
  .enum(['true', '1', 'false', '0'], { error: 'use true or false' })
  .transform((v) => v === 'true' || v === '1');

/** A name filter; `all`, as the select's first option reads, means no filter. */
const nameFilter = z
  .string()
  .min(1)
  .transform((v) => (v === 'all' ? undefined : v));

/**
 * Query of GET /experiments/:id/runs, with the names the web's listRuns
 * sends: `config, task, status, score_status, exec_error, ungradable, sort,
 * dir`. Parses to the RunFilters the page holds, so both ends share them.
 */
export const RunListQuerySchema = z
  .object({
    config: nameFilter.optional(),
    task: nameFilter.optional(),
    status: z.enum(RUN_STATUSES).optional(),
    score_status: z.enum(SCORE_STATUSES).optional(),
    exec_error: flag.optional(),
    ungradable: flag.optional(),
    sort: RunSortKeySchema.optional(),
    dir: SortDirectionSchema.optional(),
  })
  .transform((q): RunFilters => {
    const filters: RunFilters = {};
    if (q.config !== undefined) filters.configuration = q.config;
    if (q.task !== undefined) filters.task = q.task;
    if (q.status !== undefined) filters.status = q.status;
    if (q.score_status !== undefined) filters.scoreStatus = q.score_status;
    if (q.exec_error !== undefined) filters.hasExecutionError = q.exec_error;
    if (q.ungradable !== undefined) filters.ungradable = q.ungradable;
    if (q.sort !== undefined) filters.sort = q.sort;
    if (q.dir !== undefined) filters.dir = q.dir;
    return filters;
  });
/** The query string's own names, before parsing. */
export type RunListQueryParams = z.input<typeof RunListQuerySchema>;

export const RunRowSchema = z.object({
  id: z.string(),
  experimentId: z.string(),
  taskKey: z.string(),
  taskVersion: z.number().int().positive(),
  configuration: ExperimentConfigRefSchema,
  repetition: z.number().int().positive(),
  /** Attempts so far; 0 until the first one starts. */
  attempts: countView,
  status: z.enum(RUN_STATUSES),
  /** The primary key's result; null until scored and for execution_error or cancelled runs. */
  primaryScore: PrimaryScoreViewSchema.nullable(),
  /** Set when status is execution_error. */
  executionErrorCategory: z.enum(EXECUTION_ERROR_CATEGORIES).nullable(),
  durationS: secondsView.nullable(),
  tokens: TokenCountsSchema.nullable(),
  /** Null until executed, and when the model has no price. */
  costUsd: usdView.nullable(),
  finishedAt: isoTimeView.nullable(),
  needs: RunModelNeedsSchema,
  /** Generation of the evaluation primaryScore comes from; null until the first publishes. */
  generation: generation.nullable(),
  /** A re-score of this scored run is queued or running; primaryScore is still the previous result. */
  rescorePending: z.boolean(),
});
export type RunRow = z.infer<typeof RunRowSchema>;

/** Counts over the whole experiment for the count line and its shortcut chips. */
export const RunSummaryCountsSchema = z.object({
  total: countView,
  passed: countView,
  failed: countView,
  error: countView,
  ungradable: countView,
  executionErrors: countView,
});
export type RunSummaryCounts = z.infer<typeof RunSummaryCountsSchema>;

export const RunListResultSchema = z.object({
  rows: z.array(RunRowSchema),
  /** Rows matching the filters (equals rows.length; pagination comes later). */
  matched: countView,
  summary: RunSummaryCountsSchema,
});
export type RunListResult = z.infer<typeof RunListResultSchema>;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Most runs one bulk Re-score or Retry execution may name. */
export const MAX_BULK_RUNS = 500;

/** Body of POST /experiments/:id/runs/rescore and /runs/retry (the bulk bar). */
export const BulkRunActionInputSchema = z.strictObject({
  runIds: z
    .array(z.string().min(1, 'run ids must not be empty'))
    .min(1, 'select at least one run')
    .max(MAX_BULK_RUNS, `select at most ${MAX_BULK_RUNS} runs`)
    .refine(isUnique, 'a run is listed twice'),
});
export type BulkRunActionInput = z.infer<typeof BulkRunActionInputSchema>;

/** Result of a bulk Re-score or Retry execution. */
export const BulkRunActionResultSchema = z.object({
  action: z.enum(['rescore', 'retry']),
  enqueued: z.array(z.string()),
  /** Runs that could not be enqueued, each with the reason the ErrorBanner names. */
  refused: z.array(z.object({ runId: z.string(), reason: z.string() })),
});
export type BulkRunActionResult = z.infer<typeof BulkRunActionResultSchema>;

/** Result of a single-run action from the inspector. */
export const RunActionResultSchema = z.object({
  runId: z.string(),
  status: z.enum(RUN_STATUSES),
  /** For retry: the attempt that was created. */
  attempt: z.number().int().positive().nullable(),
});
export type RunActionResult = z.infer<typeof RunActionResultSchema>;

/**
 * POST /runs/:id/rescore (plan 9.4, UI_FLOWS 18): the re-score evaluation,
 * queued with its evaluate-run job in one transaction. A RunActionResult
 * with more, so the inspector's action handling reads it unchanged. The run
 * stays `scored`, and its current result stays current until the new
 * generation publishes. A request while a re-score is already queued or
 * running answers that one with `joinedPending` true: double clicks
 * collapse into one evaluation.
 */
export const RescoreRunResultSchema = RunActionResultSchema.extend({
  status: z.literal('scored'),
  attempt: z.null(),
  evaluation: PendingEvaluationViewSchema.extend({ cause: z.literal('rescore') }),
  joinedPending: z.boolean(),
});
export type RescoreRunResult = z.infer<typeof RescoreRunResultSchema>;

/**
 * POST /experiments/:id/runs/rescore: a BulkRunActionResult with the
 * evaluation of each accepted run. `enqueued` lists every accepted run,
 * including those that joined a re-score already pending; `refused` the
 * others with their reason (not scored, not in this experiment, the judge's
 * provider not ready).
 */
export const BulkRescoreResultSchema = BulkRunActionResultSchema.extend({
  action: z.literal('rescore'),
  evaluations: z.array(
    z.object({
      runId: z.string(),
      evaluationId: z.string(),
      generation,
      status: z.enum(['queued', 'running']),
      joinedPending: z.boolean(),
    }),
  ),
}).superRefine((r, ctx) => {
  const accepted = r.evaluations.map((e) => e.runId);
  if (accepted.length !== r.enqueued.length || !accepted.every((id, i) => id === r.enqueued[i])) {
    ctx.addIssue({
      code: 'custom',
      path: ['evaluations'],
      message: 'evaluations lists the enqueued runs, in the same order',
    });
  }
});
export type BulkRescoreResult = z.infer<typeof BulkRescoreResultSchema>;
