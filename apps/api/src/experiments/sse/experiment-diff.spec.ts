/**
 * The experiment stream's events from two reads of one experiment: what a
 * subscriber gets first, which changes produce which events, in which order,
 * and that every event parses with the shared ExperimentEventSchema.
 */
import {
  ExperimentEventSchema,
  type ExperimentFailureView,
  type ExperimentSpend,
  type FeedEntry,
  type RunCounts,
} from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { emptyCounts } from '../views/numbers.js';
import { diffEvents, initialEvents, type LiveRun, type LiveState } from './experiment-diff.js';

const AT = '2026-10-24T10:00:05.000Z';

const SPEND: ExperimentSpend = {
  spentUsd: 0,
  ceilingUsd: 5,
  projectedTotalUsd: null,
  remainingEstimateUsd: null,
  unpricedAttempts: 0,
};

const FAILURE: ExperimentFailureView = {
  at: '2026-10-24T10:00:04.000Z',
  threshold: 3,
  category: 'setup',
  message: 'invoice-db failed to start',
  stderrFirstLine: 'Error: INVOICE_DB_URL is not set',
  identicalIn: 3,
  fix: { label: 'check Secrets', to: '/resources/secrets' },
  runId: 'r1',
};

const counts = (patch: Partial<RunCounts>): RunCounts => ({ ...emptyCounts(), ...patch });

const queued = (id: string): LiveRun => ({
  id,
  status: 'queued',
  attempt: 0,
  primaryScore: null,
  finishedAt: null,
  feed: null,
});

const feedOf = (id: string, finishedAt: string, result: FeedEntry['result']): FeedEntry => ({
  runId: id,
  finishedAt,
  taskKey: 'total_due',
  configuration: 'baseline',
  repetition: 1,
  result,
  durationS: 12,
});

const scoredRun = (id: string, finishedAt: string, passed = true): LiveRun => ({
  id,
  status: 'scored',
  attempt: 1,
  primaryScore: { key: 'answer', status: passed ? 'passed' : 'failed', score: passed ? 1 : 0 },
  finishedAt,
  feed: feedOf(id, finishedAt, passed ? 'passed' : 'failed'),
});

function state(runs: LiveRun[], patch: Partial<LiveState> = {}): LiveState {
  const c = counts({});
  for (const run of runs) c[run.status] += 1;
  return {
    status: 'running',
    pauseReason: null,
    failure: null,
    counts: c,
    doneRuns: c.scored,
    spend: SPEND,
    runs: new Map(runs.map((r) => [r.id, r])),
    ...patch,
  };
}

const parsedAll = (events: unknown[]) => events.map((e) => ExperimentEventSchema.parse(e));

describe('initialEvents', () => {
  it('sends where the experiment stands: experiment, then counts', () => {
    const s = state([queued('r1'), queued('r2')]);
    const events = parsedAll(initialEvents(s, AT));
    expect(events).toEqual([
      { type: 'experiment', at: AT, status: 'running', pauseReason: null, failure: null },
      { type: 'counts', at: AT, counts: counts({ queued: 2 }), doneRuns: 0, spend: SPEND },
    ]);
  });
});

describe('diffEvents', () => {
  it('sends nothing when nothing moved', () => {
    const s = state([queued('r1'), scoredRun('r2', '2026-10-24T10:00:01.000Z')]);
    const copy = state([queued('r1'), scoredRun('r2', '2026-10-24T10:00:01.000Z')]);
    expect(diffEvents(s, copy, AT)).toEqual([]);
  });

  it('sends run, feed and counts for runs that started and finished, in that order', () => {
    const before = state([queued('r1'), queued('r2'), queued('r3')]);
    const running: LiveRun = { ...queued('r1'), status: 'running', attempt: 1 };
    const after = state([
      running,
      scoredRun('r2', '2026-10-24T10:00:03.000Z'),
      scoredRun('r3', '2026-10-24T10:00:02.000Z', false),
    ]);
    const events = parsedAll(diffEvents(before, after, AT));
    expect(events.map((e) => e.type)).toEqual(['run', 'run', 'run', 'feed', 'feed', 'counts']);
    expect(events[0]).toEqual({
      type: 'run',
      at: AT,
      runId: 'r1',
      status: 'running',
      attempt: 1,
      primaryScore: null,
      finishedAt: null,
    });
    expect(events[1]).toMatchObject({
      runId: 'r2',
      status: 'scored',
      primaryScore: { key: 'answer', status: 'passed', score: 1 },
      finishedAt: '2026-10-24T10:00:03.000Z',
    });
    // Oldest completion first, so prepending each keeps the feed newest first.
    expect(events.slice(3, 5).map((e) => (e.type === 'feed' ? e.entry.runId : null))).toEqual([
      'r3',
      'r2',
    ]);
    expect(events[5]).toMatchObject({
      type: 'counts',
      counts: counts({ running: 1, scored: 2 }),
      doneRuns: 2,
    });
  });

  it('sends a run event, but no new completion, when a re-score changes the score', () => {
    const before = state([scoredRun('r1', '2026-10-24T10:00:01.000Z', true)]);
    const after = state([scoredRun('r1', '2026-10-24T10:00:01.000Z', false)]);
    const events = parsedAll(diffEvents(before, after, AT));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'run',
        runId: 'r1',
        primaryScore: { key: 'answer', status: 'failed', score: 0 },
      }),
    ]);
  });

  it('sends a new completion when a retried run finishes again', () => {
    const errored: LiveRun = {
      id: 'r1',
      status: 'execution_error',
      attempt: 1,
      primaryScore: null,
      finishedAt: '2026-10-24T10:00:01.000Z',
      feed: feedOf('r1', '2026-10-24T10:00:01.000Z', 'execution_error'),
    };
    const retried = { ...scoredRun('r1', '2026-10-24T10:00:04.000Z'), attempt: 2 };
    const events = parsedAll(
      diffEvents(
        state([errored], { counts: counts({ execution_error: 1 }) }),
        state([retried]),
        AT,
      ),
    );
    expect(events.map((e) => e.type)).toEqual(['run', 'feed', 'counts']);
    expect(events[0]).toMatchObject({ attempt: 2, status: 'scored' });
  });

  it('sends counts when only the spend moved', () => {
    const runs = [queued('r1')];
    const events = diffEvents(
      state(runs),
      state(runs, { spend: { ...SPEND, spentUsd: 0.02, unpricedAttempts: 1 } }),
      AT,
    );
    expect(parsedAll(events)).toEqual([
      expect.objectContaining({
        type: 'counts',
        spend: expect.objectContaining({ spentUsd: 0.02, unpricedAttempts: 1 }),
      }),
    ]);
  });

  it('sends the experiment event last when it pauses, resumes or fails', () => {
    const runs = [queued('r1')];
    const paused = diffEvents(
      state(runs),
      state(runs, { status: 'paused', pauseReason: 'spend_ceiling' }),
      AT,
    );
    expect(parsedAll(paused)).toEqual([
      { type: 'experiment', at: AT, status: 'paused', pauseReason: 'spend_ceiling', failure: null },
    ]);

    const before = state([{ ...queued('r1'), status: 'running', attempt: 1 }]);
    const errored: LiveRun = {
      id: 'r1',
      status: 'execution_error',
      attempt: 1,
      primaryScore: null,
      finishedAt: FAILURE.at,
      feed: feedOf('r1', FAILURE.at, 'execution_error'),
    };
    const failed = state([errored], { status: 'failed', failure: FAILURE, doneRuns: 1 });
    const events = parsedAll(diffEvents(before, failed, AT));
    expect(events.map((e) => e.type)).toEqual(['run', 'feed', 'counts', 'experiment']);
    expect(events[3]).toEqual({
      type: 'experiment',
      at: AT,
      status: 'failed',
      pauseReason: null,
      failure: FAILURE,
    });
  });

  it('sends the experiment event when only the failure view changed', () => {
    const runs = [queued('r1')];
    const a = state(runs, { status: 'failed', failure: FAILURE });
    const b = state(runs, { status: 'failed', failure: { ...FAILURE, identicalIn: 4 } });
    expect(diffEvents(a, b, AT).map((e) => e.type)).toEqual(['experiment']);
  });
});
