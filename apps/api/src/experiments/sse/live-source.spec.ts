/**
 * DbLiveSource over PGlite with the real triggers: the cheap version moves
 * with every change the stream sends (a run starting, finishing, being
 * scored; a pause; the breaker) and not otherwise, and the live state agrees
 * with GET /experiments/:id, so a subscriber and a refetch never disagree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { ExperimentViewsService } from '../views/experiment-views.service.js';
import {
  at,
  errored,
  events,
  fail,
  launch,
  pause,
  scored,
  seedWorld,
  start,
  tokens,
} from '../views/seed.support-spec.js';
import { diffEvents, initialEvents } from './experiment-diff.js';
import { DbLiveSource } from './live-source.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestDatabase;
let source: DbLiveSource;

beforeEach(async () => {
  t = await createTestDatabase();
  source = new DbLiveSource(t.db);
});

afterEach(async () => {
  await t.close();
});

describe('DbLiveSource', () => {
  it('answers null for an unknown experiment', async () => {
    await expect(source.version('01NOPE')).resolves.toBeNull();
  });

  it('moves its version with every change the stream reports, and only then', async () => {
    const w = await seedWorld(t.db);
    const { experiment, run } = await launch(t.db, w);
    const v0 = await source.version(experiment.id);
    expect(v0).not.toBeNull();

    const attempt = await start(t.db, w, run('a/base/1'), at(1));
    const v1 = await source.version(experiment.id);
    expect(v1).not.toBe(v0);

    // Events stream into the inspector, not into this stream: no new version.
    await events(t.db, attempt, [at(2), at(3)]);
    expect(await source.version(experiment.id)).toBe(v1);

    await scored(t.db, w, run('a/base/2'), {
      startedAt: at(1),
      durationS: 5,
      status: 'passed',
      costUsd: 0.01,
    });
    const v2 = await source.version(experiment.id);
    expect(v2).not.toBe(v1);

    await pause(t.db, experiment.id, 'user', at(10));
    const v3 = await source.version(experiment.id);
    expect(v3).not.toBe(v2);
  });

  it('reads the state GET /experiments/:id shows', async () => {
    const w = await seedWorld(t.db);
    const { experiment, run } = await launch(t.db, w);
    await scored(t.db, w, run('a/base/1'), {
      startedAt: at(0),
      durationS: 10,
      status: 'passed',
      tokens: tokens(1000),
      costUsd: 0.01,
    });
    await errored(t.db, w, run('b/cand/1'), {
      startedAt: at(0),
      durationS: 4,
      category: 'timeout',
    });
    await start(t.db, w, run('a/cand/1'), at(12));

    const live = await source.state(experiment.id);
    const detail = await new ExperimentViewsService(t.db).detail(experiment.id, at(20));
    expect(live.counts).toEqual(detail.counts);
    expect(live.spend).toEqual(detail.spend);
    expect(live.doneRuns).toBe(1);
    expect(live.runs.size).toBe(8);
    expect(live.runs.get(run('a/base/1'))).toEqual({
      id: run('a/base/1'),
      status: 'scored',
      attempt: 1,
      primaryScore: { key: 'answer', status: 'passed', score: 1 },
      finishedAt: at(10).toISOString(),
      generation: 1,
      rescorePending: false,
      feed: detail.feed.find((f) => f.runId === run('a/base/1')),
    });
    expect(live.runs.get(run('a/cand/1'))).toMatchObject({
      status: 'running',
      attempt: 1,
      feed: null,
    });
    expect(live.runs.get(run('b/cand/1'))?.feed).toMatchObject({ result: 'execution_error' });

    // Every event the stream would send from it parses (the hub validates them too).
    const empty = { ...live, runs: new Map() };
    expect(initialEvents(live, at(20).toISOString())).toHaveLength(2);
    expect(
      diffEvents(empty, live, at(20).toISOString()).filter((e) => e.type === 'feed'),
    ).toHaveLength(2);
  });

  it('carries the failure view while the experiment is failed', async () => {
    const w = await seedWorld(t.db);
    const { experiment, run } = await launch(t.db, w);
    const attemptId = await errored(t.db, w, run('a/cand/1'), {
      startedAt: at(0),
      durationS: 1,
      category: 'provider',
      message: 'Nous Portal answered 401',
    });
    await fail(t.db, experiment.id, {
      at: at(2).toISOString(),
      threshold: 1,
      category: 'provider',
      exit_code: 1,
      message: 'Nous Portal answered 401',
      stderr_first_line: null,
      attempt_id: attemptId,
      run_id: run('a/cand/1'),
    });
    const live = await source.state(experiment.id);
    expect(live).toMatchObject({
      status: 'failed',
      pauseReason: null,
      doneRuns: 1,
      failure: {
        category: 'provider',
        identicalIn: 1,
        fix: { label: 'check Model access', to: '/system' },
      },
    });
    source.forget(experiment.id);
  });
});
