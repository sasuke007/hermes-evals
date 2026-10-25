/**
 * The experiment controls over HTTP (plan 7.3, UI_FLOWS 15) on PGlite with a
 * real pg-boss: every transition, every refusal, and what each does to the
 * runs and their jobs. The worker's side (claim, finish, a job it completed
 * while the experiment was paused) is direct SQL and pg-boss calls.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  ExperimentActionResultSchema,
  type ExperimentFailure,
} from '@hermes-evals/shared';
import { experiments, runs, workers } from '../../database/schema/index.js';
import { QUEUES } from '../../queue/queues.js';
import {
  createCommandsApp,
  launched,
  liveJobKeys,
  type CommandsApp,
  type Launched,
} from './commands-app.support-spec.js';
import {
  claimRun,
  experimentRow,
  finishRun,
  markScored,
  runsOf,
} from './commands-seed.support-spec.js';

let c: CommandsApp;
let x: Launched;

beforeEach(async () => {
  c = await createCommandsApp();
  // 2 tasks × 2 configurations × 1 repetition = 4 queued runs, each with its runId:1 job.
  x = await launched(c);
});

afterEach(() => c.close());

const action = (res: { body: unknown }) => ExperimentActionResultSchema.parse(res.body);
const refusal = (res: { body: unknown }) => ApiErrorBodySchema.parse(res.body).message;

/** Sets lifecycle columns directly, as the guards and the breaker in the worker do. */
const setExperiment = (patch: Partial<typeof experiments.$inferInsert>) =>
  c.t.db.update(experiments).set(patch).where(eq(experiments.id, x.id));

/** The worker took these jobs while the experiment was paused and completed them. */
async function workerCompletesJobs(): Promise<void> {
  const taken = await c.boss.fetch(QUEUES.executeRun, { batchSize: 100 });
  for (const job of taken) await c.boss.complete(QUEUES.executeRun, job.id);
}

const FAILURE: ExperimentFailure = {
  at: '2026-10-24T10:00:00.000Z',
  threshold: 14,
  category: 'setup',
  exit_code: 1,
  message: 'invoice-db failed to start',
  stderr_first_line: 'Error: INVOICE_DB_URL is not set',
  attempt_id: 'att_x',
  run_id: 'run_x',
};

describe('pause', () => {
  it('pauses a running experiment for the user, and is a no-op on a paused one', async () => {
    expect(action(await c.post(`/experiments/${x.id}/pause`).expect(200))).toEqual({
      id: x.id,
      status: 'paused',
    });
    const e = await experimentRow(c.t.db, x.id);
    expect(e).toMatchObject({ status: 'paused', pauseReason: 'user' });
    expect(e.pausedAt).toBeInstanceOf(Date);

    await setExperiment({ pauseReason: 'spend_ceiling' });
    expect(action(await c.post(`/experiments/${x.id}/pause`).expect(200)).status).toBe('paused');
    expect((await experimentRow(c.t.db, x.id)).pauseReason).toBe('spend_ceiling');
  });

  it('refuses a completed or cancelled experiment, and 404s an unknown one', async () => {
    await c.post(`/experiments/${x.id}/cancel`).expect(200);
    expect(refusal(await c.post(`/experiments/${x.id}/pause`).expect(409))).toBe(
      'the experiment is completed; only a running experiment can be paused',
    );
    expect(refusal(await c.post('/experiments/exp_gone/pause').expect(404))).toBe(
      'experiment exp_gone not found',
    );
  });

  it('refuses an experiment that is draining after a cancel', async () => {
    const [first] = await runsOf(c.t.db, x.id);
    await claimRun(c.t.db, first!.id, x.workerId);
    expect(action(await c.post(`/experiments/${x.id}/cancel`).expect(200)).status).toBe('running');
    expect(refusal(await c.post(`/experiments/${x.id}/pause`).expect(409))).toBe(
      'the experiment was cancelled and is finishing its in-flight runs',
    );
  });
});

describe('resume', () => {
  it('resumes and re-sends only the jobs a worker completed while it was paused', async () => {
    const keys = await liveJobKeys(c);
    expect(keys).toHaveLength(4);
    await c.post(`/experiments/${x.id}/pause`).expect(200);
    // Nothing lost yet: resuming sends no duplicate.
    expect(action(await c.post(`/experiments/${x.id}/resume`).expect(200)).status).toBe('running');
    expect(await liveJobKeys(c)).toEqual(keys);
    expect(await c.jobs()).toHaveLength(4);

    await c.post(`/experiments/${x.id}/pause`).expect(200);
    await workerCompletesJobs();
    expect(await liveJobKeys(c)).toEqual([]);
    await c.post(`/experiments/${x.id}/resume`).expect(200);
    expect(await liveJobKeys(c)).toEqual(keys);
    expect(await experimentRow(c.t.db, x.id)).toMatchObject({
      status: 'running',
      pauseReason: null,
      pausedAt: null,
    });
    // Resuming a running experiment changes nothing.
    expect(action(await c.post(`/experiments/${x.id}/resume`).expect(200)).status).toBe('running');
    expect(await c.jobs()).toHaveLength(8);
  });

  it('re-sends a queued retry as its next attempt with the trigger that queued it', async () => {
    const [first] = await runsOf(c.t.db, x.id);
    const attempt = await claimRun(c.t.db, first!.id, x.workerId);
    await finishRun(c.t.db, first!.id, attempt, { status: 'execution_error', category: 'timeout' });
    // The automatic retry: the run is queued again for attempt 2, as finish.ts records it.
    await c.t.db
      .update(runs)
      .set({ status: 'queued', finishedAt: null, nextTrigger: 'auto_retry' })
      .where(eq(runs.id, first!.id));
    await c.post(`/experiments/${x.id}/pause`).expect(200);
    await workerCompletesJobs();
    await c.post(`/experiments/${x.id}/resume`).expect(200);
    const job = (await c.jobs()).find((j) => j.singletonKey === `${first!.id}:2`);
    expect(job?.data).toEqual({ runId: first!.id, attempt: 2, trigger: 'auto_retry' });
  });

  it('re-sends a run retried after a worker_lost attempt as user_retry, not recovery', async () => {
    const [first] = await runsOf(c.t.db, x.id);
    const attempt = await claimRun(c.t.db, first!.id, x.workerId);
    await finishRun(c.t.db, first!.id, attempt, {
      status: 'execution_error',
      category: 'worker_lost',
    });
    await c.post(`/runs/${first!.id}/retry`).expect(200);
    expect((await runsOf(c.t.db, x.id)).find((r) => r.id === first!.id)!.nextTrigger).toBe(
      'user_retry',
    );
    // The retry's job is lost: a worker took it while the experiment was paused.
    await c.post(`/experiments/${x.id}/pause`).expect(200);
    await workerCompletesJobs();
    await c.post(`/experiments/${x.id}/resume`).expect(200);
    const job = (await c.jobs()).find(
      (j) => j.singletonKey === `${first!.id}:2` && j.state === 'created',
    );
    expect(job?.data).toEqual({ runId: first!.id, attempt: 2, trigger: 'user_retry' });
  });

  it('refuses while no connected worker runs the Hermes revision the experiment froze', async () => {
    await c.post(`/experiments/${x.id}/pause`).expect(200);
    await c.t.db.update(workers).set({ hermesRevision: 'f'.repeat(40) });
    expect(refusal(await c.post(`/experiments/${x.id}/resume`).expect(409))).toMatch(
      /^This experiment was launched on Hermes [0-9a-f]{7}; no connected worker runs that revision \(the connected workers run fffffff\)/,
    );
    expect((await experimentRow(c.t.db, x.id)).status).toBe('paused');
  });

  it('needs a ceiling above the old one and the spend so far after a spend-ceiling pause', async () => {
    const [first] = await runsOf(c.t.db, x.id);
    const attempt = await claimRun(c.t.db, first!.id, x.workerId);
    await finishRun(c.t.db, first!.id, attempt, { status: 'executed', costUsd: 1.2 });
    await setExperiment({
      spendCeilingUsd: 1,
      status: 'paused',
      pauseReason: 'spend_ceiling',
      pausedAt: new Date(),
    });
    expect(refusal(await c.post(`/experiments/${x.id}/resume`).expect(409))).toBe(
      'raise the spend ceiling above $1.20 to resume',
    );
    expect(
      refusal(await c.post(`/experiments/${x.id}/resume`, { spendCeilingUsd: 1.1 }).expect(409)),
    ).toBe('raise the spend ceiling above $1.20 to resume');
    await c.post(`/experiments/${x.id}/resume`, { spendCeilingUsd: 3 }).expect(200);
    expect(await experimentRow(c.t.db, x.id)).toMatchObject({
      status: 'running',
      spendCeilingUsd: 3,
    });
  });

  it('refuses an unknown body field and a ceiling at or below the spend after a user pause', async () => {
    const [first] = await runsOf(c.t.db, x.id);
    const attempt = await claimRun(c.t.db, first!.id, x.workerId);
    await finishRun(c.t.db, first!.id, attempt, { status: 'executed', costUsd: 0.5 });
    await c.post(`/experiments/${x.id}/pause`).expect(200);
    await c.post(`/experiments/${x.id}/resume`, { spendCeiling: 2 }).expect(400);
    // The spend guard would pause it again before the next run.
    expect(
      refusal(await c.post(`/experiments/${x.id}/resume`, { spendCeilingUsd: 0.5 }).expect(409)),
    ).toBe('raise the spend ceiling above $0.50 to resume');
    await c.post(`/experiments/${x.id}/resume`, { spendCeilingUsd: 0.75 }).expect(200);
    expect((await experimentRow(c.t.db, x.id)).spendCeilingUsd).toBe(0.75);
  });

  it('needs the providers ready after a provider_disconnected pause, and refuses other states', async () => {
    await c.close();
    c = await createCommandsApp();
    x = await launched(c, { baseline: { provider: 'nous', model: 'openai/gpt-6.1-sol' } });
    await setExperiment({
      status: 'paused',
      pauseReason: 'provider_disconnected',
      pausedAt: new Date(),
    });
    c.nous.status = 'relogin_required';
    expect(refusal(await c.post(`/experiments/${x.id}/resume`).expect(409))).toBe(
      'Your Nous Portal login needs renewing. Reconnect Nous Portal.',
    );
    c.nous.status = 'connected';
    expect(action(await c.post(`/experiments/${x.id}/resume`).expect(200)).status).toBe('running');

    await setExperiment({ status: 'failed', finishedAt: new Date(), failure: FAILURE });
    expect(refusal(await c.post(`/experiments/${x.id}/resume`).expect(409))).toBe(
      'the experiment is failed, not paused',
    );
  });

  it('completes an experiment that has nothing left to run', async () => {
    for (const run of await runsOf(c.t.db, x.id)) {
      const attempt = await claimRun(c.t.db, run.id, x.workerId);
      await finishRun(c.t.db, run.id, attempt, { status: 'executed' });
      await markScored(c.t.db, run.id);
    }
    await c.t.db
      .update(experiments)
      .set({ status: 'paused', pauseReason: 'user', pausedAt: sql`now()` })
      .where(eq(experiments.id, x.id));
    expect(action(await c.post(`/experiments/${x.id}/resume`).expect(200)).status).toBe(
      'completed',
    );
  });
});

describe('cancel', () => {
  it('cancels queued runs with their jobs and asks the worker to stop running ones', async () => {
    const [first, second] = await runsOf(c.t.db, x.id);
    await claimRun(c.t.db, first!.id, x.workerId);
    const attempt = await claimRun(c.t.db, second!.id, x.workerId);
    await finishRun(c.t.db, second!.id, attempt, { status: 'executed' });

    expect(action(await c.post(`/experiments/${x.id}/cancel`).expect(200))).toEqual({
      id: x.id,
      status: 'running',
    });
    const after = await runsOf(c.t.db, x.id);
    expect(after.map((r) => r.status)).toEqual(['running', 'executed', 'cancelled', 'cancelled']);
    expect(after[0]!.cancelRequestedAt).toBeInstanceOf(Date);
    expect(after[1]!.cancelRequestedAt).toBeNull();
    const e = await experimentRow(c.t.db, x.id);
    expect(e.cancelledAt).toBeInstanceOf(Date);
    // The cancelled runs' jobs are cancelled; the claimed ones were taken by the "worker".
    const states = new Map((await c.jobs()).map((j) => [j.singletonKey, j.state]));
    expect(states.get(`${after[2]!.id}:1`)).toBe('cancelled');
    expect(states.get(`${after[3]!.id}:1`)).toBe('cancelled');

    // Cancelling again keeps the first cancel time.
    await c.post(`/experiments/${x.id}/cancel`).expect(200);
    expect((await experimentRow(c.t.db, x.id)).cancelledAt).toEqual(e.cancelledAt);
  });

  it('completes at once when nothing is in flight, then is idempotent', async () => {
    expect(action(await c.post(`/experiments/${x.id}/cancel`).expect(200)).status).toBe(
      'completed',
    );
    expect((await runsOf(c.t.db, x.id)).every((r) => r.status === 'cancelled')).toBe(true);
    expect(await liveJobKeys(c)).toEqual([]);
    expect(action(await c.post(`/experiments/${x.id}/cancel`).expect(200)).status).toBe(
      'completed',
    );
  });

  it('cancels a paused experiment and a failed one, clearing the pause and the failure', async () => {
    await c.post(`/experiments/${x.id}/pause`).expect(200);
    expect(action(await c.post(`/experiments/${x.id}/cancel`).expect(200)).status).toBe(
      'completed',
    );
    expect(await experimentRow(c.t.db, x.id)).toMatchObject({ pauseReason: null, pausedAt: null });

    await c.close();
    c = await createCommandsApp();
    x = await launched(c);
    await setExperiment({ status: 'failed', finishedAt: new Date(), failure: FAILURE });
    expect(action(await c.post(`/experiments/${x.id}/cancel`).expect(200)).status).toBe(
      'completed',
    );
    expect(await experimentRow(c.t.db, x.id)).toMatchObject({ status: 'completed', failure: null });
  });

  it('refuses a completed experiment that was not cancelled', async () => {
    for (const run of await runsOf(c.t.db, x.id)) {
      const attempt = await claimRun(c.t.db, run.id, x.workerId);
      await finishRun(c.t.db, run.id, attempt, { status: 'executed' });
      await markScored(c.t.db, run.id);
    }
    await setExperiment({ status: 'completed', finishedAt: new Date() });
    expect(refusal(await c.post(`/experiments/${x.id}/cancel`).expect(409))).toBe(
      'the experiment is already completed',
    );
  });
});

describe('retry-failed', () => {
  it('reopens a failed experiment: clears the failure, re-queues errored runs and re-sends queued ones', async () => {
    const [errored, exhausted, waiting] = await runsOf(c.t.db, x.id);
    const a1 = await claimRun(c.t.db, errored!.id, x.workerId);
    await finishRun(c.t.db, errored!.id, a1, { status: 'execution_error', category: 'setup' });
    for (let n = 1; n <= 5; n += 1) {
      const a = await claimRun(c.t.db, exhausted!.id, x.workerId);
      await finishRun(c.t.db, exhausted!.id, a, { status: 'execution_error', category: 'setup' });
      if (n < 5) {
        await c.t.db
          .update(runs)
          .set({ status: 'queued', finishedAt: null })
          .where(eq(runs.id, exhausted!.id));
      }
    }
    await setExperiment({
      status: 'failed',
      finishedAt: new Date(),
      failure: FAILURE,
      consecutiveExecutionErrors: 14,
    });
    await workerCompletesJobs();

    expect(action(await c.post(`/experiments/${x.id}/retry-failed`).expect(200)).status).toBe(
      'running',
    );
    expect(await experimentRow(c.t.db, x.id)).toMatchObject({
      status: 'running',
      failure: null,
      finishedAt: null,
      consecutiveExecutionErrors: 0,
    });
    const byId = new Map((await runsOf(c.t.db, x.id)).map((r) => [r.id, r]));
    expect(byId.get(errored!.id)).toMatchObject({ status: 'queued', finishedAt: null });
    expect(byId.get(exhausted!.id)!.status).toBe('execution_error');
    const live = new Map(
      (await c.jobs()).filter((j) => j.state === 'created').map((j) => [j.singletonKey, j.data]),
    );
    expect(live.get(`${errored!.id}:2`)).toEqual({
      runId: errored!.id,
      attempt: 2,
      trigger: 'retry_failed',
    });
    expect(live.get(`${waiting!.id}:1`)).toEqual({
      runId: waiting!.id,
      attempt: 1,
      trigger: 'initial',
    });
    expect(live.has(`${exhausted!.id}:6`)).toBe(false);
    // A second click finds it running and changes nothing.
    expect(action(await c.post(`/experiments/${x.id}/retry-failed`).expect(200)).status).toBe(
      'running',
    );
  });

  it('re-sends a run it queued as retry_failed after a pause and resume', async () => {
    const [errored] = await runsOf(c.t.db, x.id);
    const a1 = await claimRun(c.t.db, errored!.id, x.workerId);
    await finishRun(c.t.db, errored!.id, a1, { status: 'execution_error', category: 'setup' });
    await setExperiment({ status: 'failed', finishedAt: new Date(), failure: FAILURE });
    await c.post(`/experiments/${x.id}/retry-failed`).expect(200);
    // Before a worker claims it, the experiment is paused and the job is lost.
    await c.post(`/experiments/${x.id}/pause`).expect(200);
    await workerCompletesJobs();
    await c.post(`/experiments/${x.id}/resume`).expect(200);
    const job = (await c.jobs()).find(
      (j) => j.singletonKey === `${errored!.id}:2` && j.state === 'created',
    );
    expect(job?.data).toEqual({ runId: errored!.id, attempt: 2, trigger: 'retry_failed' });
  });

  it('completes it at once when nothing is left to run', async () => {
    for (const run of await runsOf(c.t.db, x.id)) {
      const attempt = await claimRun(c.t.db, run.id, x.workerId);
      await finishRun(c.t.db, run.id, attempt, { status: 'executed' });
      await markScored(c.t.db, run.id);
    }
    await setExperiment({ status: 'failed', finishedAt: new Date(), failure: FAILURE });
    expect(action(await c.post(`/experiments/${x.id}/retry-failed`).expect(200)).status).toBe(
      'completed',
    );
  });

  it('refuses an experiment that is not failed, or whose provider is not ready', async () => {
    await c.post(`/experiments/${x.id}/pause`).expect(200);
    expect(refusal(await c.post(`/experiments/${x.id}/retry-failed`).expect(409))).toBe(
      'the experiment is paused, not failed',
    );
    await c.close();
    c = await createCommandsApp();
    x = await launched(c, { baseline: { provider: 'nous', model: 'openai/gpt-6.1-sol' } });
    await setExperiment({ status: 'failed', finishedAt: new Date(), failure: FAILURE });
    c.nous.status = 'not_connected';
    expect(refusal(await c.post(`/experiments/${x.id}/retry-failed`).expect(409))).toBe(
      'Nous Portal is not connected.',
    );
  });
});
