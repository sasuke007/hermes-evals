/**
 * Database reads behind the experiment views. Plain functions over AppDb, so
 * they run on node-postgres in production and PGlite in tests; each reads a
 * fixed number of statements whatever the experiment's size (never one per
 * run), and the pure builders beside them turn the rows into view models.
 *
 * A run's result is its current evaluation (completed, not superseded) and
 * that evaluation's primary score; both are unique per run and per
 * evaluation (evaluations_current_uq, scores_evaluation_primary_uq), so the
 * joins never multiply runs.
 */
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  WORKER_TIMEOUT_MS,
  type ExecutionErrorCategory,
  type Provider,
  type RunCounts,
} from '@hermes-evals/shared';
import {
  attempts,
  configurations,
  configurationVersions,
  evaluations,
  experiments,
  mcpServers,
  mcpServerVersions,
  runEvents,
  runs,
  scores,
  suites,
  tasks,
  workers,
} from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import type { ArmMoney, RunFacts } from './facts.js';
import { emptyCounts } from './numbers.js';

export type ExperimentRow = typeof experiments.$inferSelect;
export type SuiteRow = typeof suites.$inferSelect;

export async function experimentById(db: AppDb, id: string): Promise<ExperimentRow | null> {
  const [row] = await db.select().from(experiments).where(eq(experiments.id, id));
  return row ?? null;
}

/** Every experiment, newest first (ULIDs break ties in creation order). */
export function experimentsNewestFirst(db: AppDb): Promise<ExperimentRow[]> {
  return db.select().from(experiments).orderBy(desc(experiments.createdAt), desc(experiments.id));
}

/** Runs by status, per experiment; an experiment with no runs gets all zeros. */
export async function runCountsOf(
  db: AppDb,
  experimentIds: readonly string[],
): Promise<Map<string, RunCounts>> {
  const out = new Map(experimentIds.map((id) => [id, emptyCounts()]));
  if (experimentIds.length === 0) return out;
  const rows = await db
    .select({
      experimentId: runs.experimentId,
      status: runs.status,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(runs)
    .where(inArray(runs.experimentId, [...experimentIds]))
    .groupBy(runs.experimentId, runs.status);
  for (const row of rows) {
    const counts = out.get(row.experimentId);
    if (counts) counts[row.status] = row.n;
  }
  return out;
}

/**
 * Attempt money per experiment and configuration version, over every attempt
 * (a retried run's earlier attempts were paid for too).
 */
export async function armMoneyOf(
  db: AppDb,
  experimentIds: readonly string[],
): Promise<Map<string, ArmMoney[]>> {
  const out = new Map<string, ArmMoney[]>(experimentIds.map((id) => [id, []]));
  if (experimentIds.length === 0) return out;
  const rows = await db
    .select({
      experimentId: runs.experimentId,
      configurationVersionId: runs.configurationVersionId,
      finishedAttempts:
        sql<number>`count(*) filter (where ${attempts.status} <> 'running')`.mapWith(Number),
      pricedAttempts: sql<number>`count(${attempts.costUsd})`.mapWith(Number),
      costUsd: sql<number>`coalesce(sum(${attempts.costUsd}), 0)`.mapWith(Number),
      unmeasuredAttempts: sql<number>`count(*) filter (where ${attempts.status} <> 'running'
        and ${attempts.costUsd} is null and ${attempts.sandboxId} is not null)`.mapWith(Number),
    })
    .from(attempts)
    .innerJoin(runs, eq(runs.id, attempts.runId))
    .where(inArray(runs.experimentId, [...experimentIds]))
    .groupBy(runs.experimentId, runs.configurationVersionId);
  for (const { experimentId, ...arm } of rows) out.get(experimentId)?.push(arm);
  return out;
}

/** A configuration version with the fields the experiment views show. */
export interface VersionFacts {
  configurationId: string;
  versionId: string;
  name: string;
  version: number;
  model: string;
  provider: Provider;
  timeBudgetS: number;
}

export async function versionFactsOf(
  db: AppDb,
  versionIds: readonly string[],
): Promise<Map<string, VersionFacts>> {
  if (versionIds.length === 0) return new Map();
  const rows = await db
    .select({
      configurationId: configurations.id,
      versionId: configurationVersions.id,
      name: configurations.name,
      version: configurationVersions.version,
      model: configurationVersions.model,
      provider: configurationVersions.provider,
      timeBudgetS: configurationVersions.timeBudgetS,
    })
    .from(configurationVersions)
    .innerJoin(configurations, eq(configurations.id, configurationVersions.configurationId))
    .where(inArray(configurationVersions.id, [...new Set(versionIds)]));
  return new Map(rows.map((r) => [r.versionId, r]));
}

export async function suitesOf(
  db: AppDb,
  suiteIds: readonly string[],
): Promise<Map<string, SuiteRow>> {
  if (suiteIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(suites)
    .where(inArray(suites.id, [...new Set(suiteIds)]));
  return new Map(rows.map((r) => [r.id, r]));
}

/** Every run of one experiment with its current attempt and current primary score, by id. */
export async function runFactsOf(db: AppDb, experimentId: string): Promise<RunFacts[]> {
  const rows = await db
    .select({
      id: runs.id,
      taskKey: tasks.key,
      taskVersion: tasks.versionNumber,
      configurationVersionId: runs.configurationVersionId,
      repetition: runs.repetition,
      status: runs.status,
      attemptCount: runs.attemptCount,
      finishedAt: runs.finishedAt,
      attemptId: attempts.id,
      attemptStatus: attempts.status,
      errorCategory: attempts.errorCategory,
      startedAt: attempts.startedAt,
      attemptFinishedAt: attempts.finishedAt,
      durationMs: attempts.durationMs,
      tokens: attempts.tokens,
      primaryKey: scores.key,
      primaryStatus: scores.status,
      primaryScore: scores.score,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .leftJoin(attempts, eq(attempts.id, runs.currentAttemptId))
    .leftJoin(
      evaluations,
      and(
        eq(evaluations.runId, runs.id),
        eq(evaluations.status, 'completed'),
        isNull(evaluations.supersededAt),
      ),
    )
    .leftJoin(scores, and(eq(scores.evaluationId, evaluations.id), eq(scores.isPrimary, true)))
    .where(eq(runs.experimentId, experimentId))
    .orderBy(asc(runs.id));
  return rows.map((r) => ({
    id: r.id,
    taskKey: r.taskKey,
    taskVersion: r.taskVersion,
    configurationVersionId: r.configurationVersionId,
    repetition: r.repetition,
    status: r.status,
    attemptCount: r.attemptCount,
    finishedAt: r.finishedAt,
    attempt:
      r.attemptId === null || r.attemptStatus === null || r.startedAt === null
        ? null
        : {
            status: r.attemptStatus,
            errorCategory: r.errorCategory,
            startedAt: r.startedAt,
            finishedAt: r.attemptFinishedAt,
            durationMs: r.durationMs,
            tokens: r.tokens,
          },
    // Only a scored run has a result; a run being re-scored keeps its current one.
    primary:
      r.status === 'scored' && r.primaryKey !== null && r.primaryStatus !== null
        ? { key: r.primaryKey, status: r.primaryStatus, score: r.primaryScore }
        : null,
  }));
}

/** The current attempt of a run that ended in execution_error, as the failure view compares them. */
export interface ErrorRunFacts {
  experimentId: string;
  runId: string;
  category: ExecutionErrorCategory | null;
  errorMessage: string | null;
  stderrTail: string | null;
}

/** Runs in execution_error, with their current attempt's error, for the given experiments. */
export function errorRunsOf(db: AppDb, experimentIds: readonly string[]): Promise<ErrorRunFacts[]> {
  if (experimentIds.length === 0) return Promise.resolve([]);
  return db
    .select({
      experimentId: runs.experimentId,
      runId: runs.id,
      category: attempts.errorCategory,
      errorMessage: attempts.errorMessage,
      stderrTail: attempts.stderrTail,
    })
    .from(runs)
    .innerJoin(attempts, eq(attempts.id, runs.currentAttemptId))
    .where(and(inArray(runs.experimentId, [...experimentIds]), eq(runs.status, 'execution_error')))
    .orderBy(asc(runs.id));
}

/** Time of the newest event any attempt of the experiment recorded, or null. */
export async function lastEventAtOf(db: AppDb, experimentId: string): Promise<Date | null> {
  const [row] = await db
    .select({ ts: sql<number | null>`max(${runEvents.ts})`.mapWith(Number) })
    .from(runEvents)
    .innerJoin(attempts, eq(attempts.id, runEvents.attemptId))
    .innerJoin(runs, eq(runs.id, attempts.runId))
    .where(eq(runs.experimentId, experimentId));
  // mapWith(Number) turns SQL NULL into 0; no event has ts 0 (epoch ms of a real clock).
  return row && row.ts ? new Date(row.ts) : null;
}

/** Worker presence as the Overview's no-worker banner needs it. */
export interface WorkerFacts {
  connected: boolean;
  lastHeartbeatAt: Date | null;
  workerLostRuns: number;
}

/**
 * Whether any worker is live (not stopped, heartbeat within
 * WORKER_TIMEOUT_MS on the database clock), the newest heartbeat of any
 * worker, and the experiment's runs that ever lost an attempt to a stopped
 * worker (`worker_lost`, set by recovery).
 */
export async function workerFactsOf(db: AppDb, experimentId: string): Promise<WorkerFacts> {
  const [presence] = await db
    .select({
      lastHeartbeatAt: sql<Date | null>`max(${workers.lastHeartbeatAt})`,
      connected: sql<boolean>`coalesce(bool_or(${workers.stoppedAt} is null and ${workers.lastHeartbeatAt} >= now() - (${WORKER_TIMEOUT_MS})::float8 * interval '1 millisecond'), false)`,
    })
    .from(workers);
  const [lost] = await db
    .select({ n: sql<number>`count(distinct ${attempts.runId})`.mapWith(Number) })
    .from(attempts)
    .innerJoin(runs, eq(runs.id, attempts.runId))
    .where(and(eq(runs.experimentId, experimentId), eq(attempts.errorCategory, 'worker_lost')));
  const heartbeat = presence?.lastHeartbeatAt ?? null;
  return {
    connected: presence?.connected === true,
    // An aggregate is not mapped to the column's type: node-postgres gives a Date, PGlite may give a string.
    lastHeartbeatAt: heartbeat === null ? null : new Date(heartbeat),
    workerLostRuns: lost?.n ?? 0,
  };
}

/** An MCP server a configuration version uses, with the variable names its definition reads. */
export interface McpSecretFacts {
  name: string;
  /** stdio env names and http header variables. */
  variables: string[];
}

/** The MCP servers the given configuration versions use (each server once). */
export async function mcpServersOf(
  db: AppDb,
  versionIds: readonly string[],
): Promise<McpSecretFacts[]> {
  if (versionIds.length === 0) return [];
  const rows = await db
    .select({
      name: mcpServers.name,
      envNames: mcpServerVersions.envNames,
      headers: mcpServerVersions.headers,
    })
    .from(configurationVersions)
    .innerJoin(
      mcpServerVersions,
      sql`${mcpServerVersions.id} = any(${configurationVersions.mcpServerVersionIds})`,
    )
    .innerJoin(mcpServers, eq(mcpServers.id, mcpServerVersions.mcpServerId))
    .where(inArray(configurationVersions.id, [...new Set(versionIds)]))
    .orderBy(asc(mcpServers.name));
  const byName = new Map<string, Set<string>>();
  for (const row of rows) {
    const names = byName.get(row.name) ?? new Set<string>();
    for (const env of row.envNames) names.add(env);
    for (const header of row.headers) names.add(header.env);
    byName.set(row.name, names);
  }
  return [...byName].map(([name, variables]) => ({ name, variables: [...variables].sort() }));
}
