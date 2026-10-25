/**
 * The claim transaction on PGlite, with the real migrations and triggers:
 * the stale checks, admission, the spend guard, the provider guard (which
 * spends no attempt), and the rows a claim writes.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { attempts, experiments, runs } from '../../database/schema/index.js';
import type { ProviderReadiness } from '../../providers/readiness.js';
import type { ExecuteRunJob } from '../../queue/queues.js';
import { finishAttempt } from './finish.js';
import {
  admissionDelay,
  claimRun,
  readClaimTarget,
  staleReason,
  type ClaimInput,
} from './claim.js';
import {
  HERMES_REVISION,
  attemptsOf,
  experimentRow,
  outcomes,
  PRICED_MODEL,
  RecordingQueue,
  runRow,
  seedLifecycle,
  seedWorker,
  workerInFlight,
} from './testing.support-spec.js';

const READY: ProviderReadiness = { ready: true, status: 'configured', reason: null };
const NOT_READY: ProviderReadiness = {
  ready: false,
  status: 'missing',
  reason: 'CUSTOM_API_KEY is not set in egress',
};

describe('claimRun', () => {
  let t: TestDatabase;
  let queue: RecordingQueue;
  let workerId: string;

  beforeEach(async () => {
    t = await createTestDatabase();
    queue = new RecordingQueue();
    workerId = await seedWorker(t.db);
  });
  afterEach(() => t.close());

  const input = (data: ExecuteRunJob, extra: Partial<ClaimInput> = {}): ClaimInput => ({
    job: { id: 'job-1', data },
    workerId,
    hostId: 'DAEMON:A',
    hermesRevision: HERMES_REVISION,
    readiness: READY,
    queue,
    settings: { leaseSeconds: 60, admissionDelayS: { min: 5, max: 15 } },
    random: () => 0.5,
    ...extra,
  });
  const claim = (data: ExecuteRunJob, extra?: Partial<ClaimInput>) =>
    t.db.transaction((tx) => claimRun(tx, input(data, extra)));

  it('inserts attempt 1 with a fresh lease, points the run at it and counts the trial on the worker', async () => {
    const seed = await seedLifecycle(t.db);
    const runId = seed.runIds[0]!;
    const outcome = await claim({ runId, attempt: 1, trigger: 'initial' });
    expect(outcome.kind).toBe('claimed');
    if (outcome.kind !== 'claimed') return;
    const [attempt] = await attemptsOf(t.db, runId);
    expect(attempt).toMatchObject({
      id: outcome.attempt.attemptId,
      number: 1,
      trigger: 'initial',
      status: 'running',
      workerId,
      trialPath: `trials/${outcome.attempt.attemptId}`,
      sandboxHostId: 'DAEMON:A',
      leaseToken: outcome.attempt.leaseToken,
      leaseRevokedAt: null,
    });
    const [{ secs } = { secs: 0 }] = await t.db
      .select({ secs: sql<number>`extract(epoch from ${attempts.leaseExpiresAt} - now())::float8` })
      .from(attempts)
      .where(eq(attempts.id, outcome.attempt.attemptId));
    expect(secs).toBeGreaterThan(55);
    expect(secs).toBeLessThanOrEqual(60);
    expect(await runRow(t.db, runId)).toMatchObject({
      status: 'running',
      attemptCount: 1,
      currentAttemptId: outcome.attempt.attemptId,
    });
    expect(await workerInFlight(t.db, workerId)).toBe(1);
    expect(outcome.attempt).toMatchObject({
      runId,
      experimentId: seed.experimentId,
      configurationVersionId: seed.baselineVersionId,
      provider: 'custom',
      model: 'mock/scripted',
    });
  });

  it('completes stale jobs without writing: a duplicate, a wrong attempt number, a paused or cancelled experiment', async () => {
    const seed = await seedLifecycle(t.db, { repetitions: 2 });
    const [first, second, third] = seed.runIds as [string, string, string];
    expect((await claim({ runId: first, attempt: 1, trigger: 'initial' })).kind).toBe('claimed');
    // The same job delivered again: the run is no longer queued.
    expect(await claim({ runId: first, attempt: 1, trigger: 'initial' })).toEqual({
      kind: 'stale',
      reason: 'the run is running',
    });
    // A job for attempt 2 of a run that has none.
    expect(await claim({ runId: second, attempt: 2, trigger: 'user_retry' })).toMatchObject({
      kind: 'stale',
    });
    await t.db
      .update(experiments)
      .set({ status: 'paused', pauseReason: 'user', pausedAt: sql`now()` })
      .where(eq(experiments.id, seed.experimentId));
    expect(await claim({ runId: third, attempt: 1, trigger: 'initial' })).toEqual({
      kind: 'stale',
      reason: 'the experiment is paused',
    });
    await t.db
      .update(experiments)
      .set({ status: 'running', pauseReason: null, pausedAt: null, cancelledAt: sql`now()` })
      .where(eq(experiments.id, seed.experimentId));
    expect(await claim({ runId: third, attempt: 1, trigger: 'initial' })).toEqual({
      kind: 'stale',
      reason: 'the experiment was cancelled',
    });
    expect(await claim({ runId: 'missing', attempt: 1, trigger: 'initial' })).toEqual({
      kind: 'stale',
      reason: 'the run does not exist',
    });
    expect((await attemptsOf(t.db, second)).length + (await attemptsOf(t.db, third)).length).toBe(
      0,
    );
    expect(queue.calls).toEqual([]);
  });

  it('defers a job 5 to 15 s when the experiment is at its concurrency', async () => {
    const seed = await seedLifecycle(t.db, { concurrency: 1 });
    const [first, second] = seed.runIds as [string, string];
    await claim({ runId: first, attempt: 1, trigger: 'initial' });
    const outcome = await claim({ runId: second, attempt: 1, trigger: 'initial' });
    expect(outcome).toEqual({ kind: 'deferred', reason: 'admission', startAfterSeconds: 10 });
    expect(queue.calls).toEqual([
      {
        op: 'defer',
        queue: 'execute-run',
        data: { runId: second, attempt: 1, trigger: 'initial' },
        singletonKey: `${second}:1`,
        startAfterSeconds: 10,
      },
    ]);
    expect(await runRow(t.db, second)).toMatchObject({ status: 'queued', attemptCount: 0 });
  });

  it('pauses at the spend ceiling, counting priced attempts only', async () => {
    const seed = await seedLifecycle(t.db, {
      model: PRICED_MODEL,
      spendCeilingUsd: 1,
      repetitions: 2,
    });
    const [first, second, third] = seed.runIds as [string, string, string];
    const claimed = await claim({ runId: first, attempt: 1, trigger: 'initial' });
    if (claimed.kind !== 'claimed') throw new Error('not claimed');
    // An unpriced attempt (cost null) adds nothing.
    expect((await claim({ runId: second, attempt: 1, trigger: 'initial' })).kind).toBe('claimed');
    await t.db
      .update(attempts)
      .set({ costUsd: 1 })
      .where(eq(attempts.id, claimed.attempt.attemptId));
    const outcome = await claim({ runId: third, attempt: 1, trigger: 'initial' });
    expect(outcome).toMatchObject({ kind: 'paused', reason: 'spend_ceiling' });
    expect(await experimentRow(t.db, seed.experimentId)).toMatchObject({
      status: 'paused',
      pauseReason: 'spend_ceiling',
    });
    expect(await runRow(t.db, third)).toMatchObject({ status: 'queued', attemptCount: 0 });
  });

  it('defers, spending nothing, a job of an experiment frozen on another Hermes revision', async () => {
    const seed = await seedLifecycle(t.db);
    const runId = seed.runIds[0]!;
    const outcome = await claim(
      { runId, attempt: 1, trigger: 'initial' },
      { hermesRevision: 'f'.repeat(40) },
    );
    expect(outcome).toEqual({ kind: 'deferred', reason: 'hermes_revision', startAfterSeconds: 10 });
    expect(queue.of('defer')).toHaveLength(1);
    expect(await attemptsOf(t.db, runId)).toEqual([]);
    expect(await runRow(t.db, runId)).toMatchObject({ status: 'queued', attemptCount: 0 });
    expect(await workerInFlight(t.db, workerId)).toBe(0);
    // A worker on the frozen revision claims it.
    expect((await claim({ runId, attempt: 1, trigger: 'initial' })).kind).toBe('claimed');
  });

  it('pauses after a timeout that left no result: egress metered what it spent', async () => {
    const seed = await seedLifecycle(t.db, { model: PRICED_MODEL, spendCeilingUsd: 1 });
    const [first, second] = seed.runIds as [string, string];
    const claimed = await claim({ runId: first, attempt: 1, trigger: 'initial' });
    if (claimed.kind !== 'claimed') throw new Error('not claimed');
    await finishAttempt(t.db, {
      claimed: claimed.attempt,
      nextSeq: 1,
      outcome: outcomes.error('timeout', {
        tokens: null,
        egressUsage: { calls: 4, promptTokens: 1000, completionTokens: 50, totalTokens: 1050 },
      }),
      queue,
      settings: { maxConsecutiveExecutionErrors: 100, autoRetryDelayS: 30 },
    });
    // $1 at $1000 per million input tokens: at the ceiling, so the next claim pauses.
    const outcome = await claim({ runId: second, attempt: 1, trigger: 'initial' });
    expect(outcome).toMatchObject({ kind: 'paused', reason: 'spend_ceiling' });
    expect(await runRow(t.db, second)).toMatchObject({ status: 'queued', attemptCount: 0 });
  });

  it('counts an attempt whose trial ran but whose cost nobody measured, at the mean cost', async () => {
    const seed = await seedLifecycle(t.db, {
      model: PRICED_MODEL,
      spendCeilingUsd: 1.5,
      repetitions: 2,
    });
    const [paid, lost, setup, next] = seed.runIds as [string, string, string, string];
    /** Claims the run and ends its attempt (and the run) as an execution error with `values`. */
    const end = async (runId: string, values: Record<string, unknown>) => {
      const claimed = await claim({ runId, attempt: 1, trigger: 'initial' });
      if (claimed.kind !== 'claimed') throw new Error(`${runId} not claimed: ${claimed.kind}`);
      await t.db
        .update(attempts)
        .set({
          status: 'execution_error',
          errorCategory: 'other',
          finishedAt: sql`now()`,
          ...values,
        })
        .where(eq(attempts.id, claimed.attempt.attemptId));
      await t.db
        .update(runs)
        .set({ status: 'execution_error', finishedAt: sql`now()` })
        .where(eq(runs.id, runId));
    };
    await end(paid, { costUsd: 1, sandboxId: 'a'.repeat(64) });
    // A setup failure never reached a container: it spent nothing and counts nothing, so
    // the next claim ($1 of $1.50) goes ahead.
    await end(setup, {});
    // A worker_lost attempt whose container ran: its usage is unknown, never zero.
    await end(lost, { sandboxId: 'b'.repeat(64), errorCategory: 'worker_lost' });
    const outcome = await claim({ runId: next, attempt: 1, trigger: 'initial' });
    expect(outcome).toMatchObject({ kind: 'paused', reason: 'spend_ceiling' });
    expect(outcome.kind === 'paused' && outcome.message).toBe(
      'spend $2.00 (with 1 attempt of unknown cost counted at $1.00 each) reached the $1.50 ceiling',
    );
  });

  it('pauses with provider_disconnected and spends no attempt when the provider is not ready', async () => {
    const seed = await seedLifecycle(t.db);
    const runId = seed.runIds[0]!;
    const outcome = await claim(
      { runId, attempt: 1, trigger: 'initial' },
      { readiness: NOT_READY },
    );
    expect(outcome).toEqual({
      kind: 'paused',
      reason: 'provider_disconnected',
      message: NOT_READY.reason,
    });
    const experiment = await experimentRow(t.db, seed.experimentId);
    expect(experiment).toMatchObject({ status: 'paused', pauseReason: 'provider_disconnected' });
    expect(experiment.pausedAt).not.toBeNull();
    expect(await runRow(t.db, runId)).toMatchObject({ status: 'queued', attemptCount: 0 });
    expect(await attemptsOf(t.db, runId)).toEqual([]);
    expect(await workerInFlight(t.db, workerId)).toBe(0);
  });

  it('reads the unlocked target the handler checks first', async () => {
    const seed = await seedLifecycle(t.db);
    const runId = seed.runIds[0]!;
    const target = await readClaimTarget(t.db, runId);
    expect(target).toEqual({
      experimentId: seed.experimentId,
      experimentStatus: 'running',
      cancelled: false,
      runStatus: 'queued',
      attemptCount: 0,
      provider: 'custom',
      model: 'mock/scripted',
      hermesRevision: HERMES_REVISION,
    });
    expect(staleReason(target!, 1)).toBeNull();
    expect(staleReason(target!, 2)).toMatch(/stale/);
    expect(await readClaimTarget(t.db, 'missing')).toBeNull();
    await t.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: sql`now()` })
      .where(eq(runs.id, runId));
    expect(staleReason((await readClaimTarget(t.db, runId))!, 1)).toBe('the run is cancelled');
  });
});

describe('admissionDelay', () => {
  it('spreads deferred jobs over the window', () => {
    expect(admissionDelay({ min: 5, max: 15 }, () => 0)).toBe(5);
    expect(admissionDelay({ min: 5, max: 15 }, () => 0.999)).toBe(15);
    expect(admissionDelay({ min: 1, max: 1 }, Math.random)).toBe(1);
  });
});
