/**
 * What one evaluation grades (plan 9.2): the task's verification list and
 * hidden reference, the attempt's final text, the files it left in the
 * workspace and the task's verifier scripts. All of it is stored evidence:
 * blobs and rows that never change once the attempt has finished, so a
 * scoring pass reads the same input however often it is retried.
 *
 * Reads only. Nothing here takes a lock: the claim has already made this
 * delivery the evaluation's owner, and the publish transaction re-checks it.
 */
import { and, asc, eq } from 'drizzle-orm';
import type {
  ArtifactOrigin,
  ArtifactSkipReason,
  JsonValue,
  RunEventPayload,
  RunEventType,
  VerificationEntry,
} from '@hermes-evals/shared';
import {
  artifacts,
  attempts,
  runEvents,
  taskFiles,
  tasks,
  runs,
} from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';

/** One file the attempt left in its workspace, as collection recorded it (plan 8.5). */
export interface ArtifactRecord {
  id: string;
  /** Relative to the workspace, e.g. `out/summary.csv`. */
  path: string;
  origin: ArtifactOrigin;
  size: number;
  /** Null when the file was recorded without content (`skippedReason`). */
  sha256: string | null;
  skippedReason: ArtifactSkipReason | null;
}

/** One file of the task's `verify/` folder, stored as a blob by the suite loader. */
export interface VerifierFileRecord {
  /** Relative to the task folder, e.g. `verify/check.py`. */
  path: string;
  sha256: string;
}

/** One stored event of the attempt, in sequence order. */
export interface EventRecord {
  seq: number;
  ts: number;
  type: RunEventType;
  payload: RunEventPayload;
}

export interface EvaluationEvidence {
  evaluationId: string;
  runId: string;
  attemptId: string;
  task: {
    id: string;
    key: string;
    /** reference.json; null only for a task that was stored without one (never a valid task). */
    reference: JsonValue | null;
    /** Effective params: the loader already applied `answer.path` to the primary (plan 4.2). */
    verification: VerificationEntry[];
  };
  attempt: { id: string; finalText: string | null };
  artifacts: ArtifactRecord[];
  verifierFiles: VerifierFileRecord[];
}

/** The rows an evaluation names, or null when the run or task is gone (it cannot be: no deletes). */
export async function loadEvidence(
  db: AppDb,
  target: { evaluationId: string; runId: string; attemptId: string },
): Promise<EvaluationEvidence | null> {
  const [row] = await db
    .select({
      taskId: tasks.id,
      taskKey: tasks.key,
      reference: tasks.reference,
      verification: tasks.verification,
      finalText: attempts.finalText,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(attempts, and(eq(attempts.id, target.attemptId), eq(attempts.runId, runs.id)))
    .where(eq(runs.id, target.runId));
  if (!row) return null;

  const artifactRows = await db
    .select({
      id: artifacts.id,
      path: artifacts.path,
      origin: artifacts.origin,
      size: artifacts.size,
      sha256: artifacts.sha256,
      skippedReason: artifacts.skippedReason,
    })
    .from(artifacts)
    .where(eq(artifacts.attemptId, target.attemptId))
    .orderBy(asc(artifacts.path));

  const verifierFiles = await db
    .select({ path: taskFiles.path, sha256: taskFiles.sha256 })
    .from(taskFiles)
    .where(and(eq(taskFiles.taskId, row.taskId), eq(taskFiles.kind, 'verifier')))
    .orderBy(asc(taskFiles.path));

  return {
    evaluationId: target.evaluationId,
    runId: target.runId,
    attemptId: target.attemptId,
    task: {
      id: row.taskId,
      key: row.taskKey,
      reference: row.reference,
      verification: row.verification,
    },
    attempt: { id: target.attemptId, finalText: row.finalText },
    artifacts: artifactRows,
    verifierFiles,
  };
}

/**
 * The attempt's events in order. Only trajectory-based scorers read them
 * (trajectory_match, Phase 3), so the scorer context loads them on demand
 * rather than with the rest of the evidence.
 */
export function loadEvents(db: AppDb, attemptId: string): Promise<EventRecord[]> {
  return db
    .select({
      seq: runEvents.seq,
      ts: runEvents.ts,
      type: runEvents.type,
      payload: runEvents.payload,
    })
    .from(runEvents)
    .where(eq(runEvents.attemptId, attemptId))
    .orderBy(asc(runEvents.seq));
}
