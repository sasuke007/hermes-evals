/**
 * Which evaluation a run's scores come from, and what happened to any newer
 * one (plan 9.4, UI_FLOWS 18): the inspector's RunEvaluationView and the
 * Runs tab's `generation` and `rescorePending`.
 *
 * A run has at most one current evaluation (completed, not superseded:
 * evaluations_current_uq) and at most one queued or running
 * (evaluations_in_flight_uq). A re-score keeps the run `scored` and its
 * current result shown until the new generation publishes; a re-score whose
 * job died on every try is `failed` and leaves the previous result current.
 */
import type { PendingEvaluationView, RunEvaluationView } from '@hermes-evals/shared';
import type { EvaluationRecord } from './rows.js';

/** The evaluation columns these views read; never the answer, which can be large. */
export type EvaluationStateRecord = Pick<
  EvaluationRecord,
  | 'id'
  | 'runId'
  | 'generation'
  | 'status'
  | 'cause'
  | 'error'
  | 'requestedAt'
  | 'finishedAt'
  | 'supersededAt'
>;

/** What the inspector says when a failed re-score recorded no reason (the dead letter always does). */
const UNKNOWN_FAILURE = 'grading failed; the worker log has the error';

/** A queued or running evaluation, as the views and the Re-score answer show it. */
export function pendingEvaluationView(
  row: Pick<EvaluationStateRecord, 'id' | 'generation' | 'status' | 'cause' | 'requestedAt'>,
): PendingEvaluationView | null {
  if (row.status !== 'queued' && row.status !== 'running') return null;
  return {
    evaluationId: row.id,
    generation: row.generation,
    status: row.status,
    cause: row.cause,
    requestedAt: row.requestedAt.toISOString(),
  };
}

/**
 * The run's current evaluation among its rows: completed and not superseded.
 * The views load the scores of exactly this one, so the scores, the
 * generation and the pending re-score they show come from one read.
 */
export function currentEvaluationOf(
  rows: readonly EvaluationStateRecord[],
): EvaluationStateRecord | null {
  return rows.find((row) => row.status === 'completed' && row.supersededAt === null) ?? null;
}

/** The run's evaluation state from every evaluation it has (any order). */
export function runEvaluationView(rows: readonly EvaluationStateRecord[]): RunEvaluationView {
  const current = currentEvaluationOf(rows);
  let pending: PendingEvaluationView | null = null;
  let newest: EvaluationStateRecord | null = null;
  for (const row of rows) {
    pending ??= pendingEvaluationView(row);
    if (!newest || row.generation > newest.generation) newest = row;
  }
  return {
    generation: current?.generation ?? null,
    pending,
    // Only the newest: a later re-score, pending or published, replaces the failure.
    lastFailure:
      newest?.status === 'failed'
        ? {
            generation: newest.generation,
            error: newest.error ?? UNKNOWN_FAILURE,
            finishedAt: (newest.finishedAt ?? newest.requestedAt).toISOString(),
          }
        : null,
  };
}

/** No evaluation yet: a run before its first score set. */
export const NO_EVALUATION: RunEvaluationView = {
  generation: null,
  pending: null,
  lastFailure: null,
};

/** Whether a re-score of the run is waiting or running; its shown result is still the previous one. */
export const rescorePending = (view: RunEvaluationView): boolean =>
  view.pending?.cause === 'rescore';
