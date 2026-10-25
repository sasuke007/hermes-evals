/**
 * Reads behind the Runs tab and the run inspector. Plain selects, no locks:
 * every view is a snapshot, and a poll a second later shows what changed.
 */
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { ExtractedAnswer } from '@hermes-evals/shared';
import {
  artifacts,
  attempts,
  configurationVersions,
  configurations,
  evaluations,
  experiments,
  runEvents,
  runs,
  scores,
  suites,
  tasks,
  workers,
} from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import type { PrimaryScoreRecord, RunListRecord } from './run-list.js';
import type {
  ArtifactRecord,
  AttemptRecord,
  ConfigVersionRecord,
  EvaluationRecord,
  EventRecord,
  ExperimentRecord,
  RunRecord,
  ScoreRecord,
  SuiteRecord,
  TaskRecord,
  WorkerRecord,
} from './rows.js';

export async function experimentById(db: AppDb, id: string): Promise<ExperimentRecord | null> {
  const [row] = await db
    .select({
      id: experiments.id,
      name: experiments.name,
      status: experiments.status,
      suiteId: experiments.suiteId,
      taskIds: experiments.taskIds,
      baselineVersionId: experiments.baselineVersionId,
      candidateVersionIds: experiments.candidateVersionIds,
      timeBudgetOverrideS: experiments.timeBudgetOverrideS,
      cancelledAt: experiments.cancelledAt,
    })
    .from(experiments)
    .where(eq(experiments.id, id));
  return row ?? null;
}

const taskColumns = {
  id: tasks.id,
  key: tasks.key,
  versionNumber: tasks.versionNumber,
  position: tasks.position,
  summary: tasks.summary,
  verification: tasks.verification,
  reference: tasks.reference,
  taskYaml: tasks.taskYaml,
};

export async function tasksByIds(db: AppDb, ids: readonly string[]): Promise<TaskRecord[]> {
  if (ids.length === 0) return [];
  return db
    .select(taskColumns)
    .from(tasks)
    .where(inArray(tasks.id, [...ids]));
}

export async function suiteById(db: AppDb, id: string): Promise<SuiteRecord | null> {
  const [row] = await db.select().from(suites).where(eq(suites.id, id));
  return row ?? null;
}

/** The experiment's configuration versions with their configurations' names. */
export async function configVersions(
  db: AppDb,
  versionIds: readonly string[],
): Promise<ConfigVersionRecord[]> {
  if (versionIds.length === 0) return [];
  return db
    .select({
      versionId: configurationVersions.id,
      configurationId: configurationVersions.configurationId,
      name: configurations.name,
      version: configurationVersions.version,
      model: configurationVersions.model,
      provider: configurationVersions.provider,
      baseUrl: configurationVersions.baseUrl,
      maxTurns: configurationVersions.maxTurns,
      timeBudgetS: configurationVersions.timeBudgetS,
    })
    .from(configurationVersions)
    .innerJoin(configurations, eq(configurations.id, configurationVersions.configurationId))
    .where(inArray(configurationVersions.id, [...versionIds]));
}

/** Every run of the experiment with the columns of its current attempt the list shows. */
export async function runListRecords(db: AppDb, experimentId: string): Promise<RunListRecord[]> {
  const rows = await db
    .select({
      id: runs.id,
      taskId: runs.taskId,
      configurationVersionId: runs.configurationVersionId,
      repetition: runs.repetition,
      status: runs.status,
      attemptCount: runs.attemptCount,
      finishedAt: runs.finishedAt,
      attemptStatus: attempts.status,
      errorCategory: attempts.errorCategory,
      durationMs: attempts.durationMs,
      tokens: attempts.tokens,
      costUsd: attempts.costUsd,
    })
    .from(runs)
    .leftJoin(attempts, eq(attempts.id, runs.currentAttemptId))
    .where(eq(runs.experimentId, experimentId));
  return rows.map(({ attemptStatus, errorCategory, durationMs, tokens, costUsd, ...run }) => ({
    ...run,
    attempt:
      attemptStatus === null
        ? null
        : { status: attemptStatus, errorCategory, durationMs, tokens, costUsd },
  }));
}

/** The primary score of each run's current evaluation (completed, not superseded). */
export async function primaryScores(
  db: AppDb,
  experimentId: string,
): Promise<Map<string, PrimaryScoreRecord>> {
  const rows = await db
    .select({
      runId: evaluations.runId,
      key: scores.key,
      status: scores.status,
      score: scores.score,
    })
    .from(scores)
    .innerJoin(evaluations, eq(evaluations.id, scores.evaluationId))
    .innerJoin(runs, eq(runs.id, evaluations.runId))
    .where(
      and(
        eq(runs.experimentId, experimentId),
        eq(evaluations.status, 'completed'),
        isNull(evaluations.supersededAt),
        eq(scores.isPrimary, true),
      ),
    );
  return new Map(rows.map(({ runId, ...score }) => [runId, score]));
}

export async function runById(db: AppDb, id: string): Promise<RunRecord | null> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id));
  return row ?? null;
}

export async function attemptsOf(db: AppDb, runId: string): Promise<AttemptRecord[]> {
  return db.select().from(attempts).where(eq(attempts.runId, runId)).orderBy(asc(attempts.number));
}

/** The attempt columns the event pages need. */
export async function attemptById(
  db: AppDb,
  id: string,
): Promise<Pick<AttemptRecord, 'id' | 'status' | 'startedAt' | 'launchRecord'> | null> {
  const [row] = await db
    .select({
      id: attempts.id,
      status: attempts.status,
      startedAt: attempts.startedAt,
      launchRecord: attempts.launchRecord,
    })
    .from(attempts)
    .where(eq(attempts.id, id));
  return row ?? null;
}

export async function workerById(db: AppDb, id: string): Promise<WorkerRecord | null> {
  const [row] = await db
    .select({
      id: workers.id,
      hostname: workers.hostname,
      lastHeartbeatAt: workers.lastHeartbeatAt,
      sandbox: workers.sandbox,
    })
    .from(workers)
    .where(eq(workers.id, id));
  return row ?? null;
}

/** The run's current evaluation and its scores, or null before the first one is published. */
export async function currentEvaluation(
  db: AppDb,
  runId: string,
): Promise<{ record: EvaluationRecord; scores: ScoreRecord[] } | null> {
  const [record] = await db
    .select()
    .from(evaluations)
    .where(
      and(
        eq(evaluations.runId, runId),
        eq(evaluations.status, 'completed'),
        isNull(evaluations.supersededAt),
      ),
    );
  if (!record) return null;
  const rows = await db.select().from(scores).where(eq(scores.evaluationId, record.id));
  return { record, scores: rows };
}

/** The newest extraction stored for an attempt, by any of its evaluations. */
export async function latestAnswer(db: AppDb, attemptId: string): Promise<ExtractedAnswer | null> {
  const [row] = await db
    .select({ answer: evaluations.answer })
    .from(evaluations)
    .where(and(eq(evaluations.attemptId, attemptId), isNotNull(evaluations.answer)))
    .orderBy(desc(evaluations.generation))
    .limit(1);
  return row?.answer ?? null;
}

/**
 * Most events the inspector reads for one attempt: what the runner may
 * stream (its stdout line cap, AttemptRunnerSettings.maxEvents) and the
 * final events, with room to spare. Attempts stored before that cap could
 * hold more; their timeline shows the first ones.
 */
export const MAX_TIMELINE_EVENTS = 25_000;

const eventColumns = {
  seq: runEvents.seq,
  ts: runEvents.ts,
  type: runEvents.type,
  payload: runEvents.payload,
};

/** The attempt's events in seq order, at most MAX_TIMELINE_EVENTS. */
export async function eventsOf(db: AppDb, attemptId: string): Promise<EventRecord[]> {
  return db
    .select(eventColumns)
    .from(runEvents)
    .where(eq(runEvents.attemptId, attemptId))
    .orderBy(asc(runEvents.seq))
    .limit(MAX_TIMELINE_EVENTS);
}

/** The attempt's events after `after`, in seq order, at most `limit`. */
export async function eventsAfter(
  db: AppDb,
  attemptId: string,
  after: number,
  limit: number,
): Promise<EventRecord[]> {
  return db
    .select(eventColumns)
    .from(runEvents)
    .where(and(eq(runEvents.attemptId, attemptId), gt(runEvents.seq, after)))
    .orderBy(asc(runEvents.seq))
    .limit(limit);
}

/**
 * The tool_use and tool_result events up to `upTo` that rows built from
 * later events need (timeline.ts): every one when `all` (a refusal is drawn
 * on whichever call was running at its time), else those of the given tool
 * call ids and, for results without one, of the given names.
 */
export async function toolEventsUpTo(
  db: AppDb,
  attemptId: string,
  upTo: number,
  wanted: { all: boolean; callIds: readonly string[]; names: readonly string[] },
): Promise<EventRecord[]> {
  if (!wanted.all && wanted.callIds.length === 0 && wanted.names.length === 0) return [];
  const matching = wanted.all
    ? undefined
    : or(
        ...(wanted.callIds.length > 0
          ? [inArray(sql<string>`${runEvents.payload} ->> 'tool_call_id'`, [...wanted.callIds])]
          : []),
        ...(wanted.names.length > 0
          ? [inArray(sql<string>`${runEvents.payload} ->> 'name'`, [...wanted.names])]
          : []),
      );
  return db
    .select(eventColumns)
    .from(runEvents)
    .where(
      and(
        eq(runEvents.attemptId, attemptId),
        lte(runEvents.seq, upTo),
        inArray(runEvents.type, ['tool_use', 'tool_result']),
        matching,
      ),
    )
    .orderBy(asc(runEvents.seq))
    .limit(MAX_TIMELINE_EVENTS);
}

export async function artifactsOf(db: AppDb, attemptId: string): Promise<ArtifactRecord[]> {
  return db.select().from(artifacts).where(eq(artifacts.attemptId, attemptId));
}

/** An artifact of any attempt of the run, or null when it belongs to another run or does not exist. */
export async function artifactOfRun(
  db: AppDb,
  runId: string,
  artifactId: string,
): Promise<ArtifactRecord | null> {
  const [row] = await db
    .select({ artifact: artifacts })
    .from(artifacts)
    .innerJoin(attempts, eq(attempts.id, artifacts.attemptId))
    .where(and(eq(artifacts.id, artifactId), eq(attempts.runId, runId)));
  return row?.artifact ?? null;
}

/** The run of the same task and repetition under configuration version `versionId`. */
export async function twinRun(
  db: AppDb,
  run: Pick<RunRecord, 'experimentId' | 'taskId' | 'repetition'>,
  versionId: string,
): Promise<Pick<RunRecord, 'id' | 'status'> | null> {
  const [row] = await db
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(
      and(
        eq(runs.experimentId, run.experimentId),
        eq(runs.taskId, run.taskId),
        eq(runs.configurationVersionId, versionId),
        eq(runs.repetition, run.repetition),
      ),
    );
  return row ?? null;
}
