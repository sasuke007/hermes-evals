/**
 * Recovery on PGlite with the fake engine (plan 8.6): which leases are
 * revoked, confirming a lost trial is gone before it is finalised, the
 * requeue rules, the sweep, the re-sent jobs, the reconcile safety net and
 * retention.
 */
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { FakeEngine } from '../../../test/support/fake-engine.js';
import {
  attempts,
  evaluations,
  experiments,
  runEvents,
  runs,
  workers,
} from '../../database/schema/index.js';
import { newId } from '../../database/ids.js';
import { EngineClient } from '../../sandbox/engine-client.js';
import { forceRemoveTree, removeTrialDirs } from '../../sandbox/trial-runner.js';
import { finishAttempt } from './finish.js';
import { recoveryPass, revokeLeases, type RecoveryDeps } from './recovery.js';
import { drizzlePoolRecoveryLock, sessionRecoveryLock } from './recovery-lock.js';
import { FencedAttemptSink } from './sink.js';
import {
  attemptsOf,
  claimAttempt,
  expireLease,
  experimentRow,
  memoryLogger,
  outcomes,
  RecordingQueue,
  runRow,
  seedLifecycle,
  seedWorker,
  textEvent,
  workerInFlight,
} from './testing.support-spec.js';

const HOST = 'FAKE:DAEMON';

describe('recovery', () => {
  let t: TestDatabase;
  let queue: RecordingQueue;
  let engine: FakeEngine;
  let workerId: string;
  let trialsDir: string;

  beforeEach(async () => {
    t = await createTestDatabase();
    queue = new RecordingQueue();
    engine = new FakeEngine({ daemonId: HOST, script: () => ({ hang: true }) });
    workerId = await seedWorker(t.db);
    trialsDir = await mkdtemp(join(tmpdir(), 'hermes-evals-recovery-'));
  });
  afterEach(async () => {
    await t.close();
    await forceRemoveTree(trialsDir);
  });

  const deps = (extra: Partial<RecoveryDeps> = {}): RecoveryDeps => ({
    db: t.db,
    queue,
    engine,
    hostId: HOST,
    trialsDir,
    lock: sessionRecoveryLock(t.db),
    settings: { trialRetentionDays: 7 },
    logger: memoryLogger(),
    clearTimeoutMs: 2_000,
    ...extra,
  });
  const pass = async (extra?: Partial<RecoveryDeps>) => (await recoveryPass(deps(extra)))!;

  /** A started trial container of this attempt, as the runner creates it. */
  const trialContainer = async (
    runId: string,
    attemptId: string,
    deadlineS = Date.now() / 1000 + 600,
  ) => {
    const id = await engine.createContainer(`hermes-evals-run-${runId}`, {
      Labels: {
        'hermes-evals.role': 'trial',
        'hermes-evals.run': runId,
        'hermes-evals.attempt': attemptId,
        'hermes-evals.deadline': String(Math.floor(deadlineS)),
      },
      HostConfig: { NetworkMode: 'hermes-evals-trial-0' },
    });
    await engine.start(id);
    return id;
  };

  it('revokes expired leases and those of stopped workers, never a live one', async () => {
    const seed = await seedLifecycle(t.db, { repetitions: 2 });
    const [a, b, c] = seed.runIds as [string, string, string];
    const expired = await claimAttempt(t.db, a, workerId);
    const live = await claimAttempt(t.db, b, workerId);
    const stoppedWorker = await seedWorker(t.db, 'worker-2');
    const orphan = await claimAttempt(t.db, c, stoppedWorker);
    await expireLease(t.db, expired.attemptId);
    await t.db
      .update(workers)
      .set({ stoppedAt: sql`now()` })
      .where(eq(workers.id, stoppedWorker));
    const revoked = await revokeLeases(t.db);
    expect(revoked.sort()).toEqual([expired.attemptId, orphan.attemptId].sort());
    expect(await revokeLeases(t.db)).toEqual([]);
    const [liveRow] = await attemptsOf(t.db, b);
    expect(liveRow!.id).toBe(live.attemptId);
    expect(liveRow!.leaseRevokedAt).toBeNull();
  });

  it('revokes an attempt past its deadline even while its lease is renewed', async () => {
    const seed = await seedLifecycle(t.db, { timeBudgetS: 60 });
    const runId = seed.runIds[0]!;
    // started_at is fixed once written, so the attempt is inserted already old.
    const attemptId = newId();
    await t.db.transaction(async (tx) => {
      await tx.insert(attempts).values({
        id: attemptId,
        runId,
        number: 1,
        trigger: 'initial',
        status: 'running',
        workerId,
        trialPath: `trials/${attemptId}`,
        startedAt: new Date(Date.now() - 2 * 3600_000),
        sandboxHostId: HOST,
      });
      await tx
        .update(runs)
        .set({ status: 'running', attemptCount: 1, currentAttemptId: attemptId })
        .where(eq(runs.id, runId));
    });
    expect(await revokeLeases(t.db)).toEqual([attemptId]);
  });

  it('stops the lost trial, then finalises it as worker_lost and requeues the run with trigger recovery', async () => {
    const seed = await seedLifecycle(t.db);
    const runId = seed.runIds[0]!;
    const claimed = await claimAttempt(t.db, runId, workerId);
    await new FencedAttemptSink(t.db, claimed).appendEvents([textEvent('one'), textEvent('two')]);
    const container = await trialContainer(runId, claimed.attemptId);
    await expireLease(t.db, claimed.attemptId);
    // What the lost worker left on the trials volume: Hermes's session state in the home,
    // in a directory the agent locked, and the workspace.
    const root = join(trialsDir, claimed.attemptId);
    await mkdir(join(root, 'home', 'sessions'), { recursive: true });
    await writeFile(join(root, 'home', 'sessions', 'state.json'), '{"secret":"kept"}');
    await chmod(join(root, 'home', 'sessions'), 0o500);
    await mkdir(join(root, 'workspace'), { recursive: true });
    const aborted: string[] = [];

    const report = await pass({ onRevoked: (id) => aborted.push(id) });
    // The home goes with the finalise, as a normal finish deletes it; the rest stays for retention.
    expect(existsSync(join(root, 'home'))).toBe(false);
    expect(existsSync(join(root, 'workspace'))).toBe(true);

    expect(report.revoked).toEqual([claimed.attemptId]);
    expect(aborted).toEqual([claimed.attemptId]);
    expect(engine.calls).toContain(`kill ${container}`);
    expect(await engine.list([`hermes-evals.run=${runId}`])).toEqual([]);
    expect(report.finalised).toMatchObject([
      {
        attemptId: claimed.attemptId,
        attemptStatus: 'execution_error',
        runStatus: 'queued',
        requeuedAttempt: 2,
      },
    ]);
    const [attempt] = await attemptsOf(t.db, runId);
    expect(attempt).toMatchObject({ status: 'execution_error', errorCategory: 'worker_lost' });
    expect(attempt!.errorMessage).toMatch(/stopped renewing the lease/);
    const events = await t.db
      .select({ seq: runEvents.seq, payload: runEvents.payload })
      .from(runEvents)
      .where(eq(runEvents.attemptId, claimed.attemptId))
      .orderBy(runEvents.seq);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(events[2]!.payload).toMatchObject({ type: 'platform', subtype: 'worker_lost' });
    expect(await runRow(t.db, runId)).toMatchObject({ status: 'queued', attemptCount: 1 });
    expect(queue.of('send', 'execute-run')).toEqual([
      {
        op: 'send',
        queue: 'execute-run',
        data: { runId, attempt: 2, trigger: 'recovery' },
        singletonKey: `${runId}:2`,
      },
    ]);
    expect(await workerInFlight(t.db, workerId)).toBe(0);
  });

  it('removes a lost attempt from egress once its container is gone, so its token dies', async () => {
    const seed = await seedLifecycle(t.db, { repetitions: 2 });
    const [lost, elsewhere] = seed.runIds as [string, string];
    const here = await claimAttempt(t.db, lost, workerId);
    const other = await claimAttempt(t.db, elsewhere, workerId, { hostId: 'OTHER:DAEMON' });
    const container = await trialContainer(lost, here.attemptId);
    await expireLease(t.db, here.attemptId);
    await expireLease(t.db, other.attemptId);
    const removed: string[] = [];
    const egress = {
      remove: async (attemptId: string) => {
        // The container is stopped first: nothing holds the token when it dies.
        expect(engine.calls).toContain(`kill ${container}`);
        removed.push(attemptId);
        return null;
      },
    };
    const report = await pass({ egress });
    expect(report.finalised.map((f) => f.attemptId)).toEqual([here.attemptId]);
    // The other daemon's attempt is not this egress's to remove.
    expect(removed).toEqual([here.attemptId]);

    // An egress that cannot be reached leaves the registration to expire; the attempt still finalises.
    const third = await claimAttempt(t.db, (await seedLifecycle(t.db)).runIds[0]!, workerId);
    await expireLease(t.db, third.attemptId);
    const logger = memoryLogger();
    const failing = { remove: () => Promise.reject(new Error('egress is down')) };
    const next = await pass({ egress: failing, logger });
    expect(next.finalised.map((f) => f.attemptId)).toEqual([third.attemptId]);
    expect(logger.lines.map((l) => l.msg)).toContain(
      'could not remove a lost attempt from egress; its registration expires on its own',
    );
  });

  it('stops requeueing after three attempts, and ends a cancelled run as cancelled', async () => {
    const seed = await seedLifecycle(t.db);
    const [lost, cancelled] = seed.runIds as [string, string];
    for (const attempt of [1, 2]) {
      const claimed = await claimAttempt(t.db, lost, workerId, { attempt });
      await finishAttempt(t.db, {
        claimed,
        nextSeq: 1,
        outcome: outcomes.error('other'),
        queue,
        settings: { maxConsecutiveExecutionErrors: 100, autoRetryDelayS: 30 },
      });
      await t.db.update(runs).set({ status: 'queued', finishedAt: null }).where(eq(runs.id, lost));
    }
    const third = await claimAttempt(t.db, lost, workerId, { attempt: 3 });
    const toCancel = await claimAttempt(t.db, cancelled, workerId);
    await t.db
      .update(runs)
      .set({ cancelRequestedAt: sql`now()` })
      .where(eq(runs.id, cancelled));
    await expireLease(t.db, third.attemptId);
    await expireLease(t.db, toCancel.attemptId);

    const report = await pass();

    expect(report.finalised).toHaveLength(2);
    expect(report.finalised).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attemptId: third.attemptId,
          attemptStatus: 'execution_error',
          runStatus: 'execution_error',
          requeuedAttempt: null,
        }),
        expect.objectContaining({
          attemptId: toCancel.attemptId,
          attemptStatus: 'cancelled',
          runStatus: 'cancelled',
          requeuedAttempt: null,
        }),
      ]),
    );
    expect(await runRow(t.db, lost)).toMatchObject({ status: 'execution_error', attemptCount: 3 });
    expect(await runRow(t.db, cancelled)).toMatchObject({ status: 'cancelled' });
    expect(queue.of('send', 'execute-run')).toEqual([]);
    // Both runs are final now, so the experiment completed in the same pass.
    expect((await experimentRow(t.db, seed.experimentId)).status).toBe('completed');
  });

  it('leaves an attempt of another daemon revoked, and one it cannot confirm unfinalised', async () => {
    const seed = await seedLifecycle(t.db);
    const [other, unconfirmable] = seed.runIds as [string, string];
    const elsewhere = await claimAttempt(t.db, other, workerId, { hostId: 'OTHER:DAEMON' });
    const here = await claimAttempt(t.db, unconfirmable, workerId);
    await expireLease(t.db, elsewhere.attemptId);
    await expireLease(t.db, here.attemptId);
    const broken = new (class extends EngineClient {
      override list(): never {
        throw new Error('docker-guard is down');
      }
    })('/nonexistent.sock');

    const report = await pass({ engine: broken });

    expect(report.revoked.sort()).toEqual([elsewhere.attemptId, here.attemptId].sort());
    expect(report.unconfirmed).toEqual([here.attemptId]);
    expect(report.finalised).toEqual([]);
    for (const runId of [other, unconfirmable]) {
      const [attempt] = await attemptsOf(t.db, runId);
      expect(attempt!.status).toBe('running');
      expect(attempt!.leaseRevokedAt).not.toBeNull();
    }
    // The next pass with a working engine confirms and finalises only its own.
    const next = await pass();
    expect(next.finalised.map((f) => f.attemptId)).toEqual([here.attemptId]);
  });

  it('sweeps containers of finished attempts and past their deadline, and keeps live ones', async () => {
    const seed = await seedLifecycle(t.db);
    const [done, live] = seed.runIds as [string, string];
    const finished = await claimAttempt(t.db, done, workerId);
    const running = await claimAttempt(t.db, live, workerId);
    const stale = await trialContainer(done, finished.attemptId);
    await finishAttempt(t.db, {
      claimed: finished,
      nextSeq: 1,
      outcome: outcomes.error('other'),
      queue,
      settings: { maxConsecutiveExecutionErrors: 100, autoRetryDelayS: 30 },
    });
    // Past its label but still running under a lease nobody revoked: its owner is stopping it
    // (in the stop grace, say), and removing it under the owner would turn a timeout into an
    // engine failure. The revoke step deals with an owner that never does.
    const kept = await trialContainer(live, running.attemptId, Date.now() / 1000 - 5);
    const probe = await trialContainer('probe-run', 'probe-attempt', Date.now() / 1000 - 5);

    const report = await pass();

    expect(report.swept).toBe(2);
    const left = (await engine.list(['hermes-evals.role=trial'])).map((c) => c.Id);
    expect(left).toEqual([kept]);
    expect(left).not.toContain(stale);
    expect(left).not.toContain(probe);
  });

  it('re-sends jobs for queued runs of running experiments and for queued or expired evaluations', async () => {
    const running = await seedLifecycle(t.db, { repetitions: 2 });
    const paused = await seedLifecycle(t.db);
    await t.db
      .update(experiments)
      .set({ status: 'paused', pauseReason: 'user', pausedAt: sql`now()` })
      .where(eq(experiments.id, paused.experimentId));
    const [executedRun, scoringRun, ...queued] = running.runIds as [string, string, ...string[]];
    const evaluationIds: string[] = [];
    for (const runId of [executedRun, scoringRun]) {
      const claimed = await claimAttempt(t.db, runId, workerId);
      const result = await finishAttempt(t.db, {
        claimed,
        nextSeq: 1,
        outcome: outcomes.executed(),
        queue,
        settings: { maxConsecutiveExecutionErrors: 100, autoRetryDelayS: 30 },
      });
      evaluationIds.push(result.evaluationId!);
    }
    // One evaluation's claim expired mid-scoring.
    await t.db.update(runs).set({ status: 'scoring' }).where(eq(runs.id, scoringRun));
    await t.db
      .update(evaluations)
      .set({
        status: 'running',
        startedAt: sql`now()`,
        claimToken: crypto.randomUUID(),
        claimExpiresAt: sql`now() - interval '1 second'`,
      })
      .where(eq(evaluations.id, evaluationIds[1]!));
    queue.calls.length = 0;

    const report = await pass();

    expect(report.resentRuns).toBe(queued.length);
    expect(
      queue
        .of('sendMany', 'execute-run')
        .map((c) => c.data)
        .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
    ).toEqual(
      queued
        .map((runId) => ({ runId, attempt: 1, trigger: 'initial' }))
        .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
    );
    expect(report.resentEvaluations).toBe(2);
    expect(
      queue
        .of('sendMany', 'evaluate-run')
        .map((c) => c.singletonKey)
        .sort(),
    ).toEqual([...evaluationIds].sort());
  });

  it('completes an experiment that drained without a finisher noticing (the safety net)', async () => {
    const seed = await seedLifecycle(t.db);
    await t.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: sql`now()` })
      .where(eq(runs.experimentId, seed.experimentId));
    const report = await pass();
    expect(report.completed).toEqual([seed.experimentId]);
    expect((await experimentRow(t.db, seed.experimentId)).status).toBe('completed');
  });

  it('deletes the trial directories of attempts finished before the retention window', async () => {
    const seed = await seedLifecycle(t.db);
    const [done, live] = seed.runIds as [string, string];
    const finished = await claimAttempt(t.db, done, workerId);
    const running = await claimAttempt(t.db, live, workerId);
    for (const id of [finished.attemptId, running.attemptId, 'not-an-attempt']) {
      await mkdir(join(trialsDir, id, 'workspace'), { recursive: true });
    }
    await finishAttempt(t.db, {
      claimed: finished,
      nextSeq: 1,
      outcome: outcomes.error('setup'),
      queue,
      settings: { maxConsecutiveExecutionErrors: 100, autoRetryDelayS: 30 },
    });

    expect((await pass()).removedTrialDirs).toBe(0);
    const retention = { lastRunAt: 0 };
    const report = await pass({
      settings: { trialRetentionDays: 0 },
      now: () => Date.now() + 1000,
      retention,
    });
    expect(report.removedTrialDirs).toBe(1);
    expect((await readdir(trialsDir)).sort()).toEqual([running.attemptId, 'not-an-attempt'].sort());
    // Throttled: a second pass soon after does not scan again.
    expect((await pass({ settings: { trialRetentionDays: 0 }, retention })).removedTrialDirs).toBe(
      0,
    );
  });

  it('deletes a directory the agent locked, and one it cannot delete stops none of the others', async () => {
    const seed = await seedLifecycle(t.db, { repetitions: 2 });
    const ids: string[] = [];
    for (const runId of seed.runIds.slice(0, 3)) {
      const claimed = await claimAttempt(t.db, runId, workerId);
      await finishAttempt(t.db, {
        claimed,
        nextSeq: 1,
        outcome: outcomes.error('setup'),
        queue,
        settings: { maxConsecutiveExecutionErrors: 100, autoRetryDelayS: 30 },
      });
      await mkdir(join(trialsDir, claimed.attemptId, 'workspace', 'x'), { recursive: true });
      ids.push(claimed.attemptId);
    }
    const [locked, poisoned] = ids.sort() as [string, string, string];
    // `mkdir -p x && chmod 500 x` and `chmod 555 /workspace`: plain rm fails on these.
    await writeFile(join(trialsDir, locked, 'workspace', 'x', 'f'), 'f');
    await chmod(join(trialsDir, locked, 'workspace', 'x'), 0o500);
    await chmod(join(trialsDir, locked, 'workspace'), 0o555);
    const logger = memoryLogger();
    const report = await pass({
      settings: { trialRetentionDays: 0 },
      now: () => Date.now() + 1000,
      retention: { lastRunAt: 0 },
      logger,
      removeTrialDir: async (dir, id) => {
        if (id === poisoned) throw Object.assign(new Error('EPERM: immutable'), { code: 'EPERM' });
        await removeTrialDirs(dir, id);
      },
    });
    expect(report.removedTrialDirs).toBe(2);
    expect(await readdir(trialsDir)).toEqual([poisoned]);
    expect(logger.lines).toContainEqual(
      expect.objectContaining({ level: 'warn', obj: { attemptId: poisoned, err: 'EPERM' } }),
    );
  });

  it('skips the pass when another worker holds the lock', async () => {
    expect(() => drizzlePoolRecoveryLock(t.db)).toThrow(/not a node-postgres pool/);
    expect(
      await recoveryPass(deps({ lock: { tryRun: () => Promise.resolve({ ran: false }) } })),
    ).toBeNull();
  });

  it('touches nothing on a quiet database', async () => {
    await seedLifecycle(t.db);
    const report = await pass();
    expect(report).toMatchObject({
      revoked: [],
      finalised: [],
      swept: 0,
      completed: [],
      removedTrialDirs: 0,
    });
    // Queued runs of a running experiment are always re-sent; the exclusive key makes it a no-op in pg-boss.
    expect(report.resentRuns).toBe(2);
    const stillRunning = await t.db
      .select()
      .from(attempts)
      .where(and(eq(attempts.status, 'running')));
    expect(stillRunning).toEqual([]);
  });
});
