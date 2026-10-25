/**
 * The comparison's cache (plan 10.3): keyed by experiment, candidate, key,
 * filter, results revision, status and configuration names, so the same
 * question is answered from memory while nothing moved, each candidate apart,
 * and afresh after every kind of change the 0001 triggers count: an
 * execution error, a retry, a cancellation and a re-score, and after a
 * completion, a pause or a rename, which move no run. On PGlite with the
 * real triggers; a hit is the very same object.
 */
import { eq } from 'drizzle-orm';
import type { ComparisonView } from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { rescoreRun } from '../../../test/support/seed.js';
import {
  attempts,
  configurations,
  configurationVersions,
  evaluations,
  experiments,
  runs,
} from '../../database/schema/index.js';
import { reconcileExperiment } from '../reconcile.js';
import {
  at,
  cancelled,
  errored,
  insertVersion,
  launch,
  pause,
  scored,
  seedWorld,
  start,
  type World,
} from '../views/seed.support-spec.js';
import { ComparisonService } from './comparison.service.js';

let t: TestDatabase;
let w: World;
let experimentId: string;
let run: (key: string) => string;
let service: ComparisonService;

beforeEach(async () => {
  t = await createTestDatabase();
  // Three tasks for the test that needs a verdict; the experiments here select two unless it says.
  w = await seedWorld(t.db, { tasks: 3 });
  const launched = await launch(t.db, w, { tasks: [0, 1] });
  experimentId = launched.experiment.id;
  run = launched.run;
  service = new ComparisonService(t.db);
});

afterEach(async () => {
  await t.close();
});

const view = (query = {}) => service.comparison(experimentId, query);

const cellOf = (v: ComparisonView, runId: string) => {
  const cell = v.rows
    .flatMap((r) => [...r.baseline, ...r.candidate])
    .find((c) => c.runId === runId);
  if (!cell) throw new Error(`no cell for run ${runId}`);
  return cell;
};

const revision = async (id = experimentId) => {
  const [row] = await t.db
    .select({ revision: experiments.resultsRevision })
    .from(experiments)
    .where(eq(experiments.id, id));
  return row!.revision;
};

/** Asks again after `change`: a different answer that shows it, then that one from memory. */
async function freshAfter(
  change: () => Promise<unknown>,
): Promise<[ComparisonView, ComparisonView]> {
  const before = await view();
  expect(await view()).toBe(before);
  await change();
  const after = await view();
  expect(after).not.toBe(before);
  expect(await view()).toBe(after);
  return [before, after];
}

describe('a hit', () => {
  it('is the same answer while nothing moved, one per candidate, key and filter', async () => {
    const first = await view();
    expect(await view()).toBe(first);
    // The default candidate is the first: the same question.
    expect(await view({ candidate: w.candidateVersionId })).toBe(first);
    const improved = await view({ filter: 'improved' });
    const answer = await view({ key: 'answer' });
    expect(improved).not.toBe(first);
    expect(answer).not.toBe(first);
    expect(answer.scoreKey).toBe('answer');
    expect(await view({ filter: 'improved' })).toBe(improved);
    expect(await view({ key: 'answer' })).toBe(answer);
  });

  it('is kept while a re-score waits, since the run still shows its current result', async () => {
    await scored(t.db, w, run('a/base/1'), { startedAt: at(0), durationS: 5, status: 'passed' });
    const before = await view();
    const [current] = await t.db
      .select()
      .from(evaluations)
      .where(eq(evaluations.runId, run('a/base/1')));
    await t.db.insert(evaluations).values({
      runId: run('a/base/1'),
      attemptId: current!.attemptId,
      cause: 'rescore',
      generation: 2,
    });
    expect(await view()).toBe(before);
    expect(cellOf(before, run('a/base/1')).scoreStatus).toBe('passed');
  });
});

describe('two candidates', () => {
  it('answers each apart, each from memory on a repeat and never for the other', async () => {
    const second = await insertVersion(t.db, 'with-skill', { toolsets: ['file'] });
    const two = await launch(t.db, w, {
      name: 'two candidates',
      moreCandidates: [second],
      tasks: [0, 1],
    });
    await scored(t.db, w, two.run('a/cand/1'), {
      startedAt: at(0),
      durationS: 5,
      status: 'passed',
    });
    await scored(t.db, w, two.run('a/cand2/1'), {
      startedAt: at(0),
      durationS: 5,
      status: 'failed',
    });
    const ask = (candidate?: string) =>
      service.comparison(two.experiment.id, candidate === undefined ? {} : { candidate });

    const first = await ask();
    const other = await ask(second);
    expect(other).not.toBe(first);
    expect(first.candidate.versionId).toBe(w.candidateVersionId);
    expect(other.candidate).toMatchObject({ versionId: second, name: 'with-skill' });
    expect(first.passCounts.candidate).toEqual({ passed: 1, counted: 1 });
    expect(other.passCounts.candidate).toEqual({ passed: 0, counted: 1 });
    expect(cellOf(other, two.run('a/cand2/1')).scoreStatus).toBe('failed');
    expect(() => cellOf(other, two.run('a/cand/1'))).toThrow();
    expect(other.candidates.map((c) => c.configuration.versionId)).toEqual([
      w.candidateVersionId,
      second,
    ]);
    expect(await ask(second)).toBe(other);
    expect(await ask(w.candidateVersionId)).toBe(first);
    expect(await ask()).toBe(first);

    // Asked for the second first, a new service still answers the default its own.
    const fresh = new ComparisonService(t.db);
    expect(
      (await fresh.comparison(two.experiment.id, { candidate: second })).candidate.versionId,
    ).toBe(second);
    expect((await fresh.comparison(two.experiment.id, {})).candidate.versionId).toBe(
      w.candidateVersionId,
    );
  });
});

describe('a miss after every change of the results revision', () => {
  it('after an execution error', async () => {
    const id = run('a/base/1');
    const attemptId = await start(t.db, w, id, at(0));
    const [before, after] = await freshAfter(async () => {
      const r0 = await revision();
      await t.db.transaction(async (tx) => {
        await tx
          .update(attempts)
          .set({
            status: 'execution_error',
            finishedAt: at(5),
            durationMs: 5000,
            exitCode: 1,
            errorCategory: 'timeout',
            errorMessage: 'no final response within 300 s',
          })
          .where(eq(attempts.id, attemptId));
        await tx
          .update(runs)
          .set({ status: 'execution_error', finishedAt: at(5) })
          .where(eq(runs.id, id));
      });
      expect(await revision()).toBeGreaterThan(r0);
    });
    expect(cellOf(before, id)).toMatchObject({ runStatus: 'running', durationS: null });
    expect(cellOf(after, id)).toMatchObject({
      runStatus: 'execution_error',
      scoreStatus: null,
      durationS: 5,
      comment: 'execution_error · timeout: no final response within 300 s',
    });
    expect(after.passCounts.baseline).toEqual({ passed: 0, counted: 1 });
  });

  it('after a retry', async () => {
    const id = run('a/base/1');
    await errored(t.db, w, id, { startedAt: at(0), durationS: 5, category: 'provider' });
    const [before, after] = await freshAfter(() =>
      t.db
        .update(runs)
        .set({ status: 'queued', finishedAt: null, nextTrigger: 'user_retry' })
        .where(eq(runs.id, id)),
    );
    expect(cellOf(before, id).runStatus).toBe('execution_error');
    expect(cellOf(after, id)).toMatchObject({ runStatus: 'queued', comment: null, attempt: 1 });
    expect(after.passCounts.baseline).toEqual({ passed: 0, counted: 0 });
  });

  it('after a cancellation', async () => {
    const id = run('b/cand/2');
    const [before, after] = await freshAfter(() => cancelled(t.db, id, at(3)));
    expect(cellOf(before, id).runStatus).toBe('queued');
    expect(cellOf(after, id)).toMatchObject({ runStatus: 'cancelled', scoreStatus: null });
    expect(after.progress).toEqual({ scored: 0, total: 8 });
  });

  it('after a re-score publishes', async () => {
    const id = run('a/cand/1');
    await scored(t.db, w, id, { startedAt: at(0), durationS: 5, status: 'passed' });
    const [before, after] = await freshAfter(() => rescoreRun(t.db, id, 'failed'));
    expect(cellOf(before, id)).toMatchObject({ scoreStatus: 'passed', comment: 'passed' });
    expect(cellOf(after, id)).toMatchObject({ scoreStatus: 'failed', comment: 're-scored failed' });
    expect(after.passCounts.candidate).toEqual({ passed: 0, counted: 1 });
  });

  it('after the experiment completes or pauses, which moves no run', async () => {
    // A verdict needs 3 tasks.
    ({
      experiment: { id: experimentId },
      run,
    } = await launch(t.db, w, { name: 'three tasks' }));
    const [, paused] = await freshAfter(() => pause(t.db, experimentId, 'user', at(1)));
    expect(paused).toMatchObject({ experimentStatus: 'paused', provisional: true });

    for (const key of ['a/base/1', 'a/base/2', 'a/cand/1', 'a/cand/2']) {
      await scored(t.db, w, run(key), { startedAt: at(2), durationS: 5, status: 'passed' });
    }
    for (const key of ['c/base/1', 'c/base/2', 'c/cand/1', 'c/cand/2']) {
      await scored(t.db, w, run(key), { startedAt: at(2), durationS: 5, status: 'passed' });
    }
    for (const key of ['b/base/1', 'b/base/2', 'b/cand/1', 'b/cand/2']) {
      await scored(t.db, w, run(key), { startedAt: at(2), durationS: 5, status: 'failed' });
    }
    const settledWhilePaused = await view();
    expect(settledWhilePaused.statistics).toMatchObject({
      verdict: 'provisional',
      provisional: true,
    });
    const r0 = await revision();
    await t.db.transaction((tx) => reconcileExperiment(tx, experimentId));
    expect(await revision()).toBe(r0);
    const completed = await view();
    expect(completed).not.toBe(settledWhilePaused);
    expect(completed).toMatchObject({ experimentStatus: 'completed', provisional: false });
    expect(completed.statistics).toMatchObject({ verdict: 'inconclusive', provisional: false });
    expect(completed.candidates.map((c) => c.verdict)).toEqual(['inconclusive']);
  });
});

describe('a configuration renamed, which moves no run', () => {
  it('answers a settled experiment afresh with the new name, its sentence included', async () => {
    // One repetition: the not-computable sentence names both configurations.
    const once = await launch(t.db, w, { name: 'once', repetitions: 1, tasks: [0, 1] });
    for (const key of ['a/base/1', 'a/cand/1', 'b/base/1', 'b/cand/1']) {
      await scored(t.db, w, once.run(key), { startedAt: at(0), durationS: 5, status: 'passed' });
    }
    await t.db.transaction((tx) => reconcileExperiment(tx, once.experiment.id));
    const ask = () => service.comparison(once.experiment.id, {});
    const before = await ask();
    const figures = await service.verdictFigures(once.experiment.id);
    expect(before).toMatchObject({
      experimentStatus: 'completed',
      candidate: { name: 'with-mcp' },
      statisticsUnavailable: { reason: 'single_repetition' },
    });
    expect(before.statisticsUnavailable!.message).toContain('with-mcp 1.00');
    expect(await ask()).toBe(before);

    const r0 = await revision(once.experiment.id);
    const [version] = await t.db
      .select({ configurationId: configurationVersions.configurationId })
      .from(configurationVersions)
      .where(eq(configurationVersions.id, w.candidateVersionId));
    await t.db
      .update(configurations)
      .set({ name: 'invoice-db-v2' })
      .where(eq(configurations.id, version!.configurationId));
    expect(await revision(once.experiment.id)).toBe(r0);

    const after = await ask();
    expect(after).not.toBe(before);
    expect(after.candidate.name).toBe('invoice-db-v2');
    expect(after.candidates.map((c) => c.configuration.name)).toEqual(['invoice-db-v2']);
    expect(after.secondary.map((r) => r.configuration.name)).toEqual(['baseline', 'invoice-db-v2']);
    expect(after.statisticsUnavailable!.message).toContain('invoice-db-v2 1.00');
    expect(after.statisticsUnavailable!.message).not.toContain('with-mcp');
    expect(await ask()).toBe(after);
    const renamed = await service.verdictFigures(once.experiment.id);
    expect(renamed).not.toBe(figures);
    const stats = renamed!.byCandidate.get(w.candidateVersionId)!;
    expect(!stats.computable && stats.message).toContain('invoice-db-v2');
  });
});

describe('the verdict figures the views read', () => {
  it('are cached by revision and status like the comparison', async () => {
    const first = await service.verdictFigures(experimentId);
    expect(await service.verdictFigures(experimentId)).toBe(first);
    await scored(t.db, w, run('a/base/1'), { startedAt: at(0), durationS: 5, status: 'passed' });
    const second = await service.verdictFigures(experimentId);
    expect(second).not.toBe(first);
    expect(second!.byCandidate.get(w.candidateVersionId)!.baseline).toEqual({
      passed: 1,
      counted: 1,
      rate: 1,
    });
    expect(await service.verdictFigures('01NOPE')).toBeNull();
  });
});
