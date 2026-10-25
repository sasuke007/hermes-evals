/**
 * Reconcile's verdict entries (plan 7.4 step 3, plan 10.3) on PGlite with
 * the real triggers: one entry per candidate on the primary key each time a
 * settled experiment's results revision differs from its verdict revision,
 * appended in the statement that moves the verdict revision, with the cause
 * `initial` at the first completion, `rescore` when a re-score moved a
 * completed experiment's results, and `retry` when a retry reopened it and
 * it settled again. The entries' numbers are the comparison's. The world
 * has three tasks, the fewest a verdict needs.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { VerdictEntrySchema, type ScoreStatus, type VerdictEntry } from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { rescoreRun, runningClaim } from '../../test/support/seed.js';
import {
  attempts,
  configurations,
  configurationVersions,
  evaluations,
  experiments,
  runs,
  scores,
} from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import { ComparisonService } from './comparison/comparison.service.js';
import { reconcileExperiment } from './reconcile.js';
import {
  at,
  cancelled,
  errored,
  launch,
  PRICED_MODEL,
  scored,
  seedWorld,
  sha,
  start,
  type World,
} from './views/seed.support-spec.js';

let t: TestDatabase;
let w: World;

beforeEach(async () => {
  t = await createTestDatabase();
  w = await seedWorld(t.db, { tasks: 3 });
});

afterEach(async () => {
  await t.close();
});

const reconcile = (experimentId: string) =>
  t.db.transaction((tx) => reconcileExperiment(tx, experimentId));

async function row(experimentId: string) {
  const [found] = await t.db.select().from(experiments).where(eq(experiments.id, experimentId));
  return found!;
}

/** Scores every run of the matrix `<task>/<config>/<rep>` with the status given for it. */
async function scoreAll(
  run: (key: string) => string,
  statuses: Record<string, ScoreStatus>,
): Promise<void> {
  for (const [key, status] of Object.entries(statuses)) {
    await scored(t.db, w, run(key), { startedAt: at(0), durationS: 10, status });
  }
}

/**
 * a and c: baseline 1 of 2, candidate 2 of 2; b: baseline 0 of 2, candidate
 * 1 of 2. Each task improves by 0.5.
 */
const MATRIX: Record<string, ScoreStatus> = {
  'a/base/1': 'passed',
  'a/base/2': 'failed',
  'a/cand/1': 'passed',
  'a/cand/2': 'passed',
  'b/base/1': 'failed',
  'b/base/2': 'failed',
  'b/cand/1': 'passed',
  'b/cand/2': 'failed',
  'c/base/1': 'passed',
  'c/base/2': 'failed',
  'c/cand/1': 'passed',
  'c/cand/2': 'passed',
};

/** Publishes a queued re-score of a scored run with its single key `answer`, as publish.ts does. */
async function publishRescore(db: AppDb, evaluationId: string, status: ScoreStatus) {
  await db.transaction(async (tx) => {
    const [evaluation] = await tx
      .update(evaluations)
      .set(runningClaim())
      .where(eq(evaluations.id, evaluationId))
      .returning();
    await tx.insert(scores).values({
      evaluationId,
      key: 'answer',
      type: 'json_match',
      status,
      isPrimary: true,
      score: status === 'passed' ? 1 : 0,
      comment: `re-scored ${status}`,
      scorerVersion: 1,
    });
    await tx
      .update(evaluations)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(evaluations.runId, evaluation!.runId),
          eq(evaluations.status, 'completed'),
          isNull(evaluations.supersededAt),
        ),
      );
    await tx
      .update(evaluations)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(evaluations.id, evaluationId));
    await reconcileExperiment(tx, (await experimentOfRun(tx, evaluation!.runId))!);
  });
}

async function experimentOfRun(db: AppDb, runId: string): Promise<string | undefined> {
  const [found] = await db
    .select({ experimentId: runs.experimentId })
    .from(runs)
    .where(eq(runs.id, runId));
  return found?.experimentId;
}

describe('the first completion', () => {
  it('appends one initial entry per candidate, once, with the comparison’s numbers', async () => {
    const { experiment, run } = await launch(t.db, w);
    await scoreAll(run, MATRIX);
    expect(await reconcile(experiment.id)).toBe('completed');
    const done = await row(experiment.id);
    expect(done.verdictRevision).toBe(done.resultsRevision);
    expect(done.verdictHistory).toHaveLength(1);
    const [entry] = done.verdictHistory.map((e) => VerdictEntrySchema.parse(e));
    expect(entry).toEqual({
      at: done.finishedAt!.toISOString(),
      cause: 'initial',
      candidate_version_id: w.candidateVersionId,
      key: 'primary',
      delta: 0.5,
      lo: expect.any(Number),
      hi: expect.any(Number),
      verdict: expect.stringMatching(/^(better|inconclusive)$/),
      reason: null,
      note: null,
      results_revision: done.resultsRevision,
      pass_rates: { baseline: 1 / 3, candidate: 5 / 6 },
      pass_counts: { baseline: { passed: 2, counted: 6 }, candidate: { passed: 5, counted: 6 } },
      task_counts: { improved: 3, regressed: 0, unchanged: 0 },
      resamples: 10_000,
      confidence: 0.95,
    } satisfies VerdictEntry);
    // The comparison of the completed experiment says the same.
    const view = await new ComparisonService(t.db).comparison(experiment.id, {});
    expect(view.statistics).toMatchObject({
      observedDelta: 0.5,
      verdict: entry!.verdict,
      lo: Math.round(entry!.lo! * 1000) / 1000,
      hi: Math.round(entry!.hi! * 1000) / 1000,
    });

    expect(await reconcile(experiment.id)).toBe('unchanged');
    expect((await row(experiment.id)).verdictHistory).toEqual(done.verdictHistory);
  });

  it('records why there is no verdict: one repetition, or too few runs once cancelled ones are left out', async () => {
    const single = await launch(t.db, w, { name: 'one repetition', repetitions: 1 });
    for (const key of ['a/base/1', 'a/cand/1', 'b/base/1', 'b/cand/1', 'c/base/1', 'c/cand/1']) {
      await scored(t.db, w, single.run(key), { startedAt: at(0), durationS: 5, status: 'passed' });
    }
    expect(await reconcile(single.experiment.id)).toBe('completed');
    expect((await row(single.experiment.id)).verdictHistory).toMatchObject([
      {
        cause: 'initial',
        verdict: 'not_computable',
        reason: 'single_repetition',
        delta: null,
        lo: null,
        hi: null,
      },
    ]);

    const short = await launch(t.db, w, { name: 'cancelled early' });
    await scoreAll(short.run, {
      'a/base/1': 'passed',
      'a/base/2': 'passed',
      'a/cand/1': 'passed',
      'a/cand/2': 'failed',
      'c/base/1': 'passed',
      'c/base/2': 'passed',
      'c/cand/1': 'passed',
      'c/cand/2': 'failed',
    });
    for (const key of ['b/base/1', 'b/base/2', 'b/cand/1', 'b/cand/2']) {
      await cancelled(t.db, short.run(key), at(1));
    }
    expect(await reconcile(short.experiment.id)).toBe('completed');
    expect((await row(short.experiment.id)).verdictHistory).toMatchObject([
      { verdict: 'not_computable', reason: 'not_enough_runs', delta: -0.5, lo: null, hi: null },
    ]);
  });

  it('records too_few_tasks for an experiment of fewer than 3 tasks, with its difference', async () => {
    const two = await launch(t.db, w, { name: 'two tasks', tasks: [0, 1] });
    const { 'c/base/1': _1, 'c/base/2': _2, 'c/cand/1': _3, 'c/cand/2': _4, ...ab } = MATRIX;
    await scoreAll(two.run, ab);
    expect(await reconcile(two.experiment.id)).toBe('completed');
    expect((await row(two.experiment.id)).verdictHistory).toMatchObject([
      {
        cause: 'initial',
        verdict: 'not_computable',
        reason: 'too_few_tasks',
        delta: 0.5,
        lo: null,
        hi: null,
        pass_counts: { baseline: { passed: 1, counted: 4 }, candidate: { passed: 3, counted: 4 } },
      },
    ]);
    const view = await new ComparisonService(t.db).comparison(two.experiment.id, {});
    expect(view.statisticsUnavailable).toEqual({
      reason: 'too_few_tasks',
      message:
        'No interval with 2 tasks. Pass rates: baseline 0.25, with-mcp 0.75. A verdict needs at ' +
        'least 3 tasks: the interval resamples the tasks, and with fewer it cannot say how sure ' +
        'the difference is.',
    });
  });

  it('appends one entry per candidate, in candidate order', async () => {
    const second = await t.db.transaction(async (tx) => {
      const [configuration] = await tx
        .insert(configurations)
        .values({ name: 'with-skill' })
        .returning();
      const [version] = await tx
        .insert(configurationVersions)
        .values({
          configurationId: configuration!.id,
          version: 1,
          model: PRICED_MODEL,
          provider: 'nous',
          toolsets: ['file'],
          maxTurns: 20,
          timeBudgetS: 300,
          configHash: sha('config with-skill'),
          frozenAt: new Date(),
        })
        .returning();
      return version!.id;
    });
    const { experiment } = await launch(t.db, w);
    // A second candidate: a new experiment row on three versions, its runs cancelled at once.
    const [three] = await t.db
      .insert(experiments)
      .values({
        ...experiment,
        id: undefined,
        name: 'two candidates',
        candidateVersionIds: [w.candidateVersionId, second],
        resultsRevision: 0,
        verdictRevision: null,
        verdictHistory: [],
      })
      .returning();
    await t.db.insert(runs).values(
      [w.baselineVersionId, w.candidateVersionId, second].flatMap((configurationVersionId) =>
        w.taskIds.map((taskId) => ({
          experimentId: three!.id,
          taskId,
          configurationVersionId,
          repetition: 1,
          status: 'cancelled' as const,
          finishedAt: at(1),
        })),
      ),
    );
    expect(await reconcile(three!.id)).toBe('completed');
    expect(
      (await row(three!.id)).verdictHistory.map((e) => [e.candidate_version_id, e.reason]),
    ).toEqual([
      [w.candidateVersionId, 'nothing_scored'],
      [second, 'nothing_scored'],
    ]);
  });
});

describe('a completed experiment whose results move', () => {
  it('appends cause rescore when a re-score publishes, once, and stays completed', async () => {
    const { experiment, run } = await launch(t.db, w);
    await scoreAll(run, MATRIX);
    await reconcile(experiment.id);
    const first = await row(experiment.id);

    await rescoreRun(t.db, run('b/cand/2'), 'passed');
    const moved = await row(experiment.id);
    expect(moved.resultsRevision).toBeGreaterThan(first.resultsRevision);
    expect(await reconcile(experiment.id)).toBe('unchanged');
    const after = await row(experiment.id);
    expect(after).toMatchObject({ status: 'completed', verdictRevision: moved.resultsRevision });
    expect(after.finishedAt).toEqual(first.finishedAt);
    expect(after.verdictHistory).toHaveLength(2);
    expect(after.verdictHistory[0]).toEqual(first.verdictHistory[0]);
    expect(after.verdictHistory[1]).toMatchObject({
      cause: 'rescore',
      note: '1 run re-scored',
      results_revision: moved.resultsRevision,
      pass_counts: { baseline: { passed: 2, counted: 6 }, candidate: { passed: 6, counted: 6 } },
      task_counts: { improved: 3, regressed: 0, unchanged: 0 },
    });
    expect(await reconcile(experiment.id)).toBe('unchanged');
    expect((await row(experiment.id)).verdictHistory).toHaveLength(2);
  });

  it('waits for a pending re-score, then counts every run re-scored since the last entry', async () => {
    const { experiment, run } = await launch(t.db, w);
    await scoreAll(run, MATRIX);
    await reconcile(experiment.id);
    // Two re-scores queued at once; the first publishes while the second still waits.
    const pending = [];
    for (const key of ['a/base/2', 'b/base/1']) {
      const [current] = await t.db
        .select({ attemptId: evaluations.attemptId })
        .from(evaluations)
        .where(eq(evaluations.runId, run(key)));
      const [queued] = await t.db
        .insert(evaluations)
        .values({ runId: run(key), attemptId: current!.attemptId, cause: 'rescore', generation: 2 })
        .returning({ id: evaluations.id });
      pending.push(queued!.id);
    }
    await publishRescore(t.db, pending[0]!, 'passed');
    expect((await row(experiment.id)).verdictHistory).toHaveLength(1);
    await publishRescore(t.db, pending[1]!, 'passed');
    const after = await row(experiment.id);
    expect(after.verdictHistory).toHaveLength(2);
    expect(after.verdictHistory[1]).toMatchObject({
      cause: 'rescore',
      note: '2 runs re-scored',
      pass_counts: { baseline: { passed: 4, counted: 6 } },
    });
    expect(after.verdictRevision).toBe(after.resultsRevision);
  });

  it('appends cause retry when a retry reopened it and it completed again', async () => {
    const { experiment, run } = await launch(t.db, w);
    const { 'b/base/1': _retried, ...rest } = MATRIX;
    await scoreAll(run, rest);
    await errored(t.db, w, run('b/base/1'), {
      startedAt: at(0),
      durationS: 3,
      category: 'provider',
    });
    expect(await reconcile(experiment.id)).toBe('completed');
    const first = await row(experiment.id);
    expect(first.verdictHistory[0]).toMatchObject({ cause: 'initial', note: null });

    // POST /runs/:id/retry: the run queued again and the experiment back to running.
    await t.db.transaction(async (tx) => {
      await tx
        .update(experiments)
        .set({ status: 'running', finishedAt: null })
        .where(eq(experiments.id, experiment.id));
      await tx
        .update(runs)
        .set({ status: 'queued', finishedAt: null, nextTrigger: 'user_retry' })
        .where(eq(runs.id, run('b/base/1')));
    });
    expect(await reconcile(experiment.id)).toBe('unchanged');
    // The retry runs after the first entry, on the database's clock.
    const now = Date.now();
    const attemptId = await start(t.db, w, run('b/base/1'), new Date(now), 2);
    await t.db.transaction(async (tx) => {
      await tx
        .update(attempts)
        .set({
          status: 'executed',
          finishedAt: new Date(now + 10_000),
          exitCode: 0,
          durationMs: 10_000,
          finalText: '```json\n{"total": 1}\n```',
        })
        .where(eq(attempts.id, attemptId));
      await tx
        .update(runs)
        .set({ status: 'executed' })
        .where(eq(runs.id, run('b/base/1')));
      await tx
        .update(runs)
        .set({ status: 'scoring' })
        .where(eq(runs.id, run('b/base/1')));
      const [evaluation] = await tx
        .insert(evaluations)
        .values({
          runId: run('b/base/1'),
          attemptId,
          cause: 'initial',
          generation: 1,
          ...runningClaim(),
        })
        .returning({ id: evaluations.id });
      await tx.insert(scores).values({
        evaluationId: evaluation!.id,
        key: 'answer',
        type: 'json_match',
        status: 'passed',
        isPrimary: true,
        score: 1,
        comment: 'passed',
        scorerVersion: 1,
      });
      await tx
        .update(evaluations)
        .set({ status: 'completed', finishedAt: new Date(now + 11_000) })
        .where(eq(evaluations.id, evaluation!.id));
      await tx
        .update(runs)
        .set({ status: 'scored', finishedAt: new Date(now + 11_000) })
        .where(eq(runs.id, run('b/base/1')));
      expect(await reconcileExperiment(tx, experiment.id)).toBe('completed');
    });
    const after = await row(experiment.id);
    expect(after.verdictHistory).toHaveLength(2);
    expect(after.verdictHistory[1]).toMatchObject({
      cause: 'retry',
      note: '1 retry',
      results_revision: after.resultsRevision,
      pass_counts: { baseline: { passed: 3, counted: 6 } },
    });
  });
});
