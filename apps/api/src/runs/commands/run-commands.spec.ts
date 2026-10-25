/**
 * The run actions over HTTP (plan 7.3, UI_FLOWS 17 and 18) on PGlite with a
 * real pg-boss: Retry, Cancel and bulk Retry execution, with every refusal
 * the web names, and their effect on the experiment.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  BulkRunActionResultSchema,
  RunActionResultSchema,
  type ExperimentFailure,
} from '@hermes-evals/shared';
import { experiments, runs } from '../../database/schema/index.js';
import {
  createCommandsApp,
  launched,
  liveJobKeys,
  type CommandsApp,
  type Launched,
} from '../../experiments/commands/commands-app.support-spec.js';
import {
  claimRun,
  experimentRow,
  finishRun,
  markScored,
  runsOf,
} from '../../experiments/commands/commands-seed.support-spec.js';

let c: CommandsApp;
let x: Launched;

beforeEach(async () => {
  c = await createCommandsApp();
  x = await launched(c);
});

afterEach(() => c.close());

const refusal = (res: { body: unknown }) => ApiErrorBodySchema.parse(res.body).message;
const result = (res: { body: unknown }) => RunActionResultSchema.parse(res.body);

/** Runs every run to an end: the first `errors` ones fail with `category`, the rest are scored. */
async function settle(errors: number, category: 'setup' | 'timeout' = 'setup'): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, run] of (await runsOf(c.t.db, x.id)).entries()) {
    const attempt = await claimRun(c.t.db, run.id, x.workerId);
    if (i < errors) {
      await finishRun(c.t.db, run.id, attempt, { status: 'execution_error', category });
    } else {
      await finishRun(c.t.db, run.id, attempt, { status: 'executed' });
      await markScored(c.t.db, run.id);
    }
    ids.push(run.id);
  }
  return ids;
}

const FAILURE: ExperimentFailure = {
  at: '2026-10-24T10:00:00.000Z',
  threshold: 14,
  category: 'setup',
  exit_code: 1,
  message: 'invoice-db failed to start',
  stderr_first_line: null,
  attempt_id: 'att_x',
  run_id: 'run_x',
};

describe('POST /api/runs/:id/retry', () => {
  it('queues an execution_error run for its next attempt and reopens a completed experiment', async () => {
    const [errored] = await settle(1);
    await c.t.db
      .update(experiments)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(experiments.id, x.id));

    expect(result(await c.post(`/runs/${errored}/retry`).expect(200))).toEqual({
      runId: errored,
      status: 'queued',
      attempt: 2,
    });
    const [run] = await c.t.db.select().from(runs).where(eq(runs.id, errored!));
    expect(run).toMatchObject({ status: 'queued', finishedAt: null, attemptCount: 1 });
    expect(await experimentRow(c.t.db, x.id)).toMatchObject({
      status: 'running',
      finishedAt: null,
    });
    const job = (await c.jobs()).find((j) => j.singletonKey === `${errored}:2`);
    expect(job?.data).toEqual({ runId: errored, attempt: 2, trigger: 'user_retry' });
  });

  it('refuses a run that is not execution_error, has 5 attempts, or whose experiment cannot reopen', async () => {
    const [errored, scored] = await settle(1);
    expect(refusal(await c.post(`/runs/${scored}/retry`).expect(409))).toBe(
      'run is scored, not execution_error',
    );
    await c.t.db.update(runs).set({ attemptCount: 5 }).where(eq(runs.id, errored!));
    // attempt_count must match the attempts; the refusal comes before anything is written.
    expect(refusal(await c.post(`/runs/${errored}/retry`).expect(409))).toBe(
      'run already has 5 attempts',
    );
    await c.t.db.update(runs).set({ attemptCount: 1 }).where(eq(runs.id, errored!));
    await c.t.db
      .update(experiments)
      .set({ status: 'failed', finishedAt: new Date(), failure: FAILURE })
      .where(eq(experiments.id, x.id));
    expect(refusal(await c.post(`/runs/${errored}/retry`).expect(409))).toBe(
      'the experiment failed; use Retry failed runs to reopen it',
    );
    expect(refusal(await c.post('/runs/run_gone/retry').expect(404))).toBe(
      'run run_gone not found',
    );
  });

  it("refuses with the provider's reason when the run's provider is not ready", async () => {
    await c.close();
    c = await createCommandsApp();
    x = await launched(c, { baseline: { provider: 'nous', model: 'openai/gpt-6.1-sol' } });
    const all = await runsOf(c.t.db, x.id);
    const nousRun = all.find((r) => r.configurationVersionId === x.baseline.versionId)!;
    const attempt = await claimRun(c.t.db, nousRun.id, x.workerId);
    await finishRun(c.t.db, nousRun.id, attempt, {
      status: 'execution_error',
      category: 'provider',
    });
    c.nous.status = 'not_connected';
    expect(refusal(await c.post(`/runs/${nousRun.id}/retry`).expect(409))).toBe(
      'Retry needs Nous Portal: Nous Portal is not connected.',
    );
  });
});

describe('POST /api/runs/:id/cancel', () => {
  it('cancels a queued run with its job, and completes the experiment when it was the last', async () => {
    const all = await runsOf(c.t.db, x.id);
    for (const run of all.slice(0, 3)) {
      const attempt = await claimRun(c.t.db, run.id, x.workerId);
      await finishRun(c.t.db, run.id, attempt, { status: 'executed' });
      await markScored(c.t.db, run.id);
    }
    const last = all[3]!;
    expect(result(await c.post(`/runs/${last.id}/cancel`).expect(200))).toEqual({
      runId: last.id,
      status: 'cancelled',
      attempt: null,
    });
    expect((await liveJobKeys(c)).includes(`${last.id}:1`)).toBe(false);
    expect((await experimentRow(c.t.db, x.id)).status).toBe('completed');
    // Cancelling it again is a no-op.
    expect(result(await c.post(`/runs/${last.id}/cancel`).expect(200)).status).toBe('cancelled');
  });

  it('asks the worker to stop a running run, and refuses a finished one', async () => {
    const [first, second] = await runsOf(c.t.db, x.id);
    await claimRun(c.t.db, first!.id, x.workerId);
    expect(result(await c.post(`/runs/${first!.id}/cancel`).expect(200)).status).toBe('running');
    const [run] = await c.t.db.select().from(runs).where(eq(runs.id, first!.id));
    expect(run!.cancelRequestedAt).toBeInstanceOf(Date);
    await c.post(`/runs/${first!.id}/cancel`).expect(200);
    const [again] = await c.t.db.select().from(runs).where(eq(runs.id, first!.id));
    expect(again!.cancelRequestedAt).toEqual(run!.cancelRequestedAt);

    const attempt = await claimRun(c.t.db, second!.id, x.workerId);
    await finishRun(c.t.db, second!.id, attempt, { status: 'executed' });
    expect(refusal(await c.post(`/runs/${second!.id}/cancel`).expect(409))).toBe(
      'run is executed; only a queued or running run can be cancelled',
    );
    await c.post('/runs/run_gone/cancel').expect(404);
  });
});

describe('POST /api/experiments/:id/runs/retry', () => {
  it('retries the runs it can and refuses the others with their reason', async () => {
    const [e1, e2, scored] = await settle(2);
    const other = await createOtherExperimentRun();
    const res = await c
      .post(`/experiments/${x.id}/runs/retry`, { runIds: [scored, e1, 'run_gone', other, e2] })
      .expect(200);
    expect(BulkRunActionResultSchema.parse(res.body)).toEqual({
      action: 'retry',
      enqueued: [e1, e2],
      refused: [
        { runId: scored, reason: 'run is scored, not execution_error' },
        { runId: 'run_gone', reason: 'run not found in this experiment' },
        { runId: other, reason: 'run not found in this experiment' },
      ],
    });
    const keys = await liveJobKeys(c);
    expect(keys).toContain(`${e1}:2`);
    expect(keys).toContain(`${e2}:2`);
    expect((await experimentRow(c.t.db, x.id)).status).toBe('running');
  });

  it('refuses every run of a cancelled experiment, and 400s an empty or repeated list', async () => {
    const [e1] = await settle(1);
    await c.post(`/experiments/${x.id}/cancel`).expect(200);
    const res = await c.post(`/experiments/${x.id}/runs/retry`, { runIds: [e1] }).expect(200);
    expect(BulkRunActionResultSchema.parse(res.body).refused).toEqual([
      { runId: e1, reason: 'the experiment was cancelled' },
    ]);
    await c.post(`/experiments/${x.id}/runs/retry`, { runIds: [] }).expect(400);
    await c.post(`/experiments/${x.id}/runs/retry`, { runIds: [e1, e1] }).expect(400);
    await c.post('/experiments/exp_gone/runs/retry', { runIds: [e1] }).expect(404);
  });
});

/** A run of a second experiment, to check bulk retry stays within its own. */
async function createOtherExperimentRun(): Promise<string> {
  const [e] = await c.t.db.select().from(experiments).where(eq(experiments.id, x.id));
  const [copy] = await c.t.db
    .insert(experiments)
    .values({
      name: 'other',
      suiteId: e!.suiteId,
      taskIds: e!.taskIds,
      baselineVersionId: e!.baselineVersionId,
      candidateVersionIds: e!.candidateVersionIds,
      repetitions: 1,
      concurrency: 1,
      hermesVersion: e!.hermesVersion,
      hermesRevision: e!.hermesRevision,
      priceTable: e!.priceTable,
    })
    .returning({ id: experiments.id });
  const [run] = await c.t.db
    .insert(runs)
    .values({
      experimentId: copy!.id,
      taskId: e!.taskIds[0]!,
      configurationVersionId: e!.baselineVersionId,
      repetition: 1,
    })
    .returning({ id: runs.id });
  return run!.id;
}
