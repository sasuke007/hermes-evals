/**
 * What GET /experiments/:id/events sends: the difference between two reads
 * of one experiment, as the shared events (contracts/events.ts). Pure, so the
 * stream's behaviour is tested without a database or timers.
 *
 * A subscriber first gets the current `experiment` and `counts` events, so
 * it starts in step whatever it fetched before connecting. After that only
 * changes: a `run` event per run whose status, attempt, primary score or
 * finish time moved; a `feed` event per run that newly finished (scored or
 * execution_error), oldest first so prepending keeps the feed newest first;
 * `counts` when the counts, the progress or the spend moved; `experiment`
 * last, when the status, pause reason or failure moved (the page refetches
 * the detail on it, and by then the run events have been applied).
 */
import { isDeepStrictEqual } from 'node:util';
import type {
  ExperimentEvent,
  ExperimentFailureView,
  ExperimentSpend,
  ExperimentStatus,
  FeedEntry,
  PauseReason,
  PrimaryScoreView,
  RunCounts,
  RunStatus,
} from '@hermes-evals/shared';

/** One run as the live stream compares it. */
export interface LiveRun {
  id: string;
  status: RunStatus;
  /** The run's attempt count (RunRow.attempts). */
  attempt: number;
  primaryScore: PrimaryScoreView | null;
  finishedAt: string | null;
  /** The run's feed entry once it has finished (scored or execution_error), else null. */
  feed: FeedEntry | null;
}

/** One read of an experiment. */
export interface LiveState {
  status: ExperimentStatus;
  pauseReason: PauseReason | null;
  /** Set exactly while the experiment is failed. */
  failure: ExperimentFailureView | null;
  counts: RunCounts;
  doneRuns: number;
  spend: ExperimentSpend;
  runs: ReadonlyMap<string, LiveRun>;
}

const experimentEvent = (state: LiveState, at: string): ExperimentEvent => ({
  type: 'experiment',
  at,
  status: state.status,
  pauseReason: state.pauseReason,
  failure: state.failure,
});

const countsEvent = (state: LiveState, at: string): ExperimentEvent => ({
  type: 'counts',
  at,
  counts: state.counts,
  doneRuns: state.doneRuns,
  spend: state.spend,
});

/** What a new subscriber gets first: where the experiment stands. */
export function initialEvents(state: LiveState, at: string): ExperimentEvent[] {
  return [experimentEvent(state, at), countsEvent(state, at)];
}

const runChanged = (a: LiveRun, b: LiveRun): boolean =>
  a.status !== b.status ||
  a.attempt !== b.attempt ||
  a.finishedAt !== b.finishedAt ||
  !isDeepStrictEqual(a.primaryScore, b.primaryScore);

/** Everything that changed from `prev` to `next`, in the order the module comment gives. */
export function diffEvents(prev: LiveState, next: LiveState, at: string): ExperimentEvent[] {
  const runs: ExperimentEvent[] = [];
  const feed: FeedEntry[] = [];
  for (const run of next.runs.values()) {
    const before = prev.runs.get(run.id);
    if (before === undefined || runChanged(before, run)) {
      runs.push({
        type: 'run',
        at,
        runId: run.id,
        status: run.status,
        attempt: run.attempt,
        primaryScore: run.primaryScore,
        finishedAt: run.finishedAt,
      });
    }
    // A re-score keeps the finish time: only a new finish is a new completion.
    if (run.feed !== null && (before?.feed ?? null)?.finishedAt !== run.feed.finishedAt) {
      feed.push(run.feed);
    }
  }
  feed.sort((a, b) =>
    a.finishedAt < b.finishedAt ? -1 : a.finishedAt > b.finishedAt ? 1 : a.runId < b.runId ? -1 : 1,
  );
  const events: ExperimentEvent[] = [
    ...runs,
    ...feed.map((entry): ExperimentEvent => ({ type: 'feed', at, entry })),
  ];
  if (
    !isDeepStrictEqual(prev.counts, next.counts) ||
    prev.doneRuns !== next.doneRuns ||
    !isDeepStrictEqual(prev.spend, next.spend)
  ) {
    events.push(countsEvent(next, at));
  }
  if (
    prev.status !== next.status ||
    prev.pauseReason !== next.pauseReason ||
    !isDeepStrictEqual(prev.failure, next.failure)
  ) {
    events.push(experimentEvent(next, at));
  }
  return events;
}
