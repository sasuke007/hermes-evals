/**
 * One read of an experiment's results, for the comparison and for
 * reconcile's verdict entries (plan 10.1 and 7.4): the experiment row first,
 * so its results revision names the snapshot the rest is read in, then a
 * fixed number of statements whatever the matrix's size: the selected
 * tasks and their declared keys, every run with its current attempt, what
 * each run's attempts cost, and the scores of each run's current evaluation
 * (completed, not superseded; evaluations_current_uq), so a re-scored run
 * counts once. inputs.ts picks a candidate and a key from it.
 *
 * Read-only; the caller's transaction decides the isolation: the
 * comparison's REPEATABLE READ READ ONLY, or reconcile's, which holds the
 * experiment row so no run can change status while it reads.
 */
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  ExecutionErrorCategory,
  ExperimentStatus,
  RunStatus,
  ScoreStatus,
  Tokens,
  VerdictEntry,
  VerificationEntry,
} from '@hermes-evals/shared';
import {
  attempts,
  evaluations,
  experiments,
  runs,
  scores,
  tasks,
} from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import type { ConfigFacts } from '../views/facts.js';
import { versionFactsOf, type VersionFacts } from '../views/queries.js';
import { experimentConfigs } from '../views/snapshot.js';

/** The comparison's transaction: one consistent snapshot, and no writes. */
export const READ_ONLY_SNAPSHOT = {
  isolationLevel: 'repeatable read',
  accessMode: 'read only',
} as const;

/** The experiment row's columns the comparison and reconcile need, read first. */
export interface ExperimentHead {
  id: string;
  status: ExperimentStatus;
  repetitions: number;
  resultsRevision: number;
  verdictRevision: number | null;
  verdictHistory: VerdictEntry[];
  taskIds: string[];
  baselineVersionId: string;
  candidateVersionIds: string[];
}

/** A selected task with the keys its frozen verification declares. */
export interface TaskResult {
  id: string;
  key: string;
  versionNumber: number;
  /** Declared keys, in task.yaml order. */
  keys: string[];
}

/** One score of a run's current evaluation. */
export interface ScoreResult {
  key: string;
  status: ScoreStatus;
  primary: boolean;
  comment: string;
}

/** One run of the matrix with its current attempt, its cost and its current scores. */
export interface RunResult {
  id: string;
  taskId: string;
  configurationVersionId: string;
  repetition: number;
  status: RunStatus;
  attemptCount: number;
  errorCategory: ExecutionErrorCategory | null;
  errorMessage: string | null;
  durationS: number | null;
  /** The current attempt's total tokens; null when they were not metered. */
  tokens: number | null;
  /** Every priced attempt of the run, summed; null when none is priced. */
  costUsd: number | null;
  /** The current evaluation's scores; empty unless the run is scored. */
  scores: ScoreResult[];
}

export interface ExperimentResults extends ExperimentHead {
  /** The baseline, then the candidates, in experiment order. */
  configs: ConfigFacts[];
  /** The selected tasks, in experiment order. */
  tasks: TaskResult[];
  runs: RunResult[];
}

const headColumns = {
  id: experiments.id,
  status: experiments.status,
  repetitions: experiments.repetitions,
  resultsRevision: experiments.resultsRevision,
  verdictRevision: experiments.verdictRevision,
  verdictHistory: experiments.verdictHistory,
  taskIds: experiments.taskIds,
  baselineVersionId: experiments.baselineVersionId,
  candidateVersionIds: experiments.candidateVersionIds,
};

/** The experiment row: the comparison's first read, so its results revision names the snapshot. */
export async function experimentHead(
  db: AppDb,
  experimentId: string,
): Promise<ExperimentHead | null> {
  const [row] = await db
    .select(headColumns)
    .from(experiments)
    .where(eq(experiments.id, experimentId));
  return row ?? null;
}

/** The experiment's configuration versions, the baseline first: their names are part of an answer. */
export function experimentVersions(
  db: AppDb,
  head: ExperimentHead,
): Promise<Map<string, VersionFacts>> {
  return versionFactsOf(db, [head.baselineVersionId, ...head.candidateVersionIds]);
}

/**
 * Every run of the experiment with what the comparison shows of it, in a
 * fixed number of statements. Pass the head, and the versions, when the
 * caller has read them already (the cache check reads both first).
 */
export async function loadExperimentResults(
  db: AppDb,
  experimentId: string,
  head?: ExperimentHead,
  knownVersions?: ReadonlyMap<string, VersionFacts>,
): Promise<ExperimentResults | null> {
  const e = head ?? (await experimentHead(db, experimentId));
  if (!e) return null;
  // One statement after another: every caller passes a transaction, whose one
  // connection runs them in turn anyway, and node-postgres deprecates (pg 9
  // refuses) a query sent while another is still running on the client.
  const versions = knownVersions ?? (await experimentVersions(db, e));
  const taskRows = await db
    .select({
      id: tasks.id,
      key: tasks.key,
      versionNumber: tasks.versionNumber,
      verification: tasks.verification,
    })
    .from(tasks)
    .where(inArray(tasks.id, e.taskIds));
  const runRows = await db
    .select({
      id: runs.id,
      taskId: runs.taskId,
      configurationVersionId: runs.configurationVersionId,
      repetition: runs.repetition,
      status: runs.status,
      attemptCount: runs.attemptCount,
      errorCategory: attempts.errorCategory,
      errorMessage: attempts.errorMessage,
      startedAt: attempts.startedAt,
      finishedAt: attempts.finishedAt,
      durationMs: attempts.durationMs,
      tokens: attempts.tokens,
    })
    .from(runs)
    .leftJoin(attempts, eq(attempts.id, runs.currentAttemptId))
    .where(eq(runs.experimentId, e.id))
    .orderBy(asc(runs.id));
  const costs = await db
    .select({
      runId: attempts.runId,
      priced: sql<number>`count(${attempts.costUsd})`.mapWith(Number),
      costUsd: sql<number>`coalesce(sum(${attempts.costUsd}), 0)`.mapWith(Number),
    })
    .from(attempts)
    .innerJoin(runs, eq(runs.id, attempts.runId))
    .where(eq(runs.experimentId, e.id))
    .groupBy(attempts.runId);
  const scoreRows = await db
    .select({
      runId: evaluations.runId,
      key: scores.key,
      status: scores.status,
      primary: scores.isPrimary,
      comment: scores.comment,
    })
    .from(scores)
    .innerJoin(evaluations, eq(evaluations.id, scores.evaluationId))
    .innerJoin(runs, eq(runs.id, evaluations.runId))
    .where(
      and(
        eq(runs.experimentId, e.id),
        eq(evaluations.status, 'completed'),
        isNull(evaluations.supersededAt),
      ),
    );
  const byTask = new Map(taskRows.map((t) => [t.id, t]));
  const costByRun = new Map(costs.map((c) => [c.runId, c.priced > 0 ? c.costUsd : null]));
  const scoresByRun = new Map<string, ScoreResult[]>();
  for (const { runId, ...score } of scoreRows) {
    const list = scoresByRun.get(runId);
    if (list) list.push(score);
    else scoresByRun.set(runId, [score]);
  }
  return {
    ...e,
    configs: experimentConfigs(e, versions),
    tasks: e.taskIds.flatMap((id) => {
      const t = byTask.get(id);
      return t
        ? [{ id, key: t.key, versionNumber: t.versionNumber, keys: declaredKeys(t.verification) }]
        : [];
    }),
    runs: runRows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      configurationVersionId: r.configurationVersionId,
      repetition: r.repetition,
      status: r.status,
      attemptCount: r.attemptCount,
      errorCategory: r.errorCategory,
      errorMessage: r.errorMessage,
      durationS: secondsOf(r),
      tokens: totalTokens(r.tokens),
      costUsd: costByRun.get(r.id) ?? null,
      // Only a scored run has a result; a run being re-scored keeps its current one.
      scores: r.status === 'scored' ? (scoresByRun.get(r.id) ?? []) : [],
    })),
  };
}

const declaredKeys = (verification: readonly VerificationEntry[]): string[] =>
  verification.map((v) => v.key);

const totalTokens = (tokens: Tokens | null): number | null => tokens?.total ?? null;

/** As views/numbers.ts attemptSeconds: the recorded duration, else start to end; null while it runs. */
function secondsOf(r: {
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
}): number | null {
  if (r.startedAt === null || r.finishedAt === null) return null;
  const ms = r.durationMs ?? r.finishedAt.getTime() - r.startedAt.getTime();
  return Math.max(0, ms) / 1000;
}
