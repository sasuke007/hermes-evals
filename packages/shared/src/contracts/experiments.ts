/**
 * View models for experiments: the Experiment list, the detail page with its
 * Overview tab, and the experiment controls (plan sections 7 and 11,
 * UI_FLOWS 14 and 15). The comparison is in ./comparison.ts, New experiment
 * and launch in ./new-experiment.ts, the live stream in ./events.ts.
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import {
  EXECUTION_ERROR_CATEGORIES,
  EXPERIMENT_STATUSES,
  type ExperimentStatus,
  NOT_COMPUTABLE_REASONS,
  PAUSE_REASONS,
  type PauseReason,
  RUN_STATUSES,
  SCORE_STATUSES,
  VERDICT_CAUSES,
  VERDICTS,
} from '../status.js';
import { PROVIDERS } from '../vocab.js';
import {
  countView,
  deltaView,
  isoTimeView,
  rateView,
  secondsView,
  sha256View,
  spendCeilingUsd,
  usdView,
} from './common.js';
import { ConfigFieldSchema, ConfigVersionRefSchema } from './configurations.js';
import { SuiteVersionRefSchema } from './suites.js';

// ---------------------------------------------------------------------------
// Building blocks shared by the experiment, comparison and run view models
// ---------------------------------------------------------------------------

/** Why an experiment is paused; the Overview banner and the status chip name it. */
export const PauseReasonSchema = z.enum(PAUSE_REASONS);

/**
 * A verdict as drawn: the three final verdicts, `provisional` while the
 * experiment runs, and `not_computable` (with 1 repetition, or too few runs).
 */
export const VERDICT_STATES = [...VERDICTS, 'provisional', 'not_computable'] as const;
export const VerdictStateSchema = z.enum(VERDICT_STATES);
export type VerdictState = z.infer<typeof VerdictStateSchema>;

export const CONFIG_ROLES = ['baseline', 'candidate'] as const;
export const ConfigRoleSchema = z.enum(CONFIG_ROLES);
export type ConfigRole = z.infer<typeof ConfigRoleSchema>;

/** A frozen configuration version as an experiment uses it. */
export const ExperimentConfigRefSchema = ConfigVersionRefSchema.extend({
  role: ConfigRoleSchema,
  model: z.string(),
  provider: z.enum(PROVIDERS),
});
export type ExperimentConfigRef = z.infer<typeof ExperimentConfigRefSchema>;

/** Run counts by status, every status present (0 when none). */
export const RunCountsSchema = z.record(z.enum(RUN_STATUSES), countView);
export type RunCounts = z.infer<typeof RunCountsSchema>;

/** The Hermes build an experiment was frozen on: "hermes-agent v0.22.4 @ 4d04303". */
export const HermesRevisionSchema = z.object({
  package: z.string(),
  version: z.string(),
  revision: z.string(),
});
export type HermesRevision = z.infer<typeof HermesRevisionSchema>;

// ---------------------------------------------------------------------------
// Detail and Overview
// ---------------------------------------------------------------------------

/** Shown on an older experiment when its suite directory has a newer version. */
export const NewerSuiteVersionSchema = z.object({
  suiteId: z.string(),
  versionNumber: z.number().int().positive(),
  changedTasks: z.array(z.string()),
  removedTasks: z.array(z.string()),
  invalidTasks: z.array(z.string()),
});
export type NewerSuiteVersion = z.infer<typeof NewerSuiteVersionSchema>;

export const ExperimentSuiteSnapshotSchema = SuiteVersionRefSchema.extend({
  path: z.string(),
  taskCount: countView,
  /** Tasks of the suite included in this experiment. */
  tasks: z.array(z.object({ key: z.string(), version: z.number().int().positive() })),
  newerVersion: NewerSuiteVersionSchema.nullable(),
});
export type ExperimentSuiteSnapshot = z.infer<typeof ExperimentSuiteSnapshotSchema>;

/** One verdict computation, kept in the experiment's history. */
export const VerdictHistoryEntrySchema = z.object({
  at: isoTimeView,
  cause: z.enum(VERDICT_CAUSES),
  /** e.g. "1 retry" for "Updated 23 Oct 14:20 after 1 retry". */
  note: z.string().nullable(),
  delta: deltaView.nullable(),
  lo: deltaView.nullable(),
  hi: deltaView.nullable(),
  verdict: VerdictStateSchema,
});
export type VerdictHistoryEntry = z.infer<typeof VerdictHistoryEntrySchema>;

/** Passed runs of the runs counted toward a pass rate (scored plus execution errors). */
export const PassCountSchema = z.object({ passed: countView, counted: countView });

/**
 * The verdict of one candidate against the baseline. Once the experiment has
 * completed, the candidate's last verdict history entry; while it runs, the
 * provisional figures so far.
 */
export const VerdictSummarySchema = z.object({
  baseline: ExperimentConfigRefSchema,
  candidate: ExperimentConfigRefSchema,
  verdict: VerdictStateSchema,
  /** Score key the verdict is computed on: `primary` (each task's primary key) or a key name. */
  scoreKey: z.string(),
  delta: deltaView.nullable(),
  lo: deltaView.nullable(),
  hi: deltaView.nullable(),
  passRates: z.object({ baseline: rateView.nullable(), candidate: rateView.nullable() }),
  passCounts: z.object({ baseline: PassCountSchema, candidate: PassCountSchema }),
  taskCounts: z.object({ improved: countView, regressed: countView, unchanged: countView }),
  method: z.object({
    name: z.literal('paired_bootstrap'),
    resamples: z.number().int().positive(),
    confidence: z.number().gt(0).lt(1),
  }),
  /** Set when verdict is `not_computable`. */
  reason: z.enum(NOT_COMPUTABLE_REASONS).nullable(),
  /** Oldest first; more than one entry means the verdict was recomputed. */
  history: z.array(VerdictHistoryEntrySchema),
});
export type VerdictSummary = z.infer<typeof VerdictSummarySchema>;

/** One field that differs between the baseline and a candidate. */
export const ConfigDifferenceSchema = z.object({
  field: ConfigFieldSchema,
  /** Name of the candidate configuration. */
  candidate: z.string(),
  baselineValue: z.string(),
  candidateValue: z.string(),
  /** Content hash behind the candidate value, e.g. the skill's sha256. */
  hash: sha256View.nullable(),
});
export type ConfigDifference = z.infer<typeof ConfigDifferenceSchema>;

/** Progress of one configuration while the experiment runs. */
export const ConfigProgressSchema = z.object({
  configuration: ExperimentConfigRefSchema,
  total: countView,
  counts: RunCountsSchema,
  passed: countView,
  /** passed / scored so far. */
  provisionalPassRate: rateView.nullable(),
});
export type ConfigProgress = z.infer<typeof ConfigProgressSchema>;

/** One row of "Latest completions" (newest first, at most 10). */
export const FeedEntrySchema = z.object({
  runId: z.string(),
  finishedAt: isoTimeView,
  taskKey: z.string(),
  /** Configuration name. */
  configuration: z.string(),
  repetition: z.number().int().positive(),
  /** The primary score status, or `execution_error` when the run broke. */
  result: z.enum([...SCORE_STATUSES, 'execution_error']),
  durationS: secondsView,
});
export type FeedEntry = z.infer<typeof FeedEntrySchema>;

const executionErrorCategory = z.enum(EXECUTION_ERROR_CATEGORIES);

/** Per-configuration aggregates on the completed Overview. */
export const ConfigAggregateSchema = z.object({
  configuration: ExperimentConfigRefSchema,
  runs: countView,
  passRate: rateView.nullable(),
  meanScore: rateView.nullable(),
  medianDurationS: secondsView.nullable(),
  meanTokens: z.number().nonnegative().nullable(),
  /** Null when no attempt of this configuration is priced. */
  costUsd: usdView.nullable(),
  executionErrors: countView,
  executionErrorCategories: z.array(executionErrorCategory),
  ungradable: countView,
});
export type ConfigAggregate = z.infer<typeof ConfigAggregateSchema>;

/** Why the circuit breaker stopped the experiment. */
export const ExperimentFailureViewSchema = z.object({
  at: isoTimeView,
  threshold: z.number().int().positive(),
  category: executionErrorCategory,
  /** Headline cause, e.g. "invoice-db failed to start". */
  message: z.string(),
  stderrFirstLine: z.string().nullable(),
  /** Runs whose first stderr line was identical. */
  identicalIn: countView,
  /** Where to fix it, when the platform can tell: a label and an app route. */
  fix: z.object({ label: z.string(), to: z.string() }).nullable(),
  /** The run whose attempt tripped the breaker. */
  runId: z.string(),
});
export type ExperimentFailureView = z.infer<typeof ExperimentFailureViewSchema>;

export const WorkerPresenceSchema = z.object({
  connected: z.boolean(),
  lastHeartbeatAt: isoTimeView.nullable(),
  /** Runs that were in flight when the worker stopped and were marked execution_error · worker_lost. */
  workerLostRuns: countView,
});
export type WorkerPresence = z.infer<typeof WorkerPresenceSchema>;

/** Spend against the ceiling: the tokens times the experiment's frozen price table. */
export const ExperimentSpendSchema = z.object({
  /** Priced attempts only; see unpricedAttempts. */
  spentUsd: usdView,
  ceilingUsd: z.number().positive().nullable(),
  projectedTotalUsd: usdView.nullable(),
  /** Estimated cost of the runs still waiting (paused-by-ceiling state). */
  remainingEstimateUsd: usdView.nullable(),
  /**
   * Finished attempts whose cost is unknown, counted and never treated as
   * zero: their model has no price in the frozen table, or their trial ran
   * but its usage was never measured (the worker or egress lost it).
   */
  unpricedAttempts: countView,
});
export type ExperimentSpend = z.infer<typeof ExperimentSpendSchema>;

/** The experiments CHECK rule on pause_reason, for the views that carry the columns. */
function checkPause(
  e: { status: ExperimentStatus; pauseReason: PauseReason | null },
  ctx: z.RefinementCtx,
): void {
  if ((e.status === 'paused') !== (e.pauseReason !== null)) {
    ctx.addIssue({
      code: 'custom',
      path: ['pauseReason'],
      message: 'pauseReason is set exactly when the experiment is paused',
    });
  }
}

const ExperimentDetailFieldsSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(EXPERIMENT_STATUSES),
  pauseReason: PauseReasonSchema.nullable(),
  pausedAt: isoTimeView.nullable(),
  createdAt: isoTimeView,
  finishedAt: isoTimeView.nullable(),
  elapsedS: secondsView,
  remainingEstimateS: secondsView.nullable(),
  /** When the last live event arrived ("Live · updated 15:23:42"). */
  lastEventAt: isoTimeView.nullable(),
  suite: ExperimentSuiteSnapshotSchema,
  baseline: ExperimentConfigRefSchema,
  candidates: z.array(ExperimentConfigRefSchema).min(1),
  differences: z.array(ConfigDifferenceSchema),
  hermes: HermesRevisionSchema,
  /** `primary` = each task's primary key. */
  scoreKey: z.string(),
  repetitions: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  timeBudgetOverrideS: z.number().int().positive().nullable(),
  totalRuns: countView,
  counts: RunCountsSchema,
  spend: ExperimentSpendSchema,
  perConfiguration: z.array(ConfigProgressSchema),
  feed: z.array(FeedEntrySchema).max(10),
  /** One per candidate, in candidate order. Provisional while running; final once completed. */
  verdicts: z.array(VerdictSummarySchema),
  aggregates: z.array(ConfigAggregateSchema),
  failure: ExperimentFailureViewSchema.nullable(),
  worker: WorkerPresenceSchema,
});

/**
 * Everything the experiment detail page and its Overview tab show. GET /experiments/:id.
 * The status columns keep the rules of the experiments CHECK constraints.
 */
export const ExperimentDetailSchema = ExperimentDetailFieldsSchema.superRefine((e, ctx) => {
  checkPause(e, ctx);
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if ((e.pauseReason !== null) !== (e.pausedAt !== null)) {
    issue('pausedAt', 'pausedAt is set exactly when there is a pause reason');
  }
  const finished = e.status === 'completed' || e.status === 'failed';
  if (finished !== (e.finishedAt !== null)) {
    issue('finishedAt', 'finishedAt is set exactly when the experiment is completed or failed');
  }
  if (e.status === 'failed' && e.failure === null) {
    issue('failure', 'a failed experiment carries its failure');
  }
});
export type ExperimentDetail = z.infer<typeof ExperimentDetailSchema>;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/**
 * The list row's and the live event's rule: final verdicts exist only once
 * the experiment has completed. A running, paused or failed one has none,
 * even if an earlier completion recorded some (a retry reopened it).
 */
function checkFinalVerdicts(
  e: { status: ExperimentStatus; verdicts: readonly unknown[] },
  ctx: z.RefinementCtx,
): void {
  if (e.status !== 'completed' && e.verdicts.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['verdicts'],
      message: 'verdicts are listed only once the experiment has completed',
    });
  }
}

/** A verdict chip on the experiment list. */
export const ExperimentListVerdictSchema = z.object({
  /** Name of the candidate configuration. */
  candidate: z.string(),
  candidateVersionId: z.string(),
  verdict: VerdictStateSchema,
  delta: deltaView.nullable(),
  lo: deltaView.nullable(),
  hi: deltaView.nullable(),
});
export type ExperimentListVerdict = z.infer<typeof ExperimentListVerdictSchema>;

/** One row of the Experiment list. GET /experiments, newest first. */
export const ExperimentListRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: z.enum(EXPERIMENT_STATUSES),
    pauseReason: PauseReasonSchema.nullable(),
    /** Status chip tooltip, e.g. "invoice-db failed to start (setup) in 14 of 14 runs". */
    statusReason: z.string().nullable(),
    suite: SuiteVersionRefSchema,
    baseline: ExperimentConfigRefSchema,
    candidates: z.array(ExperimentConfigRefSchema).min(1),
    repetitions: z.number().int().positive(),
    totalRuns: countView,
    /**
     * Runs the progress bar counts. Running or paused: scored runs. Completed
     * or failed: every settled run (scored, execution_error, cancelled), so a
     * finished experiment's bar is full and a breaker-stopped one counts its
     * errors.
     */
    doneRuns: countView,
    counts: RunCountsSchema,
    /**
     * Final verdicts once completed, one per candidate: its last verdict
     * history entry. Empty while running or paused ("Provisional") and when
     * failed.
     */
    verdicts: z.array(ExperimentListVerdictSchema),
    createdAt: isoTimeView,
    /** Priced spend so far; null when nothing is priced. */
    costUsd: usdView.nullable(),
  })
  .superRefine((row, ctx) => {
    checkPause(row, ctx);
    checkFinalVerdicts(row, ctx);
  });
export type ExperimentListRow = z.infer<typeof ExperimentListRowSchema>;

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

/** Answer of POST /experiments/:id/pause, /resume, /cancel and /retry-failed. */
export const ExperimentActionResultSchema = z.object({
  id: z.string(),
  status: z.enum(EXPERIMENT_STATUSES),
});
export type ExperimentActionResult = z.infer<typeof ExperimentActionResultSchema>;

/**
 * Body of POST /experiments/:id/resume. A spend-ceiling pause resumes only
 * with a ceiling above the current one; other pauses take no body field.
 */
export const ResumeExperimentInputSchema = z.strictObject({
  spendCeilingUsd: spendCeilingUsd.optional(),
});
export type ResumeExperimentInput = z.infer<typeof ResumeExperimentInputSchema>;
