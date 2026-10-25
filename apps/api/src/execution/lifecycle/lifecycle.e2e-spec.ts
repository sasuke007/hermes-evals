/**
 * The execution lifecycle on a real Postgres 17 server with real pg-boss,
 * for what PGlite cannot show: workers racing on separate connections, the
 * per-experiment concurrency across workers, leases lost and recovered,
 * cancel, two finishers reconciling at once, the guards, the circuit
 * breaker, the deferJob paths and the automatic retry. The runner is the
 * fake one (testing.support-spec.ts); the trial containers are the fake
 * engine's. Each test gets its own database.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeEngine } from '../../../test/support/fake-engine.js';
import { runMigrations } from '../../database/migrator.js';
import * as schema from '../../database/schema/index.js';
import type { ProviderReadiness } from '../../providers/readiness.js';
import { ensureQueues } from '../../queue/queue.service.js';
import { executeRunKey, QUEUES } from '../../queue/queues.js';
import { finishAttempt } from './finish.js';
import { startExecutionLifecycle, type ExecutionLifecycle } from './lifecycle.js';
import { pgBossLifecycleQueue } from './queue.js';
import { drizzlePoolRecoveryLock, poolRecoveryLock } from './recovery-lock.js';
import { handleExecuteRunJob } from './execute-run.js';
import { LeaseKeeper } from './leases.js';
import { SlotPool } from '../slots.js';
import { LeaseLostError, WorkerShutdownError } from '../contracts.js';
import {
  HERMES_REVISION,
  attemptsOf,
  claimAttempt,
  experimentRow,
  FakeRunner,
  FAST_SETTINGS,
  memoryLogger,
  outcomes,
  PRICED_MODEL,
  runRow,
  seedLifecycle,
  seedWorker,
  sleep,
  textEvent,
  untilAborted,
  waitFor,
} from './testing.support-spec.js';
import type { LifecycleSettings } from './types.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const READY: ProviderReadiness = { ready: true, status: 'configured', reason: null };
const SLOTS = ['trial-0', 'trial-1', 'trial-2', 'trial-3'];

type Db = NodePgDatabase<typeof schema>;

interface WorkerOptions {
  /** Null: a worker that runs recovery but executes nothing. */
  runner: FakeRunner | null;
  name?: string;
  daemonId?: string;
  readiness?: () => Promise<ProviderReadiness>;
  settings?: Partial<LifecycleSettings>;
  engine?: FakeEngine;
  trialSlots?: string[];
}

interface StartedWorker {
  workerId: string;
  engine: FakeEngine;
  lifecycle: ExecutionLifecycle;
}

const admin = async (statement: string) => {
  const client = new pg.Client({ connectionString: SERVER_URL });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
};

let databases = 0;

describe.skipIf(!SERVER_URL)('execution lifecycle on Postgres 17', () => {
  let database: string;
  let url: string;
  let pool: pg.Pool;
  let db: Db;
  let boss: PgBoss;
  let bosses: PgBoss[];
  let lifecycles: ExecutionLifecycle[];
  let trialsDir: string;

  beforeEach(async () => {
    database = `hermes_evals_lifecycle_e2e_${process.pid}_${++databases}`;
    await admin(`drop database if exists ${database}`);
    await admin(`create database ${database}`);
    const target = new URL(SERVER_URL!);
    target.pathname = `/${database}`;
    url = target.toString();
    await runMigrations(url);
    pool = new pg.Pool({ connectionString: url, max: 20 });
    db = drizzle(pool, { schema });
    bosses = [];
    lifecycles = [];
    boss = await newBoss();
    await ensureQueues(boss);
    trialsDir = await mkdtemp(join(tmpdir(), 'hermes-evals-lifecycle-e2e-'));
  });

  afterEach(async () => {
    for (const lifecycle of lifecycles) await lifecycle.stop();
    for (const b of bosses) await b.stop({ graceful: false, timeout: 1000 });
    await pool?.end();
    await admin(`drop database if exists ${database} with (force)`);
    if (trialsDir) await rm(trialsDir, { recursive: true, force: true });
  });

  async function newBoss(): Promise<PgBoss> {
    const instance = new PgBoss({
      connectionString: url,
      schema: 'pgboss',
      supervise: false,
      schedule: false,
    });
    instance.on('error', () => {});
    await instance.start();
    bosses.push(instance);
    return instance;
  }

  /** A worker process: its own workers row, pg-boss instance, daemon and lifecycle. */
  async function startWorker(options: WorkerOptions): Promise<StartedWorker> {
    const name = options.name ?? `worker-${lifecycles.length + 1}`;
    const daemonId = options.daemonId ?? `DAEMON:${name}`;
    const workerId = await seedWorker(db, name);
    const engine = options.engine ?? new FakeEngine({ daemonId });
    const lifecycle = await startExecutionLifecycle({
      boss: await newBoss(),
      db,
      runner: options.runner,
      engine,
      readiness: options.readiness ?? (() => Promise.resolve(READY)),
      workerId,
      hostId: daemonId,
      hermesRevision: HERMES_REVISION,
      trialsDir,
      trialSlots: options.trialSlots ?? SLOTS,
      recoveryLock: poolRecoveryLock(pool),
      logger: memoryLogger(),
      settings: { ...FAST_SETTINGS, ...options.settings },
    });
    lifecycles.push(lifecycle);
    return { workerId, engine, lifecycle };
  }

  /** The launch's jobs: attempt 1 of every run, in one transaction. */
  const sendLaunchJobs = (runIds: readonly string[]) =>
    db.transaction((tx) =>
      pgBossLifecycleQueue(boss).sendMany(
        tx,
        QUEUES.executeRun,
        runIds.map((runId) => ({
          data: { runId, attempt: 1, trigger: 'initial' },
          singletonKey: executeRunKey(runId, 1),
        })),
      ),
    );

  const statuses = async (experimentId: string) =>
    (
      await db
        .select({ status: schema.runs.status })
        .from(schema.runs)
        .where(eq(schema.runs.experimentId, experimentId))
    ).map((r) => r.status);

  const allRuns = (experimentId: string, done: (status: string) => boolean) => async () => {
    const all = await statuses(experimentId);
    return all.every(done) ? all : undefined;
  };

  const attemptCount = async (experimentId: string) =>
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.attempts)
        .innerJoin(schema.runs, eq(schema.runs.id, schema.attempts.runId))
        .where(eq(schema.runs.experimentId, experimentId))
    )[0]!.n;

  const jobsOf = async (key: string) =>
    (
      await pool.query<{ state: string; start_after: Date }>(
        `select state, start_after from pgboss.job where name = $1 and singleton_key = $2 order by created_on`,
        [QUEUES.executeRun, key],
      )
    ).rows;

  it('lets exactly one of two workers claim a run delivered to both', async () => {
    const seed = await seedLifecycle(db, { tasks: 2, repetitions: 2 });
    const handlers = await Promise.all(
      ['a', 'b'].map(async (name) => {
        const workerId = await seedWorker(db, name);
        const leases = new LeaseKeeper(db, workerId, FAST_SETTINGS, memoryLogger());
        return {
          leases,
          deps: {
            db,
            queue: pgBossLifecycleQueue(boss),
            runner: new FakeRunner(async () => {
              await sleep(50);
              return outcomes.executed();
            }),
            slots: new SlotPool(SLOTS, new FakeEngine()),
            leases,
            readiness: () => Promise.resolve(READY),
            workerId,
            hostId: `DAEMON:${name}`,
            hermesRevision: HERMES_REVISION,
            trialsDir,
            settings: FAST_SETTINGS,
            logger: memoryLogger(),
          },
        };
      }),
    );
    for (const runId of seed.runIds) {
      const job = { id: crypto.randomUUID(), data: { runId, attempt: 1, trigger: 'initial' } };
      const results = await Promise.all(handlers.map((h) => handleExecuteRunJob(job, h.deps)));
      expect(results.map((r) => r.outcome).sort((x, y) => x.localeCompare(y))).toEqual([
        'finished',
        'stale',
      ]);
      expect(await attemptsOf(db, runId)).toHaveLength(1);
    }
    expect(await statuses(seed.experimentId)).toEqual(Array(8).fill('executed'));
    for (const h of handlers) await h.leases.stop();
  });

  it('keeps an experiment at concurrency 1 across three workers', async () => {
    const seed = await seedLifecycle(db, { tasks: 2, concurrency: 1 });
    let runningNow = 0;
    let mostAtOnce = 0;
    const runner = new FakeRunner(async ({ plan }) => {
      const [{ n } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.runs)
        .where(
          and(eq(schema.runs.experimentId, plan.experimentId), eq(schema.runs.status, 'running')),
        );
      runningNow += 1;
      mostAtOnce = Math.max(mostAtOnce, runningNow, n);
      await sleep(300);
      runningNow -= 1;
      return outcomes.executed();
    });
    await sendLaunchJobs(seed.runIds);
    await Promise.all([1, 2, 3].map(() => startWorker({ runner })));

    await waitFor(
      allRuns(seed.experimentId, (s) => s === 'executed'),
      45_000,
    );

    expect(mostAtOnce).toBe(1);
    expect(runner.plans).toHaveLength(4);
    expect(await attemptCount(seed.experimentId)).toBe(4);
    const inFlight = await db.select({ n: schema.workers.inFlight }).from(schema.workers);
    expect(inFlight.every((w) => w.n === 0)).toBe(true);
  });

  it('stops a run whose lease is lost, writes nothing more from it, and recovery requeues it', async () => {
    const seed = await seedLifecycle(db, { concurrency: 1 });
    const runId = seed.runIds[0]!;
    let lateWrite: unknown = null;
    const runner = new FakeRunner(async ({ plan, sink, signal }) => {
      if (plan.runId !== runId || plan.attemptNumber > 1) return outcomes.executed();
      await sink.appendEvents([textEvent('working')]);
      try {
        return await untilAborted(signal);
      } catch (err) {
        // What a runner still holding output would try: refused.
        lateWrite = await sink.appendEvents([textEvent('too late')]).catch((e: unknown) => e);
        throw err;
      }
    });
    await sendLaunchJobs([runId]);
    const a = await startWorker({ runner, settings: { heartbeatIntervalMs: 200 } });
    const first = await waitFor(async () => (await attemptsOf(db, runId))[0]);
    await waitFor(async () => (runner.plans.some((p) => p.runId === runId) ? true : undefined));

    // What recovery does to a lease that expired.
    await db
      .update(schema.attempts)
      .set({ leaseExpiresAt: sql`now() - interval '1 second'`, leaseRevokedAt: sql`now()` })
      .where(eq(schema.attempts.id, first.id));
    await waitFor(async () => (runner.running === 0 ? true : undefined));
    expect(lateWrite).toBeInstanceOf(LeaseLostError);

    const report = await a.lifecycle.recoverNow();
    expect(report?.finalised.map((f) => f.attemptId)).toEqual([first.id]);
    await waitFor(async () => ((await runRow(db, runId)).status === 'executed' ? true : undefined));
    const [lost, retried] = await attemptsOf(db, runId);
    expect(lost).toMatchObject({ status: 'execution_error', errorCategory: 'worker_lost' });
    expect(retried).toMatchObject({ number: 2, trigger: 'recovery', status: 'executed' });
    const events = await db
      .select({ seq: schema.runEvents.seq, type: schema.runEvents.type })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.attemptId, first.id))
      .orderBy(schema.runEvents.seq);
    expect(events).toEqual([
      { seq: 1, type: 'text' },
      { seq: 2, type: 'platform' },
    ]);
  });

  it('never revokes the lease of a live worker, whatever recovery runs', async () => {
    const seed = await seedLifecycle(db);
    const runId = seed.runIds[0]!;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const runner = new FakeRunner(async () => {
      await released;
      return outcomes.executed();
    });
    await sendLaunchJobs([runId]);
    // A 1 s lease survives only because the heartbeat renews it every 200 ms.
    await startWorker({ runner, settings: { leaseSeconds: 1, heartbeatIntervalMs: 200 } });
    const other = await startWorker({ runner: null });
    await waitFor(async () => (runner.running === 2 ? true : undefined));

    for (let i = 0; i < 5; i += 1) {
      const report = await other.lifecycle.recoverNow();
      expect(report?.revoked ?? []).toEqual([]);
      await sleep(500);
    }
    const [attempt] = await attemptsOf(db, runId);
    expect(attempt).toMatchObject({ status: 'running', leaseRevokedAt: null });
    release();
    await waitFor(async () => ((await runRow(db, runId)).status === 'executed' ? true : undefined));
    expect(await attemptsOf(db, runId)).toHaveLength(1);
  });

  it('cancels a running attempt through the watcher and completes the experiment once drained', async () => {
    const seed = await seedLifecycle(db, { concurrency: 1 });
    const runner = new FakeRunner(({ signal }) => untilAborted(signal));
    await sendLaunchJobs(seed.runIds);
    await startWorker({ runner });
    await waitFor(async () => (runner.running > 0 ? true : undefined));
    const running = runner.plans[0]!.runId;

    // Cancel as the control does it, in one transaction that locks the experiment first:
    // queued runs end at once, running ones get a cancel request.
    await db.transaction(async (tx) => {
      await tx
        .select({ id: schema.experiments.id })
        .from(schema.experiments)
        .where(eq(schema.experiments.id, seed.experimentId))
        .for('no key update');
      await tx
        .update(schema.experiments)
        .set({ cancelledAt: sql`now()` })
        .where(eq(schema.experiments.id, seed.experimentId));
      await tx
        .update(schema.runs)
        .set({ status: 'cancelled', finishedAt: sql`now()` })
        .where(
          and(eq(schema.runs.experimentId, seed.experimentId), eq(schema.runs.status, 'queued')),
        );
      await tx
        .update(schema.runs)
        .set({ cancelRequestedAt: sql`now()` })
        .where(
          and(eq(schema.runs.experimentId, seed.experimentId), eq(schema.runs.status, 'running')),
        );
    });

    await waitFor(async () =>
      (await experimentRow(db, seed.experimentId)).status === 'completed' ? true : undefined,
    );
    expect(await statuses(seed.experimentId)).toEqual(['cancelled', 'cancelled']);
    expect(await attemptsOf(db, running)).toMatchObject([{ status: 'cancelled' }]);
    expect(runner.plans).toHaveLength(1);
    expect((await experimentRow(db, seed.experimentId)).cancelledAt).not.toBeNull();
  });

  it('completes an experiment once when its last two runs finish at the same moment', async () => {
    const workerId = await seedWorker(db);
    const queue = pgBossLifecycleQueue(boss);
    for (let i = 0; i < 5; i += 1) {
      const seed = await seedLifecycle(db);
      const claimed = await Promise.all(
        seed.runIds.map((runId) => claimAttempt(db, runId, workerId, { queue })),
      );
      const results = await Promise.all(
        claimed.map((c) =>
          finishAttempt(db, {
            claimed: c,
            nextSeq: 1,
            outcome: outcomes.error('setup'),
            queue,
            settings: { maxConsecutiveExecutionErrors: 100, autoRetryDelayS: 30 },
          }),
        ),
      );
      expect(results.map((r) => r.reconciled).sort((x, y) => x.localeCompare(y))).toEqual([
        'completed',
        'unchanged',
      ]);
      const experiment = await experimentRow(db, seed.experimentId);
      expect(experiment.status).toBe('completed');
      expect(experiment.verdictRevision).toBe(experiment.resultsRevision);
    }
  });

  it('pauses at the spend ceiling once the priced spend reaches it', async () => {
    const seed = await seedLifecycle(db, {
      tasks: 2,
      concurrency: 1,
      model: PRICED_MODEL,
      spendCeilingUsd: 1,
    });
    const runner = new FakeRunner(async () => outcomes.executed());
    await sendLaunchJobs(seed.runIds);
    await startWorker({ runner });

    await waitFor(async () => {
      const experiment = await experimentRow(db, seed.experimentId);
      return experiment.status === 'paused' ? experiment : undefined;
    });
    expect((await experimentRow(db, seed.experimentId)).pauseReason).toBe('spend_ceiling');
    await sleep(1500);
    expect(await attemptCount(seed.experimentId)).toBe(1);
    expect((await statuses(seed.experimentId)).filter((s) => s === 'queued')).toHaveLength(3);
  });

  it('fails the experiment at the circuit breaker threshold and starts nothing after it', async () => {
    const seed = await seedLifecycle(db, { tasks: 2, concurrency: 1 });
    const runner = new FakeRunner(async () => outcomes.error('other'));
    await sendLaunchJobs(seed.runIds);
    await startWorker({ runner, settings: { maxConsecutiveExecutionErrors: 3 } });

    const failed = await waitFor(async () => {
      const experiment = await experimentRow(db, seed.experimentId);
      return experiment.status === 'failed' ? experiment : undefined;
    }, 45_000);
    expect(failed.failure).toMatchObject({ threshold: 3, category: 'other' });
    await sleep(1500);
    expect(await attemptCount(seed.experimentId)).toBe(3);
    expect((await statuses(seed.experimentId)).sort((x, y) => x.localeCompare(y))).toEqual([
      'execution_error',
      'execution_error',
      'execution_error',
      'queued',
    ]);
  });

  it('pauses with provider_disconnected spending no attempt, and runs once the provider is back', async () => {
    const seed = await seedLifecycle(db);
    let ready = false;
    const runner = new FakeRunner();
    await sendLaunchJobs(seed.runIds);
    await startWorker({
      runner,
      readiness: () =>
        Promise.resolve(
          ready ? READY : { ready: false, status: 'missing', reason: 'no key in egress' },
        ),
    });
    await waitFor(async () =>
      (await experimentRow(db, seed.experimentId)).pauseReason === 'provider_disconnected'
        ? true
        : undefined,
    );
    await sleep(1000);
    expect(await attemptCount(seed.experimentId)).toBe(0);
    expect(runner.plans).toEqual([]);

    // Resume as the control does: running again, then every queued run re-sent.
    ready = true;
    await db
      .update(schema.experiments)
      .set({ status: 'running', pauseReason: null, pausedAt: null })
      .where(eq(schema.experiments.id, seed.experimentId));
    await sendLaunchJobs(seed.runIds);
    await waitFor(allRuns(seed.experimentId, (s) => s === 'executed'));
    expect(await attemptCount(seed.experimentId)).toBe(2);
  });

  it('defers a job past the concurrency limit and when no slot is free, completing the active job', async () => {
    const seed = await seedLifecycle(db, { concurrency: 1 });
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const runner = new FakeRunner(async () => {
      await released;
      return outcomes.executed();
    });
    await sendLaunchJobs(seed.runIds);
    await startWorker({ runner, settings: { admissionDelayS: { min: 3, max: 3 } } });
    await waitFor(async () => (runner.running > 0 ? true : undefined));
    const waiting = seed.runIds.find((id) => id !== runner.plans[0]!.runId)!;

    const deferred = await waitFor(async () => {
      const jobs = await jobsOf(executeRunKey(waiting, 1));
      return jobs.length >= 2 ? jobs : undefined;
    });
    // Each deferral completed the delivered job and left exactly one waiting copy.
    expect(deferred.slice(0, -1).every((j) => j.state === 'completed')).toBe(true);
    expect(deferred.at(-1)!.state).toBe('created');
    expect(deferred.at(-1)!.start_after.getTime()).toBeGreaterThan(Date.now());
    expect(await attemptsOf(db, waiting)).toEqual([]);
    release();
    await waitFor(
      allRuns(seed.experimentId, (s) => s === 'executed'),
      30_000,
    );

    // A worker whose only slot is taken by a live trial in its engine.
    for (const lifecycle of lifecycles) await lifecycle.stop();
    const other = await seedLifecycle(db);
    const engine = new FakeEngine({ daemonId: 'DAEMON:busy', script: () => ({ hang: true }) });
    const busy = await engine.createContainer('busy', {
      Labels: { 'hermes-evals.role': 'trial' },
      HostConfig: { NetworkMode: 'only-slot' },
    });
    await engine.start(busy);
    const noSlotRunner = new FakeRunner();
    await sendLaunchJobs(other.runIds);
    await startWorker({
      runner: noSlotRunner,
      engine,
      daemonId: 'DAEMON:busy',
      trialSlots: ['only-slot'],
    });
    const noSlot = await waitFor(async () => {
      const jobs = await jobsOf(executeRunKey(other.runIds[0]!, 1));
      return jobs.length >= 2 ? jobs : undefined;
    });
    expect(noSlot[0]!.state).toBe('completed');
    expect(noSlot.at(-1)!.state).toBe('created');
    expect(await attemptCount(other.experimentId)).toBe(0);
    expect(noSlotRunner.plans).toEqual([]);
  });

  it('retries a timeout once automatically, after the delay', async () => {
    const seed = await seedLifecycle(db);
    const runId = seed.runIds[0]!;
    const runner = new FakeRunner(async ({ plan }) =>
      plan.runId === runId && plan.attemptNumber === 1
        ? outcomes.error('timeout')
        : outcomes.executed(),
    );
    await sendLaunchJobs([runId]);
    await startWorker({ runner, settings: { autoRetryDelayS: 2 } });

    await waitFor(async () => ((await runRow(db, runId)).status === 'executed' ? true : undefined));
    const [timedOut, retried] = await attemptsOf(db, runId);
    expect(timedOut).toMatchObject({
      number: 1,
      status: 'execution_error',
      errorCategory: 'timeout',
    });
    expect(retried).toMatchObject({ number: 2, trigger: 'auto_retry', status: 'executed' });
    expect(retried!.startedAt.getTime() - timedOut!.finishedAt!.getTime()).toBeGreaterThanOrEqual(
      1500,
    );
  });

  it('hands back running attempts on shutdown, and recovery requeues them once the worker is marked stopped', async () => {
    const seed = await seedLifecycle(db);
    const runId = seed.runIds[0]!;
    let reason: unknown = null;
    const runner = new FakeRunner(async ({ plan, signal }) => {
      if (plan.runId !== runId || plan.attemptNumber > 1) return outcomes.executed();
      return untilAborted(signal).catch((err: unknown) => {
        reason = err;
        throw err;
      });
    });
    await sendLaunchJobs([runId]);
    const a = await startWorker({ runner });
    await waitFor(async () =>
      (await runRow(db, runId)).status === 'running' && runner.running > 0 ? true : undefined,
    );
    await a.lifecycle.stop();
    expect(reason).toBeInstanceOf(WorkerShutdownError);
    expect(await attemptsOf(db, runId)).toMatchObject([{ status: 'running' }]);

    // Presence marks the row stopped; a worker on the same daemon recovers the attempt.
    await db
      .update(schema.workers)
      .set({ stoppedAt: sql`now()` })
      .where(eq(schema.workers.id, a.workerId));
    await startWorker({ runner, name: 'worker-restarted', daemonId: 'DAEMON:worker-1' });
    await waitFor(async () => ((await runRow(db, runId)).status === 'executed' ? true : undefined));
    expect((await attemptsOf(db, runId)).map((x) => [x.number, x.status, x.errorCategory])).toEqual(
      [
        [1, 'execution_error', 'worker_lost'],
        [2, 'executed', null],
      ],
    );
  });

  it('runs one recovery pass at a time across workers', async () => {
    const lock = drizzlePoolRecoveryLock(db);
    let inside = 0;
    let mostInside = 0;
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        lock.tryRun(async () => {
          inside += 1;
          mostInside = Math.max(mostInside, inside);
          await sleep(300);
          inside -= 1;
          return 'ran';
        }),
      ),
    );
    expect(mostInside).toBe(1);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect((await lock.tryRun(() => Promise.resolve(1))).ran).toBe(true);
    // Every client went back to the pool, unlocked.
    const held = await pool.query(
      `select count(*)::int as n from pg_locks where locktype = 'advisory'`,
    );
    expect(held.rows[0]).toEqual({ n: 0 });
  });

  it('serves the evaluate-run job it sends for an executed run', async () => {
    const seed = await seedLifecycle(db);
    await sendLaunchJobs([seed.runIds[0]!]);
    await startWorker({ runner: new FakeRunner() });
    await waitFor(async () =>
      (await runRow(db, seed.runIds[0]!)).status === 'executed' ? true : undefined,
    );
    const [evaluation] = await db
      .select()
      .from(schema.evaluations)
      .where(inArray(schema.evaluations.runId, [seed.runIds[0]!]));
    const jobs = await pool.query<{ state: string }>(
      `select state from pgboss.job where name = $1 and singleton_key = $2`,
      [QUEUES.evaluateRun, evaluation!.id],
    );
    expect(jobs.rows).toEqual([{ state: 'created' }]);
  });
});
