/**
 * What the comparison reads from Postgres (plan 10.1 and 10.3): one
 * candidate and the baseline, every run of the two configurations for the
 * grid, and the counted runs graded by the selected key as the statistics'
 * input (statistics/contracts.ts).
 *
 * Two callers, one rule for counting runs:
 * - GET /experiments/:id/comparison, inside its REPEATABLE READ READ ONLY
 *   transaction, for the selected candidate and key;
 * - reconcile (plan 7.4 step 3), inside the transaction that holds the
 *   experiment row, once per candidate on the primary key, for the verdict
 *   entries it appends. It relies on `status`, `resultsRevision` and `stats`.
 *
 * A run's result is its current evaluation (completed, not superseded),
 * as experiments/views/queries.ts reads it, so a re-scored run counts once.
 *
 * The read is split in two so both callers read once whatever they then
 * compare: loadExperimentResults (./results.ts) reads the experiment row
 * first (its results revision), then a fixed number of statements for
 * every run of the matrix; comparisonInputsOf picks one candidate and key
 * from that, without the database.
 */
import type {
  ExecutionErrorCategory,
  ExperimentStatus,
  RunStatus,
  ScoreStatus,
} from '@hermes-evals/shared';
import type { AppDb } from '../../database/types.js';
import {
  keySelectionValue,
  type KeySelection,
  type StatsInput,
  type StatsRun,
} from '../../statistics/contracts.js';
import {
  loadExperimentResults,
  type ExperimentResults,
  type RunResult,
  type ScoreResult,
  type TaskResult,
} from './results.js';

/** One run of the grid: every run of the two configurations, counted or not. */
export interface ComparisonRunInput {
  runId: string;
  repetition: number;
  status: RunStatus;
  /** The run's attempt count; 0 until the first attempt starts. */
  attemptCount: number;
  /** The selected key's status once scored; null otherwise (KeySelection has the any_failed rule). */
  keyStatus: ScoreStatus | null;
  /** The current attempt's category when the run ended in execution_error; null otherwise. */
  executionError: ExecutionErrorCategory | null;
  /** How long the current attempt ran, in seconds; null until it has finished. */
  durationS: number | null;
  /**
   * The primary score's comment once scored, whatever key grades the run
   * (RepetitionCell.comment, plan 10.3), or the execution error's line, for
   * the cell's tooltip.
   */
  comment: string | null;
}

/** One selected task, in experiment order, with its runs on each side by repetition. */
export interface ComparisonTaskInput {
  taskKey: string;
  /** The task's version number (plan 4.5). */
  taskVersion: number;
  baseline: ComparisonRunInput[];
  candidate: ComparisonRunInput[];
}

export interface ComparisonInputs {
  experimentId: string;
  status: ExperimentStatus;
  repetitions: number;
  /**
   * The experiment's results revision, read first in the transaction: the
   * last part of the comparison cache key, and the revision a verdict entry
   * is computed from.
   */
  resultsRevision: number;
  baselineVersionId: string;
  /** The candidate compared: the one asked for, else the experiment's first. */
  candidateVersionId: string;
  /** Every candidate of the experiment, in experiment order (the candidate select). */
  candidateVersionIds: string[];
  /** Keys every selected task declares, in the first task's order (the key select). */
  commonKeys: string[];
  /** The selection the runs were graded by, as ComparisonView.scoreKey shows it. */
  scoreKey: string;
  tasks: ComparisonTaskInput[];
  /** Scored and total runs of the whole experiment, every configuration (ComparisonView.progress). */
  progress: { scored: number; total: number };
  /** The counted runs of `tasks`, graded by the selected key; its progress is the two configurations'. */
  stats: StatsInput;
}

/** Why a comparison request names something the experiment does not have: a 400. */
export class ComparisonInputError extends Error {
  constructor(
    readonly code: 'unknown_candidate' | 'unknown_key',
    message: string,
  ) {
    super(message);
    this.name = 'ComparisonInputError';
  }
}

/** The 400 for a candidate the experiment does not test (the baseline included). */
export const unknownCandidate = (experimentId: string, candidate: string): ComparisonInputError =>
  new ComparisonInputError(
    'unknown_candidate',
    `Configuration version ${candidate} is not a candidate of experiment ${experimentId}.`,
  );

// ---------------------------------------------------------------------------
// One candidate and key
// ---------------------------------------------------------------------------

/** Keys every task declares, in the first task's order. */
export function commonKeysOf(taskList: readonly TaskResult[]): string[] {
  const [first, ...rest] = taskList;
  if (!first) return [];
  return first.keys.filter((key) => rest.every((t) => t.keys.includes(key)));
}

/** Ranks a key status for any_failed: failed, then error, then ungradable decide it. */
const ANY_FAILED_ORDER: readonly ScoreStatus[] = ['failed', 'error', 'ungradable'];

/** The selected key's status of a scored run, or null when the run has no such score. */
export function selectedStatus(
  list: readonly ScoreResult[],
  key: KeySelection,
): ScoreStatus | null {
  if (list.length === 0) return null;
  if (key.kind === 'named') return list.find((s) => s.key === key.key)?.status ?? null;
  if (key.kind === 'primary') return list.find((s) => s.primary)?.status ?? null;
  return ANY_FAILED_ORDER.find((status) => list.some((s) => s.status === status)) ?? 'passed';
}

/** Longest execution error message a tooltip carries, as the inspector clips it. */
const MAX_COMMENT = 300;

const clip = (text: string): string =>
  text.length > MAX_COMMENT ? `${text.slice(0, MAX_COMMENT - 1)}…` : text;

/** "execution_error · timeout: no final response within 300 s", as the grid's tooltip reads it. */
export function executionErrorLine(
  category: ExecutionErrorCategory,
  message: string | null,
): string {
  return message
    ? `execution_error · ${category}: ${clip(message)}`
    : `execution_error · ${category}`;
}

function runInput(run: RunResult, key: KeySelection): ComparisonRunInput {
  const scored = run.status === 'scored';
  const category = run.status === 'execution_error' ? (run.errorCategory ?? 'other') : null;
  return {
    runId: run.id,
    repetition: run.repetition,
    status: run.status,
    attemptCount: run.attemptCount,
    keyStatus: scored ? selectedStatus(run.scores, key) : null,
    executionError: category,
    durationS: run.durationS,
    comment:
      category !== null
        ? executionErrorLine(category, run.errorMessage)
        : scored
          ? (run.scores.find((s) => s.primary)?.comment ?? null)
          : null,
  };
}

/** Scored runs and execution errors count (plan 10.1); an execution error never passes. */
function statsRun(run: RunResult, input: ComparisonRunInput): StatsRun | null {
  if (run.status !== 'scored' && run.status !== 'execution_error') return null;
  return {
    passed: input.keyStatus === 'passed',
    keyStatus: input.keyStatus,
    executionError: input.executionError,
    durationS: run.durationS,
    tokens: run.tokens,
  };
}

/**
 * Running, paused or failed: more runs may still count, so a verdict is
 * provisional. Retry failed runs can resume a failed experiment, as its
 * Overview says (Phase 4 question 5).
 */
export const isProvisional = (status: ExperimentStatus): boolean =>
  status === 'running' || status === 'paused' || status === 'failed';

/**
 * One candidate against the baseline, graded by `key`. Throws
 * ComparisonInputError when `candidateVersionId` is not a candidate of the
 * experiment or a named key is missing from a selected task.
 * `candidateVersionId` undefined compares the first candidate.
 */
export function comparisonInputsOf(
  results: ExperimentResults,
  candidateVersionId: string | undefined,
  key: KeySelection,
): ComparisonInputs {
  const candidate = candidateVersionId ?? results.candidateVersionIds[0]!;
  if (!results.candidateVersionIds.includes(candidate)) {
    throw unknownCandidate(results.id, candidate);
  }
  const commonKeys = commonKeysOf(results.tasks);
  if (key.kind === 'named' && !commonKeys.includes(key.key)) {
    const missing = results.tasks.filter((t) => !t.keys.includes(key.key)).map((t) => t.key);
    throw new ComparisonInputError(
      'unknown_key',
      `Score key ${key.key} is not declared by every selected task (missing from ${missing.join(', ')}).`,
    );
  }
  const byTaskAndVersion = new Map<string, RunResult[]>();
  for (const run of results.runs) {
    const k = `${run.taskId}\u0000${run.configurationVersionId}`;
    const list = byTaskAndVersion.get(k);
    if (list) list.push(run);
    else byTaskAndVersion.set(k, [run]);
  }
  const side = (taskId: string, versionId: string) =>
    (byTaskAndVersion.get(`${taskId}\u0000${versionId}`) ?? [])
      .toSorted((a, b) => a.repetition - b.repetition)
      .map((run) => ({ run, input: runInput(run, key) }));

  const taskInputs: ComparisonTaskInput[] = [];
  const statsTasks: StatsInput['tasks'][number][] = [];
  for (const task of results.tasks) {
    const baseline = side(task.id, results.baselineVersionId);
    const candidateRuns = side(task.id, candidate);
    taskInputs.push({
      taskKey: task.key,
      taskVersion: task.versionNumber,
      baseline: baseline.map((r) => r.input),
      candidate: candidateRuns.map((r) => r.input),
    });
    const counted = (list: typeof baseline) =>
      list.flatMap(({ run, input }) => statsRun(run, input) ?? []);
    statsTasks.push({
      taskKey: task.key,
      baseline: counted(baseline),
      candidate: counted(candidateRuns),
    });
  }
  const name = (versionId: string) =>
    results.configs.find((c) => c.ref.versionId === versionId)?.ref.name ?? versionId;
  const progressOf = (list: readonly RunResult[]) => ({
    scored: list.filter((r) => r.status === 'scored').length,
    total: list.length,
  });
  const pair = results.runs.filter(
    (r) =>
      r.configurationVersionId === results.baselineVersionId ||
      r.configurationVersionId === candidate,
  );
  return {
    experimentId: results.id,
    status: results.status,
    repetitions: results.repetitions,
    resultsRevision: results.resultsRevision,
    baselineVersionId: results.baselineVersionId,
    candidateVersionId: candidate,
    candidateVersionIds: [...results.candidateVersionIds],
    commonKeys,
    scoreKey: keySelectionValue(key),
    tasks: taskInputs,
    progress: progressOf(results.runs),
    stats: {
      tasks: statsTasks,
      repetitions: results.repetitions,
      provisional: isProvisional(results.status),
      labels: { baseline: name(results.baselineVersionId), candidate: name(candidate) },
      progress: progressOf(pair),
      costUsd: {
        baseline: results.costUsd.get(results.baselineVersionId) ?? null,
        candidate: results.costUsd.get(candidate) ?? null,
      },
    },
  };
}

/**
 * Reads one comparison's inputs. Read-only; run it inside the caller's
 * transaction, which decides the isolation. Resolves null for an unknown
 * experiment (a 404). Throws ComparisonInputError when `candidateVersionId`
 * is not a candidate of the experiment, or a named key is missing from a
 * selected task. `candidateVersionId` undefined compares the first
 * candidate.
 */
export async function loadComparisonInputs(
  tx: AppDb,
  experimentId: string,
  candidateVersionId: string | undefined,
  key: KeySelection,
): Promise<ComparisonInputs | null> {
  const results = await loadExperimentResults(tx, experimentId);
  return results && comparisonInputsOf(results, candidateVersionId, key);
}
