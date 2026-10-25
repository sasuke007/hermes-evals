/**
 * The experiment controls and run retry under real concurrency, on Postgres
 * 17 through node-postgres with the real pg-boss on the same database. Each
 * race holds the experiment row, lines the contenders up behind it in a
 * chosen order and lets go: the row lock serialises them (plan 3.3), so the
 * outcome is the one that order gives, nothing deadlocks, and no job is left
 * for a run that cannot run. The worker's side (taking a job, claim, finish,
 * scores published) is direct SQL and pg-boss calls.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  ExperimentActionResultSchema,
  LaunchExperimentResultSchema,
  RunActionResultSchema,
} from '@hermes-evals/shared';
import { experiments, runs } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { QUEUES, type ExecuteRunJob } from '../../queue/queues.js';
import { reconcileExperiment } from '../reconcile.js';
import type { CommandsApp } from './commands-app.support-spec.js';
import {
  createE2eDatabase,
  EXPERIMENT_ROW_LOCK,
  holdExperiment,
  SERVER_URL,
  started,
  waitForLockWaits,
  waitingJobKeys,
  type E2eDatabase,
} from './commands-e2e.support-spec.js';
import {
  claimRun,
  experimentRow,
  finishCancelled,
  finishRun,
  runsOf,
  seedConfiguration,
  seedSuite,
  seedWorker,
  type SeededConfiguration,
  type SeededSuite,
} from './commands-seed.support-spec.js';

/** The scores of an executed run are published; reconcile runs in the same transaction (plan 7.4). */
async function publishScores(db: AppDb, experimentId: string, runId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .select({ id: experiments.id })
      .from(experiments)
      .where(eq(experiments.id, experimentId))
      .for('no key update');
    await tx
      .update(runs)
      .set({ status: 'scored', finishedAt: sql`now()` })
      .where(eq(runs.id, runId));
    await reconcileExperiment(tx, experimentId);
  });
}

/** Every permutation of `items`. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

type Contender = 'pause' | 'resume' | 'cancel' | 'finish';

/**
 * What each control answers when they take the experiment row of a running
 * experiment with runs in flight in `order`. Resume's provider check ran
 * while it was running, so a resume that then finds it paused refuses (the
 * status moved meanwhile).
 */
function expectedAnswers(order: readonly Contender[]): Record<'pause' | 'resume', number> {
  let status: 'running' | 'paused' = 'running';
  let cancelled = false;
  const answers = { pause: 0, resume: 0 };
  for (const op of order) {
    if (op === 'pause') {
      answers.pause = cancelled ? 409 : 200;
      if (!cancelled) status = 'paused';
    } else if (op === 'resume') {
      answers.resume = status === 'paused' ? 409 : 200;
    } else if (op === 'cancel') {
      status = 'running';
      cancelled = true;
    }
  }
  return answers;
}

describe.skipIf(!SERVER_URL)('controls on Postgres 17', () => {
  let e2e: E2eDatabase;
  let c: CommandsApp;
  let suite: SeededSuite;
  let base: SeededConfiguration;
  let cand: SeededConfiguration;
  let workerId: string;

  beforeEach(async () => {
    e2e = await createE2eDatabase('controls_e2e');
    c = e2e.c;
    workerId = await seedWorker(c.t.db);
    suite = await seedSuite(c.t.db, {
      tasks: [{ key: 'alpha' }, { key: 'bravo' }, { key: 'charlie' }],
    });
    base = await seedConfiguration(c.t.db, 'baseline');
    cand = await seedConfiguration(c.t.db, 'with-skill');
  });

  afterEach(() => e2e.close());

  /** Launches `tasks` × 2 configurations × `repetitions` through the API. */
  async function launch(tasks: number, repetitions: number): Promise<string> {
    const res = await c
      .post('/experiments', {
        name: 'Skill vs no skill',
        description: '',
        suiteId: suite.id,
        taskKeys: [...suite.taskIds.keys()].slice(0, tasks),
        baselineVersionId: base.versionId,
        candidateVersionIds: [cand.versionId],
        repetitions,
        concurrency: 2,
        spendCeilingUsd: null,
        timeBudgetOverrideS: null,
        expectedConfigHashes: {
          [base.versionId]: base.configHash,
          [cand.versionId]: cand.configHash,
        },
      })
      .expect(201);
    return LaunchExperimentResultSchema.parse(res.body).id;
  }

  /** A worker takes `n` waiting execute-run jobs and claims their runs. */
  async function takeAndClaim(n: number): Promise<{ runId: string; attemptId: string }[]> {
    const jobs = await c.boss.fetch<ExecuteRunJob>(QUEUES.executeRun, { batchSize: n });
    expect(jobs).toHaveLength(n);
    const claimed = [];
    for (const job of jobs) {
      claimed.push({
        runId: job.data.runId,
        attemptId: await claimRun(c.t.db, job.data.runId, workerId),
      });
    }
    return claimed;
  }

  const runIdsOf = async (experimentId: string) =>
    (await runsOf(c.t.db, experimentId)).map((r) => r.id);

  it('serialises pause, resume, cancel and a worker finishing on the experiment row, in every order', async () => {
    for (const order of permutations<Contender>(['pause', 'resume', 'cancel', 'finish'])) {
      // 2 tasks × 2 configurations: two runs in flight, two queued.
      const id = await launch(2, 1);
      const [finishing, running] = await takeAndClaim(2);
      const lock = await holdExperiment(e2e.pool, id);
      const answers: Partial<Record<Contender, Promise<{ status: number; body: unknown }>>> = {};
      try {
        for (const [i, op] of order.entries()) {
          answers[op] =
            op === 'finish'
              ? finishRun(c.t.db, finishing!.runId, finishing!.attemptId, {
                  status: 'executed',
                }).then(() => ({
                  status: 200,
                  body: null,
                }))
              : started(c.post(`/experiments/${id}/${op}`));
          // Next in line only once this one waits on the row: the queue order is `order`.
          await waitForLockWaits(e2e.pool, i + 1, EXPERIMENT_ROW_LOCK);
        }
      } finally {
        await lock.commit();
      }
      const got = {
        pause: await answers.pause!,
        resume: await answers.resume!,
        cancel: await answers.cancel!,
        finish: await answers.finish!,
      };
      // The first in line always takes the row first. After it, Postgres does
      // not keep the queue order for a row its predecessor updated: the next
      // waiters race for the new row version. So the answers must be those
      // of one serial order that starts with the first contender.
      const label = order.join(' → ');
      const serial = permutations(order.slice(1)).map((rest) => [order[0]!, ...rest]);
      const observed = { pause: got.pause.status, resume: got.resume.status };
      expect(
        serial.some((s) => {
          const expected = expectedAnswers(s);
          return expected.pause === observed.pause && expected.resume === observed.resume;
        }),
        `${label}: ${JSON.stringify(observed)} fits no serial order`,
      ).toBe(true);
      expect(ExperimentActionResultSchema.parse(got.cancel.body)).toEqual({
        id,
        status: 'running',
      });
      if (got.pause.status === 409) {
        expect(ApiErrorBodySchema.parse(got.pause.body).message).toBe(
          'the experiment was cancelled and is finishing its in-flight runs',
        );
      }
      for (const answer of [got.pause, got.resume]) {
        if (answer.status === 200) ExperimentActionResultSchema.parse(answer.body);
      }

      // Cancel wins whatever the order: running while its two runs drain, nothing left to start.
      const e = await experimentRow(c.t.db, id);
      expect(e).toMatchObject({ status: 'running', pauseReason: null, pausedAt: null });
      expect(e.cancelledAt).toBeInstanceOf(Date);
      const byId = new Map((await runsOf(c.t.db, id)).map((r) => [r.id, r]));
      expect(byId.get(finishing!.runId)!.status).toBe('executed');
      expect(byId.get(running!.runId)).toMatchObject({ status: 'running' });
      expect(byId.get(running!.runId)!.cancelRequestedAt).toBeInstanceOf(Date);
      const others = [...byId.values()].filter(
        (r) => r.id !== finishing!.runId && r.id !== running!.runId,
      );
      expect(others.map((r) => r.status)).toEqual(['cancelled', 'cancelled']);
      expect(await waitingJobKeys(c, [...byId.keys()])).toEqual([]);

      // The worker stops the cancelled one and the scores of the other land: completed.
      await finishCancelled(c.t.db, running!.runId, running!.attemptId);
      await publishScores(c.t.db, id, finishing!.runId);
      const done = await experimentRow(c.t.db, id);
      expect(done.status).toBe('completed');
      expect(done.finishedAt).toBeInstanceOf(Date);
      expect(done.verdictRevision).toBe(done.resultsRevision);
    }
  });

  it('re-sends each queued run once however many resumes and pauses arrive together', async () => {
    // 3 tasks × 2 configurations × 2 repetitions.
    const id = await launch(3, 2);
    const keys = (await runIdsOf(id)).map((runId) => `${runId}:1`).sort();
    await c.post(`/experiments/${id}/pause`).expect(200);
    // The worker took five jobs while it was paused and completed them without starting anything.
    for (const job of await c.boss.fetch(QUEUES.executeRun, { batchSize: 5 })) {
      await c.boss.complete(QUEUES.executeRun, job.id);
    }
    expect(await waitingJobKeys(c)).toHaveLength(7);

    const lock = await holdExperiment(e2e.pool, id);
    const order = [
      'resume',
      'resume',
      'pause',
      'resume',
      'resume',
      'pause',
      'resume',
      'resume',
    ] as const;
    const answers: Promise<{ status: number; body: unknown }>[] = [];
    try {
      for (const [i, op] of order.entries()) {
        answers.push(started(c.post(`/experiments/${id}/${op}`)));
        await waitForLockWaits(e2e.pool, i + 1, EXPERIMENT_ROW_LOCK);
      }
    } finally {
      await lock.commit();
    }
    const results = await Promise.all(answers);
    // Every check ran while it was paused, so each control applies in turn and the last resume wins.
    expect(results.map((r) => r.status)).toEqual(order.map(() => 200));
    expect(results.map((r) => ExperimentActionResultSchema.parse(r.body).status)).toEqual(
      order.map((op) => (op === 'pause' ? 'paused' : 'running')),
    );
    expect((await experimentRow(c.t.db, id)).status).toBe('running');
    // Exactly one waiting job per queued run: the five dropped ones re-sent once, the seven kept.
    expect(await waitingJobKeys(c)).toEqual(keys);
    const jobs = await c.jobs();
    expect(jobs).toHaveLength(12 + 5);
    expect(jobs.filter((j) => j.state === 'completed')).toHaveLength(5);
  });

  it('completes a cancelled experiment once, whether cancel or the last finish takes the row first', async () => {
    for (const cancelFirst of [true, false]) {
      // 1 task × 2 configurations: both in flight, one already scored.
      const id = await launch(1, 1);
      const [scored, last] = await takeAndClaim(2);
      await finishRun(c.t.db, scored!.runId, scored!.attemptId, { status: 'executed' });
      await publishScores(c.t.db, id, scored!.runId);

      const lock = await holdExperiment(e2e.pool, id);
      let cancel: Promise<{ status: number; body: unknown }>;
      let finish: Promise<void>;
      try {
        if (cancelFirst) {
          cancel = started(c.post(`/experiments/${id}/cancel`));
          await waitForLockWaits(e2e.pool, 1, EXPERIMENT_ROW_LOCK);
          finish = finishRun(c.t.db, last!.runId, last!.attemptId, { status: 'executed' });
        } else {
          finish = finishRun(c.t.db, last!.runId, last!.attemptId, { status: 'executed' });
          await waitForLockWaits(e2e.pool, 1, EXPERIMENT_ROW_LOCK);
          cancel = started(c.post(`/experiments/${id}/cancel`));
        }
        await waitForLockWaits(e2e.pool, 2, EXPERIMENT_ROW_LOCK);
      } finally {
        await lock.commit();
      }
      await finish;
      // The last run is executed either way, so the cancel leaves it scoring and the experiment running.
      expect(ExperimentActionResultSchema.parse((await cancel).body)).toEqual({
        id,
        status: 'running',
      });
      await publishScores(c.t.db, id, last!.runId);
      const done = await experimentRow(c.t.db, id);
      expect(done).toMatchObject({ status: 'completed', pauseReason: null });
      expect(done.cancelledAt).toBeInstanceOf(Date);
      expect(done.verdictRevision).toBe(done.resultsRevision);
      // Completed once: cancelling again changes nothing.
      expect(
        ExperimentActionResultSchema.parse(
          (await c.post(`/experiments/${id}/cancel`).expect(200)).body,
        ).status,
      ).toBe('completed');
      expect((await experimentRow(c.t.db, id)).finishedAt).toEqual(done.finishedAt);
    }
  });

  it('never leaves a job behind when a run retry races a cancel', async () => {
    for (const retryFirst of [true, false]) {
      const id = await launch(1, 1);
      const [errored] = await takeAndClaim(1);
      await finishRun(c.t.db, errored!.runId, errored!.attemptId, {
        status: 'execution_error',
        category: 'other',
      });

      const lock = await holdExperiment(e2e.pool, id);
      const contenders = retryFirst
        ? [`/runs/${errored!.runId}/retry`, `/experiments/${id}/cancel`]
        : [`/experiments/${id}/cancel`, `/runs/${errored!.runId}/retry`];
      const answers: Promise<{ status: number; body: unknown }>[] = [];
      try {
        for (const [i, path] of contenders.entries()) {
          answers.push(started(c.post(path)));
          await waitForLockWaits(e2e.pool, i + 1, EXPERIMENT_ROW_LOCK);
        }
      } finally {
        await lock.commit();
      }
      const [first, second] = await Promise.all(answers);
      const [retry, cancel] = retryFirst ? [first!, second!] : [second!, first!];
      expect(ExperimentActionResultSchema.parse(cancel.body).id).toBe(id);
      const run = (await runsOf(c.t.db, id)).find((r) => r.id === errored!.runId)!;
      if (retryFirst) {
        // Queued for attempt 2, then cancelled with its job by the cancel behind it.
        expect(RunActionResultSchema.parse(retry.body)).toEqual({
          runId: errored!.runId,
          status: 'queued',
          attempt: 2,
        });
        expect(run.status).toBe('cancelled');
        const job = (await c.jobs()).find((j) => j.singletonKey === `${errored!.runId}:2`);
        expect(job?.state).toBe('cancelled');
      } else {
        expect(retry.status).toBe(409);
        expect(ApiErrorBodySchema.parse(retry.body).message).toBe('the experiment was cancelled');
        expect(run.status).toBe('execution_error');
      }
      expect(await waitingJobKeys(c, await runIdsOf(id))).toEqual([]);
      expect((await experimentRow(c.t.db, id)).status).toBe('completed');
    }
  });
});
