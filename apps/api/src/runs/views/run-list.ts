/**
 * The Runs tab (UI_FLOWS 17): one row per cell of the run matrix with its
 * current attempt and current primary score, the filters and sort the page
 * mirrors in its URL, and the count line over the whole experiment.
 *
 * Every figure of a row comes from the run's current attempt and its current
 * evaluation (completed, not superseded), the same rows the inspector shows.
 * Measured figures (duration, tokens, cost) appear only once that attempt has
 * ended and the run is not waiting for a new one, so a run queued for a retry
 * does not show its previous attempt's numbers as its own. A row also names
 * the generation its score comes from and whether a re-score is pending:
 * until that one publishes, the row keeps the previous result.
 */
import {
  RUN_STATUSES,
  SCORE_STATUSES,
  type ExecutionErrorCategory,
  type PrimaryScoreView,
  type RunFilters,
  type RunListResult,
  type RunRow,
  type RunSortKey,
  type RunSummaryCounts,
  type ScoreStatus,
  type SortDirection,
  type Tokens,
  type TokenCounts,
} from '@hermes-evals/shared';
import type { JudgeSettings } from '../../scoring/judge/contracts.js';
import { configOrder, experimentConfigRef, runNeeds } from './config-ref.js';
import {
  NO_EVALUATION,
  rescorePending,
  runEvaluationView,
  type EvaluationStateRecord,
} from './evaluation-view.js';
import type {
  AttemptRecord,
  ConfigVersionRecord,
  ExperimentRecord,
  RunRecord,
  TaskRecord,
} from './rows.js';

/** A run with the columns of its current attempt the list shows. */
export type RunListRecord = Pick<
  RunRecord,
  | 'id'
  | 'taskId'
  | 'configurationVersionId'
  | 'repetition'
  | 'status'
  | 'attemptCount'
  | 'finishedAt'
> & {
  attempt: Pick<
    AttemptRecord,
    'status' | 'errorCategory' | 'durationMs' | 'tokens' | 'costUsd'
  > | null;
};

/** The primary score of a run's current evaluation. */
export type PrimaryScoreRecord = { key: string; status: ScoreStatus; score: number | null };

export interface RunListInput {
  experiment: ExperimentRecord;
  tasks: readonly TaskRecord[];
  configs: readonly ConfigVersionRecord[];
  runs: readonly RunListRecord[];
  /** By run id; runs without a current evaluation are absent. */
  primaryScores: ReadonlyMap<string, PrimaryScoreRecord>;
  /** Every evaluation of each run, by run id; runs never evaluated are absent. */
  evaluations: ReadonlyMap<string, readonly EvaluationStateRecord[]>;
  /** The platform's judge, for what Re-score needs. */
  judge: JudgeSettings;
}

/** Run statuses whose current attempt has ended for good (until a retry). */
const MEASURED_STATUSES = new Set([
  'executed',
  'scoring',
  'scored',
  'execution_error',
  'cancelled',
]);

/** Whether the run's current attempt is over and its figures are the run's own. */
export const isMeasured = (status: RunRecord['status'], attempt: { status: string } | null) =>
  attempt !== null && attempt.status !== 'running' && MEASURED_STATUSES.has(status);

export const tokenCounts = (tokens: Tokens | null): TokenCounts | null =>
  tokens ? { input: tokens.input, output: tokens.output, total: tokens.total } : null;

export const seconds = (ms: number | null): number | null => (ms === null ? null : ms / 1000);

export function primaryScoreView(score: PrimaryScoreRecord | undefined): PrimaryScoreView | null {
  return score ? { key: score.key, status: score.status, score: score.score } : null;
}

/** What one row is built from besides the run: its own task and configuration, and its scoring. */
export interface RunRowParts {
  task: TaskRecord;
  config: ConfigVersionRecord;
  primary: PrimaryScoreRecord | undefined;
  evaluations: readonly EvaluationStateRecord[];
  judge: JudgeSettings;
}

/** One table row. */
export function runRowView(
  experiment: ExperimentRecord,
  run: RunListRecord,
  { task, config, primary, evaluations, judge }: RunRowParts,
): RunRow {
  const measured = isMeasured(run.status, run.attempt);
  const attempt = measured ? run.attempt : null;
  const category: ExecutionErrorCategory | null =
    run.status === 'execution_error' ? (run.attempt?.errorCategory ?? 'other') : null;
  const scoring = evaluations.length > 0 ? runEvaluationView(evaluations) : NO_EVALUATION;
  return {
    id: run.id,
    experimentId: experiment.id,
    taskKey: task.key,
    taskVersion: task.versionNumber,
    configuration: experimentConfigRef(experiment, config),
    repetition: run.repetition,
    attempts: run.attemptCount,
    status: run.status,
    primaryScore: primaryScoreView(primary),
    executionErrorCategory: category,
    durationS: seconds(attempt?.durationMs ?? null),
    tokens: tokenCounts(attempt?.tokens ?? null),
    costUsd: attempt?.costUsd ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
    needs: runNeeds(config, task.verification, judge),
    generation: scoring.generation,
    rescorePending: rescorePending(scoring),
  };
}

/** The count line: every run of the experiment, whatever the filters. */
export function runSummary(rows: readonly RunRow[]): RunSummaryCounts {
  const primary = (status: ScoreStatus) =>
    rows.filter((r) => r.primaryScore?.status === status).length;
  return {
    total: rows.length,
    passed: primary('passed'),
    failed: primary('failed'),
    error: primary('error'),
    ungradable: primary('ungradable'),
    executionErrors: rows.filter((r) => r.status === 'execution_error').length,
  };
}

/**
 * Whether a row passes the filters. `configuration` matches the
 * configuration's name or the version id. The two flags filter only when
 * true, as the page sends them: `exec_error=1` keeps execution errors,
 * leaving it out keeps everything.
 */
export function matchesFilters(row: RunRow, filters: RunFilters): boolean {
  const config = filters.configuration;
  if (config && row.configuration.name !== config && row.configuration.versionId !== config) {
    return false;
  }
  if (filters.task && row.taskKey !== filters.task) return false;
  if (filters.status && row.status !== filters.status) return false;
  if (filters.scoreStatus && row.primaryScore?.status !== filters.scoreStatus) return false;
  if (filters.hasExecutionError && row.status !== 'execution_error') return false;
  if (filters.ungradable && row.primaryScore?.status !== 'ungradable') return false;
  return true;
}

/** The direction a column sorts in when the page names none: names ascending, figures descending. */
export function defaultDirection(key: RunSortKey): SortDirection {
  return key === 'task' || key === 'configuration' || key === 'repetition' ? 'asc' : 'desc';
}

/** A row with its place in the matrix, for sorting. */
interface Placed {
  row: RunRow;
  task: number;
  config: number;
  finishedMs: number | null;
}

/** The sort value of a column; null sorts last in either direction. */
function sortValue(p: Placed, key: RunSortKey): number | null {
  const { row } = p;
  switch (key) {
    case 'task':
      return p.task;
    case 'configuration':
      return p.config;
    case 'repetition':
      return row.repetition;
    case 'attempts':
      return row.attempts;
    case 'status':
      return RUN_STATUSES.indexOf(row.status);
    case 'score':
      return row.primaryScore ? SCORE_STATUSES.indexOf(row.primaryScore.status) : null;
    case 'duration':
      return row.durationS;
    case 'tokens':
      return row.tokens?.total ?? null;
    case 'cost':
      return row.costUsd;
    case 'finished':
      return p.finishedMs;
  }
}

/**
 * Sorts by `key` in `dir`; ties, and the default, follow the matrix: task
 * (in the experiment's order), then configuration (baseline first), then
 * repetition. Rows without a value for the column (no score yet, still
 * running) go last whichever way the column sorts.
 */
export function sortRows(placed: Placed[], key: RunSortKey, dir: SortDirection): RunRow[] {
  const matrix = (a: Placed, b: Placed) =>
    key === 'configuration'
      ? a.config - b.config || a.task - b.task || a.row.repetition - b.row.repetition
      : a.task - b.task || a.config - b.config || a.row.repetition - b.row.repetition;
  const sign = dir === 'asc' ? 1 : -1;
  return [...placed]
    .sort((a, b) => {
      const va = sortValue(a, key);
      const vb = sortValue(b, key);
      if (va === null || vb === null) {
        if (va !== vb) return va === null ? 1 : -1;
      } else if (va !== vb) {
        return (va - vb) * sign;
      }
      return key === 'task' || key === 'configuration' ? matrix(a, b) * sign : matrix(a, b);
    })
    .map((p) => p.row);
}

/** GET /experiments/:id/runs: the rows that pass `filters`, sorted, and the counts over every run. */
export function runList(input: RunListInput, filters: RunFilters): RunListResult {
  const tasks = new Map(input.tasks.map((t) => [t.id, t]));
  const configs = new Map(input.configs.map((c) => [c.versionId, c]));
  const taskOrder = new Map(input.experiment.taskIds.map((id, i) => [id, i]));
  const order = new Map(configOrder(input.experiment).map((id, i) => [id, i]));
  const placed: Placed[] = input.runs.map((run) => {
    const task = tasks.get(run.taskId);
    const config = configs.get(run.configurationVersionId);
    if (!task || !config) {
      throw new Error(`run ${run.id} names a task or configuration outside its experiment`);
    }
    return {
      row: runRowView(input.experiment, run, {
        task,
        config,
        primary: input.primaryScores.get(run.id),
        evaluations: input.evaluations.get(run.id) ?? [],
        judge: input.judge,
      }),
      task: taskOrder.get(run.taskId) ?? Number.MAX_SAFE_INTEGER,
      config: order.get(run.configurationVersionId) ?? Number.MAX_SAFE_INTEGER,
      finishedMs: run.finishedAt?.getTime() ?? null,
    };
  });
  const key = filters.sort ?? 'task';
  const rows = sortRows(
    placed.filter((p) => matchesFilters(p.row, filters)),
    key,
    filters.dir ?? defaultDirection(key),
  );
  return {
    rows,
    matched: rows.length,
    summary: runSummary(placed.map((p) => p.row)),
  };
}
