/**
 * Runs tab fixtures: every run of an experiment as a table row, filtered and
 * sorted like GET /experiments/:id/runs, plus the bulk Re-score and Retry
 * execution results. Rows derive from the experiment matrices in
 * experiments.ts, so the count line reads "120 of 120 runs · 89 passed ·
 * 28 failed", "1 execution error", "2 ungradable" for Skill vs no skill.
 *
 * Scenarios handled here (see scenarios.ts): bulk-refused, plus every
 * experiment scenario through the matrices.
 */
import type {
  BulkRunActionResult,
  RunFilters,
  RunListResult,
  RunModelNeeds,
  RunRow,
  RunSortKey,
  RunSummaryCounts,
} from '@/api/types/runs';
import { CONFIG_VERSIONS } from './configurations';
import { configRef, type ExperimentSeed, primaryKey, type RunSeed, runsOf } from './experiments';
import { TASK_KEYS, taskVerification } from './suites';

/** What a run needs from model access: its configuration's provider and the task's judges. */
export function runNeeds(run: RunSeed): RunModelNeeds {
  const judgeKeys = taskVerification(run.taskKey)
    .filter((v) => v.type === 'llm_judge')
    .map((v) => v.key);
  return {
    provider: CONFIG_VERSIONS[run.config].provider,
    judgeKeys,
    judgeProvider: judgeKeys.length ? 'nous' : null,
  };
}

export function runRow(seed: ExperimentSeed, run: RunSeed): RunRow {
  return {
    id: run.id,
    experimentId: seed.id,
    taskKey: run.taskKey,
    taskVersion: 1,
    configuration: configRef(seed, run.config),
    repetition: run.repetition,
    attempts: run.attempts,
    status: run.status,
    primaryScore: run.primaryStatus
      ? {
          key: primaryKey(run.taskKey),
          status: run.primaryStatus,
          score: run.primaryStatus === 'passed' ? 1 : run.primaryStatus === 'failed' ? 0 : null,
        }
      : null,
    executionErrorCategory: run.category,
    durationS: run.durationS,
    tokens: run.tokens,
    costUsd: run.costUsd,
    finishedAt: run.finishedAt,
    needs: runNeeds(run),
  };
}

export function runSummary(runs: RunSeed[]): RunSummaryCounts {
  const by = (s: string) => runs.filter((r) => r.primaryStatus === s).length;
  return {
    total: runs.length,
    passed: by('passed'),
    failed: by('failed'),
    error: by('error'),
    ungradable: by('ungradable'),
    executionErrors: runs.filter((r) => r.status === 'execution_error').length,
  };
}

const STATUS_ORDER = [
  'queued',
  'running',
  'executed',
  'scoring',
  'scored',
  'execution_error',
  'cancelled',
];
const SCORE_ORDER = ['passed', 'failed', 'error', 'ungradable'];

function sortValue(row: RunRow, key: RunSortKey, configOrder: string[]): number | string {
  switch (key) {
    case 'task':
      return (
        TASK_KEYS.indexOf(row.taskKey) * 1000 +
        configOrder.indexOf(row.configuration.name) * 100 +
        row.repetition
      );
    case 'configuration':
      return (
        configOrder.indexOf(row.configuration.name) * 100000 +
        TASK_KEYS.indexOf(row.taskKey) * 100 +
        row.repetition
      );
    case 'repetition':
      return row.repetition;
    case 'attempts':
      return row.attempts;
    case 'status':
      return STATUS_ORDER.indexOf(row.status);
    case 'score':
      return row.primaryScore ? SCORE_ORDER.indexOf(row.primaryScore.status) : 99;
    case 'duration':
      return row.durationS ?? -1;
    case 'tokens':
      return row.tokens?.total ?? -1;
    case 'cost':
      return row.costUsd ?? -1;
    case 'finished':
      return row.finishedAt ?? '';
  }
}

/** Default sort direction per column: task ascending, numbers and times descending. */
export function defaultDir(key: RunSortKey): 'asc' | 'desc' {
  return key === 'task' || key === 'configuration' || key === 'repetition' ? 'asc' : 'desc';
}

function matches(row: RunRow, filters: RunFilters): boolean {
  const cfg = filters.configuration;
  if (
    cfg &&
    cfg !== 'all' &&
    row.configuration.name !== cfg &&
    row.configuration.versionId !== cfg
  ) {
    return false;
  }
  if (filters.task && filters.task !== 'all' && row.taskKey !== filters.task) return false;
  if (filters.status && row.status !== filters.status) return false;
  if (filters.scoreStatus && row.primaryScore?.status !== filters.scoreStatus) return false;
  if (filters.hasExecutionError && row.status !== 'execution_error') return false;
  if (filters.ungradable && row.primaryScore?.status !== 'ungradable') return false;
  return true;
}

/** GET /experiments/:id/runs with filters and sort. */
export function runListFixture(seed: ExperimentSeed, filters: RunFilters = {}): RunListResult {
  const runs = runsOf(seed);
  const configOrder = [seed.baseline, ...seed.candidates] as string[];
  const key = filters.sort ?? 'task';
  const dir = filters.dir ?? defaultDir(key);
  const rows = runs
    .map((r) => runRow(seed, r))
    .filter((r) => matches(r, filters))
    .sort((a, b) => {
      const va = sortValue(a, key, configOrder);
      const vb = sortValue(b, key, configOrder);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return dir === 'asc' ? cmp : -cmp;
    });
  return { rows, matched: rows.length, summary: runSummary(runs) };
}

/** Bulk Re-score: only scored runs can be re-scored; it never re-executes. */
export function bulkRescoreFixture(
  seed: ExperimentSeed,
  runIds: string[],
  refuseAll: boolean,
): BulkRunActionResult {
  const runs = runsOf(seed);
  const enqueued: string[] = [];
  const refused: BulkRunActionResult['refused'] = [];
  for (const id of runIds) {
    const run = runs.find((r) => r.id === id);
    if (!run) refused.push({ runId: id, reason: 'run not found in this experiment' });
    else if (refuseAll)
      refused.push({
        runId: id,
        reason: 'evaluate-run job could not be enqueued: queue unavailable',
      });
    else if (run.status !== 'scored')
      refused.push({ runId: id, reason: `run is ${run.status}, not scored` });
    else enqueued.push(id);
  }
  return { action: 'rescore', enqueued, refused };
}

/** Bulk Retry execution: only execution_error runs with fewer than 5 attempts. */
export function bulkRetryFixture(
  seed: ExperimentSeed,
  runIds: string[],
  refuseAll: boolean,
): BulkRunActionResult {
  const runs = runsOf(seed);
  const enqueued: string[] = [];
  const refused: BulkRunActionResult['refused'] = [];
  for (const id of runIds) {
    const run = runs.find((r) => r.id === id);
    if (!run) refused.push({ runId: id, reason: 'run not found in this experiment' });
    else if (refuseAll)
      refused.push({
        runId: id,
        reason: 'execute-run job could not be enqueued: queue unavailable',
      });
    else if (run.status !== 'execution_error')
      refused.push({ runId: id, reason: `run is ${run.status}, not execution_error` });
    else if (run.attempts >= 5) refused.push({ runId: id, reason: 'run already has 5 attempts' });
    else enqueued.push(id);
  }
  return { action: 'retry', enqueued, refused };
}
