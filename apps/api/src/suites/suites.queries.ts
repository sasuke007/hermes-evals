/**
 * Database reads behind the suites endpoints. Plain functions over AppDb, so
 * they run on node-postgres in production and PGlite in tests, and the
 * service composes them with the pure view builders in ./views.
 */
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { ExperimentStatus } from '@hermes-evals/shared';
import {
  configurationVersions,
  configurations,
  evaluations,
  experiments,
  runs,
  scores,
  suiteSources,
  suites,
  taskFiles,
  taskRootFiles,
  tasks,
} from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import type { SourceRow, SuiteRow, TaskFileRow, TaskRootFileRow, TaskRow } from './views/rows.js';

/** Every directory that serves a version, with that version, by suite name. */
export async function currentSuites(db: AppDb): Promise<{ source: SourceRow; suite: SuiteRow }[]> {
  return db
    .select({ source: suiteSources, suite: suites })
    .from(suiteSources)
    .innerJoin(suites, eq(suites.id, suiteSources.currentSuiteId))
    .orderBy(asc(suites.name), asc(suiteSources.path));
}

export async function suiteById(db: AppDb, id: string): Promise<SuiteRow | null> {
  const [row] = await db.select().from(suites).where(eq(suites.id, id));
  return row ?? null;
}

export async function sourceOf(db: AppDb, path: string): Promise<SourceRow | null> {
  const [row] = await db.select().from(suiteSources).where(eq(suiteSources.path, path));
  return row ?? null;
}

/** Every version of one directory, lowest number first. */
export async function versionsOf(db: AppDb, sourcePath: string): Promise<SuiteRow[]> {
  return db
    .select()
    .from(suites)
    .where(eq(suites.sourcePath, sourcePath))
    .orderBy(asc(suites.versionNumber));
}

/** Every version of the given directories, lowest number first within each. */
export async function versionsOfMany(
  db: AppDb,
  sourcePaths: readonly string[],
): Promise<SuiteRow[]> {
  if (sourcePaths.length === 0) return [];
  return db
    .select()
    .from(suites)
    .where(inArray(suites.sourcePath, [...sourcePaths]))
    .orderBy(asc(suites.sourcePath), asc(suites.versionNumber));
}

/** Tasks of the given suite versions, in suite order. */
export async function tasksOf(db: AppDb, suiteIds: readonly string[]): Promise<TaskRow[]> {
  if (suiteIds.length === 0) return [];
  return db
    .select()
    .from(tasks)
    .where(inArray(tasks.suiteId, [...suiteIds]))
    .orderBy(asc(tasks.suiteId), asc(tasks.position));
}

/** Just what the change sets and type summaries need, for many versions at once. */
export async function taskStatesOf(
  db: AppDb,
  suiteIds: readonly string[],
): Promise<Pick<TaskRow, 'suiteId' | 'key' | 'contentHash' | 'valid' | 'verification'>[]> {
  if (suiteIds.length === 0) return [];
  return db
    .select({
      suiteId: tasks.suiteId,
      key: tasks.key,
      contentHash: tasks.contentHash,
      valid: tasks.valid,
      verification: tasks.verification,
    })
    .from(tasks)
    .where(inArray(tasks.suiteId, [...suiteIds]))
    .orderBy(asc(tasks.suiteId), asc(tasks.position));
}

export async function taskByKey(db: AppDb, suiteId: string, key: string): Promise<TaskRow | null> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.suiteId, suiteId), eq(tasks.key, key)));
  return row ?? null;
}

/** Task files of the given tasks, by path. */
export async function filesOf(db: AppDb, taskIds: readonly string[]): Promise<TaskFileRow[]> {
  if (taskIds.length === 0) return [];
  return db
    .select()
    .from(taskFiles)
    .where(inArray(taskFiles.taskId, [...taskIds]))
    .orderBy(asc(taskFiles.taskId), asc(taskFiles.path));
}

/**
 * The root files (task.yaml, prompt.md, reference.json) the loader recorded
 * for the given tasks; versions loaded before Phase 5b have none.
 */
export async function rootFilesOf(
  db: AppDb,
  taskIds: readonly string[],
): Promise<TaskRootFileRow[]> {
  if (taskIds.length === 0) return [];
  return db
    .select()
    .from(taskRootFiles)
    .where(inArray(taskRootFiles.taskId, [...taskIds]))
    .orderBy(asc(taskRootFiles.taskId), asc(taskRootFiles.path));
}

/** Every row of the given task keys across the versions of one directory, lowest suite version first. */
export async function keyRowsInDirectory(
  db: AppDb,
  sourcePath: string,
  keys: readonly string[],
  beforeVersion?: number,
): Promise<{ task: TaskRow; suite: SuiteRow }[]> {
  if (keys.length === 0) return [];
  return db
    .select({ task: tasks, suite: suites })
    .from(tasks)
    .innerJoin(suites, eq(suites.id, tasks.suiteId))
    .where(
      and(
        eq(suites.sourcePath, sourcePath),
        inArray(tasks.key, [...keys]),
        beforeVersion === undefined ? undefined : lt(suites.versionNumber, beforeVersion),
      ),
    )
    .orderBy(asc(suites.versionNumber));
}

/** Experiments launched on the given suite versions, newest first. */
export async function experimentsOn(
  db: AppDb,
  suiteIds: readonly string[],
): Promise<{ id: string; name: string; suiteId: string }[]> {
  if (suiteIds.length === 0) return [];
  return db
    .select({ id: experiments.id, name: experiments.name, suiteId: experiments.suiteId })
    .from(experiments)
    .where(inArray(experiments.suiteId, [...suiteIds]))
    .orderBy(desc(experiments.createdAt), desc(experiments.id));
}

/** Runs of one task under one configuration version of one experiment, counted. */
export interface TaskUsageRow {
  experimentId: string;
  experimentName: string;
  status: ExperimentStatus;
  createdAt: Date;
  /** The task version the experiment ran (one experiment runs one suite version). */
  taskVersion: number;
  /** The suite version the experiment was launched on. */
  suiteVersion: number;
  baselineVersionId: string;
  candidateVersionIds: string[];
  configurationVersionId: string;
  configurationName: string;
  configurationVersion: number;
  total: number;
  /** Runs that finished: scored, or ended in execution_error (which counts as not passed). */
  counted: number;
  /** Scored runs whose current evaluation passed the primary key. */
  passed: number;
}

/**
 * Pass counts of every version of one task key (every row of `key` in the
 * directory: an unchanged task is carried into each new suite version) per
 * experiment and configuration version, with the task and suite versions
 * each experiment ran (Phase 5 section 6.1). A run's score is its current
 * evaluation's primary key: completed and not superseded, at most one per
 * run by the evaluations_current_uq index.
 */
export async function taskUsage(
  db: AppDb,
  sourcePath: string,
  key: string,
): Promise<TaskUsageRow[]> {
  const keyRows = db
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(suites, eq(suites.id, tasks.suiteId))
    .where(and(eq(suites.sourcePath, sourcePath), eq(tasks.key, key)));
  const rows = await db
    .select({
      experimentId: experiments.id,
      experimentName: experiments.name,
      status: experiments.status,
      createdAt: experiments.createdAt,
      taskVersion: tasks.versionNumber,
      suiteVersion: suites.versionNumber,
      baselineVersionId: experiments.baselineVersionId,
      candidateVersionIds: experiments.candidateVersionIds,
      configurationVersionId: runs.configurationVersionId,
      configurationName: configurations.name,
      configurationVersion: configurationVersions.version,
      total: sql<number>`count(*)::int`,
      counted: sql<number>`(count(*) filter (where ${runs.status} in ('scored', 'execution_error')))::int`,
      passed: sql<number>`(count(*) filter (where ${runs.status} = 'scored' and ${scores.status} = 'passed'))::int`,
    })
    .from(runs)
    .innerJoin(experiments, eq(experiments.id, runs.experimentId))
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(suites, eq(suites.id, experiments.suiteId))
    .innerJoin(configurationVersions, eq(configurationVersions.id, runs.configurationVersionId))
    .innerJoin(configurations, eq(configurations.id, configurationVersions.configurationId))
    .leftJoin(
      evaluations,
      and(
        eq(evaluations.runId, runs.id),
        eq(evaluations.status, 'completed'),
        sql`${evaluations.supersededAt} is null`,
      ),
    )
    .leftJoin(scores, and(eq(scores.evaluationId, evaluations.id), eq(scores.isPrimary, true)))
    .where(inArray(runs.taskId, keyRows))
    .groupBy(
      experiments.id,
      tasks.versionNumber,
      suites.versionNumber,
      runs.configurationVersionId,
      configurations.name,
      configurationVersions.version,
    )
    .orderBy(desc(experiments.createdAt), desc(experiments.id));
  return rows.map((r) => ({
    ...r,
    total: Number(r.total),
    counted: Number(r.counted),
    passed: Number(r.passed),
  }));
}
