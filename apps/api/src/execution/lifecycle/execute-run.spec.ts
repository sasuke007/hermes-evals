/**
 * The execute-run handler on PGlite with a fake runner, the real slot pool
 * over the fake engine and the real lease keeper: the plan it hands the
 * runner, every way it puts a job back without an attempt, the MCP refusal,
 * hand-backs, cancel, and a finish that is retried or reduced.
 */
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { FakeEngine } from '../../../test/support/fake-engine.js';
import { artifacts, attempts, runs } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { FakeNousLogin } from '../../providers/fake-nous-login.support-spec.js';
import { NousLoginClient } from '../../providers/nous-login.client.js';
import {
  nousReadinessDeps,
  providerReadiness,
  type ProviderReadiness,
} from '../../providers/readiness.js';
import { SlotPool } from '../slots.js';
import { handleExecuteRunJob, type ExecuteRunDeps } from './execute-run.js';
import { LeaseKeeper } from './leases.js';
import {
  HERMES_REVISION,
  attemptsOf,
  experimentRow,
  FakeRunner,
  FAST_SETTINGS,
  memoryLogger,
  outcomes,
  RecordingQueue,
  runRow,
  seedLifecycle,
  seedStdioMcpServer,
  seedWorker,
  textEvent,
  untilAborted,
  workerInFlight,
} from './testing.support-spec.js';

const TRIALS = '/trials';
const READY: ProviderReadiness = { ready: true, status: 'configured', reason: null };

describe('handleExecuteRunJob', () => {
  let t: TestDatabase;
  let queue: RecordingQueue;
  let engine: FakeEngine;
  let workerId: string;
  let leases: LeaseKeeper;
  let slots: SlotPool;

  beforeEach(async () => {
    t = await createTestDatabase();
    queue = new RecordingQueue();
    engine = new FakeEngine({ script: () => ({ hang: true }) });
    workerId = await seedWorker(t.db);
    leases = new LeaseKeeper(t.db, workerId, FAST_SETTINGS, memoryLogger());
    slots = new SlotPool(['trial-0', 'trial-1'], engine);
  });
  afterEach(async () => {
    await leases.stop();
    await t.close();
  });

  const deps = (runner: FakeRunner, extra: Partial<ExecuteRunDeps> = {}): ExecuteRunDeps => ({
    db: t.db,
    queue,
    runner,
    slots,
    leases,
    readiness: () => Promise.resolve(READY),
    workerId,
    hostId: 'FAKE:DAEMON',
    hermesRevision: HERMES_REVISION,
    trialsDir: TRIALS,
    settings: FAST_SETTINGS,
    logger: memoryLogger(),
    newToken: () => 'attempt-token',
    sleep: () => Promise.resolve(),
    ...extra,
  });
  const job = (runId: string, attempt = 1) => ({
    id: `job-${runId}-${attempt}`,
    data: { runId, attempt, trigger: attempt === 1 ? 'initial' : 'user_retry' },
  });

  it('claims, hands the runner the plan from the rows, finishes, and frees the slot and lease', async () => {
    const seed = await seedLifecycle(t.db, { timeBudgetOverrideS: 60 });
    const runId = seed.runIds[0]!;
    const runner = new FakeRunner(async ({ sink, signal }) => {
      expect(signal.aborted).toBe(false);
      expect(slots.busy).toBe(1);
      expect(leases.count).toBe(1);
      await sink.appendEvents([textEvent('working')]);
      return outcomes.executed();
    });

    const result = await handleExecuteRunJob(job(runId), deps(runner));

    expect(result).toMatchObject({
      outcome: 'finished',
      attemptStatus: 'executed',
      runStatus: 'executed',
    });
    const [plan] = runner.plans;
    const [attempt] = await attemptsOf(t.db, runId);
    expect(plan).toMatchObject({
      experimentId: seed.experimentId,
      runId,
      attemptId: attempt!.id,
      attemptNumber: 1,
      token: 'attempt-token',
      slot: 'trial-0',
      paths: {
        root: join(TRIALS, attempt!.id),
        home: join(TRIALS, attempt!.id, 'home'),
        workspace: join(TRIALS, attempt!.id, 'workspace'),
      },
      task: { id: seed.taskIds[0], key: 'task_1', fixtures: [{ path: 'invoices.csv' }] },
      limits: { maxTurns: 20, runBudgetS: 60 },
      configuration: {
        versionId: seed.baselineVersionId,
        model: 'mock/scripted',
        provider: 'custom',
        baseUrl: 'http://mock-model:8090/v1',
        toolsets: ['file', 'terminal'],
        skills: [],
        documents: [],
        mcpServers: [],
      },
      hermes: { version: '0.22.4' },
    });
    expect(plan!.task.prompt).toMatch(/Total the invoices/);
    expect(slots.busy).toBe(0);
    expect(leases.count).toBe(0);
    expect(await workerInFlight(t.db, workerId)).toBe(0);
    expect(queue.of('send', 'evaluate-run')).toHaveLength(1);
  });

  it('ends the attempt as setup without a container when an MCP definition names a reserved variable', async () => {
    const mcp = await seedStdioMcpServer(t.db, 'invoice-db', ['HERMES_EVALS_ATTEMPT_TOKEN']);
    const seed = await seedLifecycle(t.db, { candidateMcpServerVersionIds: [mcp] });
    const candidateRun = seed.runIds[1]!;
    const runner = new FakeRunner();

    const result = await handleExecuteRunJob(job(candidateRun), deps(runner));

    expect(result).toMatchObject({
      outcome: 'finished',
      attemptStatus: 'execution_error',
      runStatus: 'execution_error',
    });
    expect(runner.plans).toEqual([]);
    expect(engine.containers).toEqual([]);
    const [attempt] = await attemptsOf(t.db, candidateRun);
    expect(attempt).toMatchObject({ errorCategory: 'setup', sandboxId: null });
    expect(attempt!.errorMessage).toMatch(/MCP server invoice-db: .*HERMES_EVALS_ATTEMPT_TOKEN/);
  });

  it('puts the job back without an attempt when no slot is free, readiness cannot be read, or the worker is stopping', async () => {
    const seed = await seedLifecycle(t.db, { repetitions: 2 });
    const [a, b, c] = seed.runIds as [string, string, string];
    const runner = new FakeRunner();

    for (const slot of ['trial-0', 'trial-1']) {
      const id = await engine.createContainer(`busy-${slot}`, {
        Labels: { 'hermes-evals.role': 'trial' },
        HostConfig: { NetworkMode: slot },
      });
      await engine.start(id);
    }
    expect(await handleExecuteRunJob(job(a), deps(runner))).toEqual({
      outcome: 'deferred',
      reason: 'no_slot',
      startAfterSeconds: 1,
    });
    const failing = deps(runner, {
      readiness: () => Promise.reject(new Error('nous-login timed out')),
    });
    expect(await handleExecuteRunJob(job(b), failing)).toMatchObject({
      outcome: 'deferred',
      reason: 'readiness_unknown',
    });
    expect(await handleExecuteRunJob(job(c), deps(runner, { stopping: () => true }))).toMatchObject(
      {
        outcome: 'deferred',
        reason: 'stopping',
      },
    );
    expect(queue.of('defer').map((call) => call.singletonKey)).toEqual([
      `${a}:1`,
      `${b}:1`,
      `${c}:1`,
    ]);
    for (const runId of [a, b, c])
      expect(await runRow(t.db, runId)).toMatchObject({ status: 'queued', attemptCount: 0 });
    expect(runner.plans).toEqual([]);
    expect(slots.busy).toBe(0);
  });

  it("defers, and never pauses, when the guard's own egress or nous-login cannot answer", async () => {
    const seed = await seedLifecycle(t.db);
    const [a, b] = seed.runIds as [string, string];
    const runner = new FakeRunner();
    // The worker's guard as WorkerService wires it: live egress names for a key provider.
    const egressDown = deps(runner, {
      readiness: () =>
        providerReadiness(t.db, 'openrouter', {
          nousStatus: () => Promise.resolve('connected'),
          egressEnvNames: () => Promise.reject(new Error('egress GET /env-names timed out')),
        }),
    });
    expect(await handleExecuteRunJob(job(a), egressDown)).toMatchObject({
      outcome: 'deferred',
      reason: 'readiness_unknown',
    });
    // nous-login restarting: unreachable is unknown, not disconnected.
    const closed = await new FakeNousLogin().listen();
    const url = closed.url;
    await closed.close();
    const nousDown = deps(runner, {
      readiness: () =>
        providerReadiness(
          t.db,
          'nous',
          nousReadinessDeps(
            new NousLoginClient(url, { statusMs: 300, startMs: 300, changeMs: 300 }),
          ),
        ),
    });
    expect(await handleExecuteRunJob(job(b), nousDown)).toMatchObject({
      outcome: 'deferred',
      reason: 'readiness_unknown',
    });
    expect((await experimentRow(t.db, seed.experimentId)).status).toBe('running');
    expect(runner.plans).toEqual([]);
  });

  it('leaves a run of an experiment frozen on another Hermes revision, before a slot or readiness', async () => {
    const seed = await seedLifecycle(t.db);
    const runner = new FakeRunner();
    let asked = 0;
    const other = deps(runner, {
      hermesRevision: 'f'.repeat(40),
      readiness: () => {
        asked += 1;
        return Promise.resolve(READY);
      },
    });
    expect(await handleExecuteRunJob(job(seed.runIds[0]!), other)).toMatchObject({
      outcome: 'deferred',
      reason: 'hermes_revision',
    });
    expect(asked).toBe(0);
    expect(slots.busy).toBe(0);
    expect(await attemptsOf(t.db, seed.runIds[0]!)).toEqual([]);
  });

  it('gives every run the override when it is longer than the configuration budget', async () => {
    const seed = await seedLifecycle(t.db, { timeBudgetS: 300, timeBudgetOverrideS: 900 });
    const runner = new FakeRunner();
    await handleExecuteRunJob(job(seed.runIds[0]!), deps(runner));
    expect(runner.plans[0]!.limits.runBudgetS).toBe(900);
  });

  it('pauses on an unready provider and completes stale or malformed jobs, all without an attempt', async () => {
    const seed = await seedLifecycle(t.db);
    const [a, b] = seed.runIds as [string, string];
    const runner = new FakeRunner();
    const notReady = deps(runner, {
      readiness: () => Promise.resolve({ ready: false, status: 'missing', reason: 'no key' }),
    });
    expect(await handleExecuteRunJob(job(a), notReady)).toEqual({
      outcome: 'paused',
      reason: 'provider_disconnected',
      message: 'no key',
    });
    expect(await handleExecuteRunJob(job(b), deps(runner))).toEqual({
      outcome: 'stale',
      reason: 'the experiment is paused',
    });
    expect(await handleExecuteRunJob({ id: 'j', data: { runId: a } }, deps(runner))).toEqual({
      outcome: 'stale',
      reason: 'the job does not parse',
    });
    expect(await t.db.select().from(attempts)).toEqual([]);
    expect(slots.busy).toBe(0);
  });

  it('hands back without writing when the lease is lost mid-run', async () => {
    const seed = await seedLifecycle(t.db);
    const runId = seed.runIds[0]!;
    const runner = new FakeRunner(async ({ plan, sink }) => {
      await sink.appendEvents([textEvent('before')]);
      await t.db
        .update(attempts)
        .set({ leaseRevokedAt: sql`now()` })
        .where(eq(attempts.id, plan.attemptId));
      await sink.appendEvents([textEvent('after')]);
      return outcomes.executed();
    });

    const result = await handleExecuteRunJob(job(runId), deps(runner));

    const [attempt] = await attemptsOf(t.db, runId);
    expect(result).toEqual({
      outcome: 'handed_back',
      attemptId: attempt!.id,
      reason: 'lease_lost',
    });
    expect(attempt!.status).toBe('running');
    expect(await runRow(t.db, runId)).toMatchObject({ status: 'running' });
    expect(slots.busy).toBe(0);
    expect(leases.count).toBe(0);
  });

  it('stops the attempt as cancelled when the cancel watcher sees the request', async () => {
    const seed = await seedLifecycle(t.db);
    const runId = seed.runIds[0]!;
    const runner = new FakeRunner(async ({ signal }) => {
      await t.db
        .update(runs)
        .set({ cancelRequestedAt: sql`now()` })
        .where(eq(runs.id, runId));
      await leases.pollCancels();
      return untilAborted(signal);
    });

    const result = await handleExecuteRunJob(job(runId), deps(runner));

    expect(result).toMatchObject({
      outcome: 'finished',
      attemptStatus: 'cancelled',
      runStatus: 'cancelled',
    });
  });

  it('tries the finish again after a transient error, and reduces an outcome the database refuses', async () => {
    const seed = await seedLifecycle(t.db);
    const [a, b] = seed.runIds as [string, string];
    let transactions = 0;
    // The second transaction (the finish) fails once, as a dropped connection would.
    const flaky = new Proxy(t.db, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return (...args: Parameters<AppDb['transaction']>) => {
            transactions += 1;
            if (transactions === 2)
              return Promise.reject(new Error('Connection terminated unexpectedly'));
            return target.transaction(...args);
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const retried = await handleExecuteRunJob(job(a), deps(new FakeRunner(), { db: flaky }));
    expect(retried).toMatchObject({ outcome: 'finished', attemptStatus: 'executed' });
    expect(transactions).toBe(3);

    const refused = new FakeRunner(async () =>
      outcomes.executed({
        artifacts: [
          {
            root: 'workspace',
            path: '../outside',
            origin: 'agent',
            size: 1,
            sha256: null,
            skippedReason: 'too_large',
          },
        ],
      }),
    );
    const reduced = await handleExecuteRunJob(job(b), deps(refused));
    expect(reduced).toMatchObject({
      outcome: 'finished',
      attemptStatus: 'execution_error',
      runStatus: 'execution_error',
    });
    const [attempt] = await attemptsOf(t.db, b);
    expect(attempt).toMatchObject({ errorCategory: 'other', tokens: { input: 1000 } });
    expect(attempt!.errorMessage).toMatch(/could not be stored/);
    expect(await t.db.select().from(artifacts).where(eq(artifacts.attemptId, attempt!.id))).toEqual(
      [],
    );
  });
});
