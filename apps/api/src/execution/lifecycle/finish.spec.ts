/**
 * The fenced sink and the finish transaction on PGlite: gap-free sequence
 * numbers, every write refused once the lease is gone, and what each outcome
 * leads to (evaluation, automatic retry, the circuit breaker, cancel,
 * reconcile).
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchRecordSchema, type LaunchRecord } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import {
  artifacts,
  attempts,
  evaluations,
  experiments,
  runEvents,
  runs,
} from '../../database/schema/index.js';
import { LeaseLostError } from '../contracts.js';
import { insertFencedEvents } from './fence.js';
import { autoRetries, finishAttempt, normalise, type FinishInput } from './finish.js';
import { firstLine } from './first-line.js';
import { FencedAttemptSink } from './sink.js';
import {
  attemptsOf,
  claimAttempt,
  collectedEvent,
  experimentRow,
  outcomes,
  PRICED_MODEL,
  RecordingQueue,
  runRow,
  seedLifecycle,
  seedWorker,
  sha,
  textEvent,
  TOKENS,
  workerInFlight,
} from './testing.support-spec.js';
import type { ClaimedAttempt } from './types.js';

describe('the fenced sink and the finish transaction', () => {
  let t: TestDatabase;
  let queue: RecordingQueue;
  let workerId: string;

  beforeEach(async () => {
    t = await createTestDatabase();
    queue = new RecordingQueue();
    workerId = await seedWorker(t.db);
  });
  afterEach(() => t.close());

  const settings = { maxConsecutiveExecutionErrors: 3, autoRetryDelayS: 30 };
  const finish = (claimed: ClaimedAttempt, outcome: FinishInput['outcome'], nextSeq = 1) =>
    finishAttempt(t.db, { claimed, nextSeq, outcome, queue, settings });
  const seqs = async (attemptId: string) =>
    (
      await t.db
        .select({ seq: runEvents.seq })
        .from(runEvents)
        .where(eq(runEvents.attemptId, attemptId))
        .orderBy(runEvents.seq)
    ).map((row) => row.seq);
  const revoke = (attemptId: string) =>
    t.db
      .update(attempts)
      .set({ leaseRevokedAt: sql`now()` })
      .where(eq(attempts.id, attemptId));

  it('numbers events gap-free across batches and the final events', async () => {
    const seed = await seedLifecycle(t.db);
    const claimed = await claimAttempt(t.db, seed.runIds[0]!, workerId);
    const sink = new FencedAttemptSink(t.db, claimed);
    await sink.appendEvents([textEvent('one'), textEvent('two')]);
    await sink.appendEvents([]);
    await sink.appendEvents([textEvent('three')]);
    expect(sink.nextSeq).toBe(4);
    await finish(claimed, outcomes.executed({ finalEvents: [collectedEvent()] }), sink.nextSeq);
    expect(await seqs(claimed.attemptId)).toEqual([1, 2, 3, 4]);
  });

  it('writes the launch record and the container once, and reads a cancel request', async () => {
    const seed = await seedLifecycle(t.db);
    const claimed = await claimAttempt(t.db, seed.runIds[0]!, workerId);
    const sink = new FencedAttemptSink(t.db, claimed);
    const record: LaunchRecord = LaunchRecordSchema.parse({
      argv: ['hermes', 'chat'],
      cwd: '/workspace',
      env: { HERMES_HOME: '/home/hermes/.hermes', HOME: '/home/hermes', PATH: '/usr/bin' },
      secret_env_names: ['HERMES_EVALS_ATTEMPT_TOKEN'],
      config_path: '/home/hermes/.hermes/config.yaml',
      config_yaml: 'model: {}\n',
      skills: [],
      mcp_servers: [],
      inputs: [],
      limits: { max_turns: 20, run_budget_seconds: 300, deadline_seconds: 370 },
      hermes: { version: '0.22.4', revision: '4d04303818b61bf3aa09278af48356315515965b' },
    });
    await sink.recordLaunch(record);
    await expect(sink.recordLaunch(record)).rejects.toThrow(/once/);
    await sink.recordContainer('c'.repeat(64), 'OTHER:DAEMON');
    const [row] = await attemptsOf(t.db, seed.runIds[0]!);
    expect(row).toMatchObject({ sandboxId: 'c'.repeat(64), sandboxHostId: 'FAKE:DAEMON' });
    expect(row!.launchRecord).toEqual(record);
    expect(await sink.cancelRequested()).toBe(false);
    await t.db
      .update(runs)
      .set({ cancelRequestedAt: sql`now()` })
      .where(eq(runs.id, seed.runIds[0]!));
    expect(await sink.cancelRequested()).toBe(true);
  });

  it('refuses every write once the lease is revoked or the token is wrong, and the finish writes nothing', async () => {
    const seed = await seedLifecycle(t.db);
    const claimed = await claimAttempt(t.db, seed.runIds[0]!, workerId);
    const forged = new FencedAttemptSink(t.db, { ...claimed, leaseToken: crypto.randomUUID() });
    await expect(forged.appendEvents([textEvent('x')])).rejects.toBeInstanceOf(LeaseLostError);
    const sink = new FencedAttemptSink(t.db, claimed);
    await sink.appendEvents([textEvent('before')]);
    await revoke(claimed.attemptId);
    await expect(sink.appendEvents([textEvent('after')])).rejects.toBeInstanceOf(LeaseLostError);
    await expect(sink.appendEvents([])).rejects.toBeInstanceOf(LeaseLostError);
    await expect(sink.cancelRequested()).rejects.toBeInstanceOf(LeaseLostError);
    await expect(sink.recordContainer('c'.repeat(64), 'FAKE:DAEMON')).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(
      finish(claimed, outcomes.executed({ finalEvents: [collectedEvent()] }), sink.nextSeq),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(await seqs(claimed.attemptId)).toEqual([1]);
    expect(await attemptsOf(t.db, seed.runIds[0]!)).toMatchObject([{ status: 'running' }]);
    expect(await runRow(t.db, seed.runIds[0]!)).toMatchObject({ status: 'running' });
    expect(queue.calls).toEqual([]);
  });

  it('executed: run executed, evaluation generation 1 with its job, cost from the frozen prices, breaker reset', async () => {
    const seed = await seedLifecycle(t.db, { model: PRICED_MODEL });
    const runId = seed.runIds[0]!;
    await t.db
      .update(experiments)
      .set({ consecutiveExecutionErrors: 2 })
      .where(eq(experiments.id, seed.experimentId));
    const claimed = await claimAttempt(t.db, runId, workerId);
    const content = 'Total: 1042\n';
    const result = await finish(
      claimed,
      outcomes.executed({
        artifacts: [
          {
            root: 'workspace',
            path: 'summary.txt',
            origin: 'agent',
            size: content.length,
            sha256: sha(content),
            skippedReason: null,
          },
          {
            root: 'workspace',
            path: 'huge.bin',
            origin: 'agent',
            size: 30_000_000,
            sha256: null,
            skippedReason: 'too_large',
          },
          // A memory file (Phase 6 P2): the same content, under the home's root.
          {
            root: 'home',
            path: 'memories/USER.md',
            origin: 'home_seed_modified',
            size: content.length,
            sha256: sha(content),
            skippedReason: null,
          },
        ],
      }),
    );
    expect(result).toMatchObject({
      attemptStatus: 'executed',
      runStatus: 'executed',
      retryAttempt: null,
      experimentFailed: false,
      reconciled: 'unchanged',
    });
    const [attempt] = await attemptsOf(t.db, runId);
    expect(attempt).toMatchObject({
      status: 'executed',
      tokens: TOKENS,
      durationMs: 4200,
      exitCode: 0,
    });
    // 1000 input tokens at $1000 per million.
    expect(attempt!.costUsd).toBe(1);
    expect(await runRow(t.db, runId)).toMatchObject({ status: 'executed', finishedAt: null });
    const [evaluation] = await t.db.select().from(evaluations).where(eq(evaluations.runId, runId));
    expect(evaluation).toMatchObject({
      id: result.evaluationId,
      attemptId: claimed.attemptId,
      generation: 1,
      cause: 'initial',
      status: 'queued',
    });
    expect(queue.of('send', 'evaluate-run')).toEqual([
      {
        op: 'send',
        queue: 'evaluate-run',
        data: { evaluationId: result.evaluationId },
        singletonKey: result.evaluationId,
      },
    ]);
    expect((await experimentRow(t.db, seed.experimentId)).consecutiveExecutionErrors).toBe(0);
    expect(await workerInFlight(t.db, workerId)).toBe(0);
    expect(
      (await t.db.select().from(artifacts).where(eq(artifacts.attemptId, claimed.attemptId))).map(
        (a) => `${a.root}/${a.path}`,
      ),
    ).toEqual(
      expect.arrayContaining([
        'workspace/summary.txt',
        'workspace/huge.bin',
        'home/memories/USER.md',
      ]),
    );
  });

  it('prices what egress metered when Hermes printed no result, or a result that claims less', async () => {
    const seed = await seedLifecycle(t.db, { model: PRICED_MODEL, repetitions: 2 });
    const [timedOut, forged, honest] = seed.runIds as [string, string, string];
    const usage = { calls: 3, promptTokens: 1000, completionTokens: 100, totalTokens: 1100 };

    // A deadline: no result, so no Hermes tokens, but egress counted three calls.
    const a = await claimAttempt(t.db, timedOut, workerId);
    await finish(a, outcomes.error('timeout', { tokens: null, egressUsage: usage }));
    const [first] = await attemptsOf(t.db, timedOut);
    expect(first!.tokens).toEqual({
      input: 1000,
      output: 100,
      total: 1100,
      cache_read: 0,
      cache_write: 0,
    });
    // (1000 × $1000 + 100 × $0) per million.
    expect(first!.costUsd).toBe(1);

    // A result line the agent printed itself, claiming nothing was used.
    const b = await claimAttempt(t.db, forged, workerId);
    const zero = { input: 0, output: 0, total: 0, cache_read: 0, cache_write: 0 };
    await finish(b, outcomes.executed({ tokens: zero, egressUsage: usage }));
    expect((await attemptsOf(t.db, forged))[0]!.costUsd).toBe(1);

    // An honest result that covers egress's count stays the record, cache split included.
    const c = await claimAttempt(t.db, honest, workerId);
    const cached = { input: 1000, output: 100, total: 1100, cache_read: 800, cache_write: 0 };
    await finish(c, outcomes.executed({ tokens: cached, egressUsage: usage }));
    const [kept] = await attemptsOf(t.db, honest);
    expect(kept!.tokens).toEqual(cached);
    // 200 uncached + 800 cache reads, both at the input rate (no cache price): still $1.
    expect(kept!.costUsd).toBe(1);
  });

  it('records a measured zero when egress counted no model call, and nothing without egress', async () => {
    const seed = await seedLifecycle(t.db, { model: PRICED_MODEL });
    const [none, unknown] = seed.runIds as [string, string];
    const a = await claimAttempt(t.db, none, workerId);
    await finish(
      a,
      outcomes.error('other', {
        tokens: null,
        egressUsage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      }),
    );
    expect((await attemptsOf(t.db, none))[0]!.costUsd).toBe(0);
    const b = await claimAttempt(t.db, unknown, workerId);
    await finish(b, outcomes.error('other', { tokens: null, egressUsage: null }));
    const [lost] = await attemptsOf(t.db, unknown);
    expect(lost!.costUsd).toBeNull();
    expect(lost!.tokens).toBeNull();
  });

  it('counts a retried batch that had already committed once, without storing it twice', async () => {
    const seed = await seedLifecycle(t.db);
    const claimed = await claimAttempt(t.db, seed.runIds[0]!, workerId);
    const sink = new FencedAttemptSink(t.db, claimed);
    const batch = [textEvent('one'), textEvent('two')];
    // The commit went through but its reply was lost: the rows are there, the counter is not.
    await insertFencedEvents(t.db, claimed, 1, batch);
    await sink.appendEvents(batch);
    expect(sink.nextSeq).toBe(3);
    await sink.appendEvents([textEvent('three')]);
    expect(await seqs(claimed.attemptId)).toEqual([1, 2, 3]);
    // Rows that are not all there are not taken for a commit.
    const other = new FencedAttemptSink(t.db, claimed);
    const four = [textEvent('x'), textEvent('y'), textEvent('z'), textEvent('w')];
    await expect(other.appendEvents(four)).rejects.toThrow();
  });

  it('retries a provider or timeout error of attempt 1 once, 30 s later; not attempt 2', async () => {
    const seed = await seedLifecycle(t.db);
    const runId = seed.runIds[0]!;
    const first = await claimAttempt(t.db, runId, workerId);
    const retried = await finish(first, outcomes.error('timeout'));
    expect(retried).toMatchObject({
      attemptStatus: 'execution_error',
      runStatus: 'queued',
      retryAttempt: 2,
    });
    expect(await runRow(t.db, runId)).toMatchObject({
      status: 'queued',
      attemptCount: 1,
      finishedAt: null,
      nextTrigger: 'auto_retry',
    });
    expect(queue.of('send', 'execute-run')).toEqual([
      {
        op: 'send',
        queue: 'execute-run',
        data: { runId, attempt: 2, trigger: 'auto_retry' },
        singletonKey: `${runId}:2`,
        startAfterSeconds: 30,
      },
    ]);
    const second = await claimAttempt(t.db, runId, workerId, { attempt: 2 });
    const final = await finish(second, outcomes.error('provider'));
    expect(final).toMatchObject({ runStatus: 'execution_error', retryAttempt: null });
    const run = await runRow(t.db, runId);
    expect(run.status).toBe('execution_error');
    expect(run.finishedAt).not.toBeNull();
    expect(queue.of('send', 'execute-run')).toHaveLength(1);
  });

  it('leaves setup and other errors for the user, and counts each one', async () => {
    const seed = await seedLifecycle(t.db);
    const claimed = await claimAttempt(t.db, seed.runIds[0]!, workerId);
    expect(await finish(claimed, outcomes.error('setup'))).toMatchObject({
      runStatus: 'execution_error',
      retryAttempt: null,
    });
    expect((await experimentRow(t.db, seed.experimentId)).consecutiveExecutionErrors).toBe(1);
    expect(queue.calls).toEqual([]);
  });

  it('fails a running experiment at the breaker threshold, with its structured failure', async () => {
    const seed = await seedLifecycle(t.db, { tasks: 2, repetitions: 1 });
    const results = [];
    for (const runId of seed.runIds.slice(0, 3)) {
      const claimed = await claimAttempt(t.db, runId, workerId);
      results.push(await finish(claimed, outcomes.error('other', { exitCode: 2 })));
    }
    expect(results.map((r) => r.experimentFailed)).toEqual([false, false, true]);
    const experiment = await experimentRow(t.db, seed.experimentId);
    expect(experiment).toMatchObject({ status: 'failed', consecutiveExecutionErrors: 3 });
    expect(experiment.finishedAt).not.toBeNull();
    expect(experiment.failure).toMatchObject({
      threshold: 3,
      category: 'other',
      exit_code: 2,
      message: 'failed: other',
      stderr_first_line: 'Error: other went wrong',
      run_id: seed.runIds[2],
    });
    // The fourth run's job is stale now.
    expect(await runRow(t.db, seed.runIds[3]!)).toMatchObject({ status: 'queued' });
  });

  it('cancelled: run cancelled, and the last run to settle completes the cancelled experiment', async () => {
    const seed = await seedLifecycle(t.db);
    const [first, second] = seed.runIds as [string, string];
    const a = await claimAttempt(t.db, first, workerId);
    const b = await claimAttempt(t.db, second, workerId);
    // Cancel as the control does it: cancelled_at, and cancel_requested_at on running runs.
    await t.db
      .update(experiments)
      .set({ cancelledAt: sql`now()` })
      .where(eq(experiments.id, seed.experimentId));
    await t.db
      .update(runs)
      .set({ cancelRequestedAt: sql`now()` })
      .where(eq(runs.experimentId, seed.experimentId));
    expect(await finish(a, outcomes.cancelled())).toMatchObject({
      runStatus: 'cancelled',
      reconciled: 'unchanged',
    });
    // An execution error a cancel caused or met ends as cancelled, and is never retried.
    expect(await finish(b, outcomes.error('timeout'))).toMatchObject({
      attemptStatus: 'cancelled',
      runStatus: 'cancelled',
      retryAttempt: null,
      reconciled: 'completed',
    });
    const experiment = await experimentRow(t.db, seed.experimentId);
    expect(experiment.status).toBe('completed');
    expect(experiment.verdictRevision).toBe(experiment.resultsRevision);
    expect(experiment.consecutiveExecutionErrors).toBe(0);
  });

  it('turns an executed outcome without text into an execution error the database accepts', () => {
    expect(normalise(outcomes.executed({ finalText: null }), false)).toMatchObject({
      status: 'execution_error',
      category: 'other',
    });
    expect(normalise(outcomes.error('provider'), true)).toMatchObject({
      status: 'cancelled',
      category: null,
    });
    expect(normalise(outcomes.executed({ category: 'other' }), false).category).toBeNull();
    expect(autoRetries('timeout', 1, false)).toBe(true);
    expect(autoRetries('timeout', 1, true)).toBe(false);
    expect(autoRetries('setup', 1, false)).toBe(false);
    expect(firstLine('\n  \n  boom  \nmore')).toBe('boom');
    expect(firstLine(null)).toBeNull();
  });
});
