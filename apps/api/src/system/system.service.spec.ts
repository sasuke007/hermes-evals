/**
 * The System queries on a real (PGlite) database with the 0001 triggers: the
 * running summary over experiments and runs, which workers are listed and
 * online, and which worker's self-test is shown.
 */
import { HttpException } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  HERMES_REVISION,
  SandboxStatusSchema,
  SystemSummarySchema,
  WorkerSchema,
} from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import {
  finishAttempt,
  runningClaim,
  seedExperiment,
  startAttempt,
} from '../../test/support/seed.js';
import { evaluations, experiments, runs, scores, workers } from '../database/schema/index.js';
import type { WorkerSandbox } from '../database/schema/worker-sandbox.js';
import { SystemService } from './system.service.js';

// PGlite databases are slow to create when every test file runs at once.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let t: TestDatabase;
let service: SystemService;

beforeEach(async () => {
  t = await createTestDatabase();
  service = new SystemService(t.db);
});

afterEach(async () => {
  await t.close();
});

const ago = (ms: number) => new Date(Date.now() - ms);

const SANDBOX: WorkerSandbox = {
  state: 'isolated',
  checks: [{ id: 'no-default-route', name: 'has no default route', passed: true, detail: 'none' }],
  checked_at: '2026-10-24T09:00:00.000Z',
  image: 'hermes-evals/trial:v0.22.4-4d04303',
  revision: HERMES_REVISION,
  image_digest: `sha256:${'7'.repeat(64)}`,
  trigger: 'worker start',
};

const addWorker = async (hostname: string, row: Partial<typeof workers.$inferInsert> = {}) => {
  const [inserted] = await t.db
    .insert(workers)
    .values({
      hostname,
      concurrency: 3,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      ...row,
    })
    .returning();
  return inserted!;
};

/** Takes a queued run through execution and an initial evaluation to scored, as the worker will. */
async function scoreRun(runId: string, workerId: string): Promise<void> {
  const attemptId = await startAttempt(t.db, runId, workerId);
  await finishAttempt(t.db, runId, attemptId);
  const [evaluation] = await t.db
    .insert(evaluations)
    .values({ runId, attemptId, cause: 'initial', generation: 1 })
    .returning();
  await t.db.update(runs).set({ status: 'scoring' }).where(eq(runs.id, runId));
  await t.db.update(evaluations).set(runningClaim()).where(eq(evaluations.id, evaluation!.id));
  await t.db.transaction(async (tx) => {
    await tx.insert(scores).values({
      evaluationId: evaluation!.id,
      key: 'answer',
      type: 'json_match',
      status: 'passed',
      isPrimary: true,
      score: 1,
      comment: 'matches',
      scorerVersion: 1,
    });
    await tx
      .update(evaluations)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(evaluations.id, evaluation!.id));
    await tx
      .update(runs)
      .set({ status: 'scored', finishedAt: new Date() })
      .where(eq(runs.id, runId));
  });
}

describe('summary', () => {
  it('is all zeros on an empty database', async () => {
    const summary = await service.summary();
    expect(summary).toEqual({
      running: { count: 0, scored: 0, total: 0, experiments: [] },
      workers: [],
      queuedRuns: 0,
    });
    SystemSummarySchema.parse(summary);
  });

  it('counts scored of total runs per running experiment, and the queued runs', async () => {
    const s = await seedExperiment(t.db);
    await scoreRun(s.runs[0]!.id, s.worker.id);
    const summary = await service.summary();
    expect(summary.running).toEqual({
      count: 1,
      scored: 1,
      total: 4,
      experiments: [{ id: s.experiment.id, name: 'Skill vs no skill', scored: 1, total: 4 }],
    });
    expect(summary.queuedRuns).toBe(3);
    expect(summary.workers.map((w) => w.id)).toEqual([s.worker.id]);
    SystemSummarySchema.parse(summary);

    // A paused experiment is not running, and its queued runs wait for Resume, not a worker.
    await t.db
      .update(experiments)
      .set({ status: 'paused', pauseReason: 'user', pausedAt: new Date() })
      .where(eq(experiments.id, s.experiment.id));
    const paused = await service.summary();
    expect(paused.running.count).toBe(0);
    expect(paused.queuedRuns).toBe(0);
  });

  it('does not count a cancelled run as scored', async () => {
    const s = await seedExperiment(t.db);
    await t.db
      .update(runs)
      .set({ status: 'cancelled', finishedAt: new Date() })
      .where(and(eq(runs.experimentId, s.experiment.id), eq(runs.id, s.runs[1]!.id)));
    const summary = await service.summary();
    expect(summary.running).toMatchObject({ scored: 0, total: 4 });
    expect(summary.queuedRuns).toBe(3);
  });
});

describe('workers', () => {
  it('lists live and recently lost workers, newest start first, online by heartbeat', async () => {
    const live = await addWorker('live', { startedAt: ago(60_000), lastHeartbeatAt: ago(3_000) });
    const lost = await addWorker('lost', {
      startedAt: ago(30 * 60_000),
      lastHeartbeatAt: ago(5 * 60_000),
    });
    await addWorker('stopped', {
      startedAt: ago(10 * 60_000),
      lastHeartbeatAt: ago(2 * 60_000),
      stoppedAt: ago(2 * 60_000),
    });
    await addWorker('long-gone', {
      startedAt: ago(3 * 3600_000),
      lastHeartbeatAt: ago(2 * 3600_000),
    });
    const list = await service.workers();
    expect(list.map((w) => [w.id, w.status])).toEqual([
      [live.id, 'online'],
      [lost.id, 'offline'],
    ]);
    for (const worker of list) WorkerSchema.parse(worker);
  });

  it('reports the trials each worker runs at once: WORKER_CONCURRENCY capped at its slots', async () => {
    const capped = await addWorker('capped', { concurrency: 6, slots: 4 });
    const older = await addWorker('older', { startedAt: ago(60_000), concurrency: 6, slots: null });
    const list = WorkerSchema.array().parse(await service.workers());
    expect(list.map((w) => [w.id, w.concurrency, w.effectiveConcurrency, w.slotsTotal])).toEqual([
      [capped.id, 6, 4, 4],
      [older.id, 6, 6, null],
    ]);
  });

  it('shows the last worker seen, offline, when none is listed', async () => {
    await addWorker('older', { startedAt: ago(5 * 3600_000), lastHeartbeatAt: ago(4 * 3600_000) });
    const last = await addWorker('stopped', {
      startedAt: ago(20 * 60_000),
      lastHeartbeatAt: ago(10 * 60_000),
      stoppedAt: ago(10 * 60_000),
    });
    const list = await service.workers();
    expect(list).toEqual([
      expect.objectContaining({ id: last.id, status: 'offline', sandboxProven: false }),
    ]);
  });

  it('marks a worker that stopped, or went silent for 60 s, offline', async () => {
    await addWorker('silent', { lastHeartbeatAt: ago(61_000) });
    expect((await service.workers())[0]!.status).toBe('offline');
  });

  it('proves the sandbox only for an isolated report', async () => {
    await addWorker('isolated', { sandbox: SANDBOX, startedAt: ago(2_000) });
    await addWorker('failed', { sandbox: { ...SANDBOX, state: 'failed' }, startedAt: ago(1_000) });
    const list = await service.workers();
    expect(list.map((w) => w.sandboxProven)).toEqual([false, true]);
  });
});

describe('sandbox', () => {
  const rejection = async (promise: Promise<unknown>) => {
    const err = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpException);
    return {
      status: (err as HttpException).getStatus(),
      body: (err as HttpException).getResponse(),
    };
  };

  it('is 404 with a clear message when no worker is live', async () => {
    await addWorker('offline', { lastHeartbeatAt: ago(120_000), sandbox: SANDBOX });
    const { status, body } = await rejection(service.sandbox());
    expect(status).toBe(404);
    expect(body).toEqual({
      statusCode: 404,
      message: expect.stringMatching(/^No worker is connected.*docker compose up -d worker$/),
    });
  });

  it('is 404 when the live worker has not reported a self-test', async () => {
    await addWorker('starting');
    const { status, body } = await rejection(service.sandbox());
    expect(status).toBe(404);
    expect(body).toMatchObject({ message: expect.stringMatching(/has not reported/) });
  });

  it("shows the newest live worker's report", async () => {
    await addWorker('older', { startedAt: ago(600_000), sandbox: { ...SANDBOX, state: 'failed' } });
    await addWorker('newer', { startedAt: ago(1_000), sandbox: SANDBOX });
    const status = await service.sandbox();
    expect(status).toEqual({
      proven: true,
      checks: SANDBOX.checks,
      checkedAt: SANDBOX.checked_at,
      trigger: 'worker start',
      revision: 'hermes-agent v0.22.4 @ 4d04303',
      image: 'hermes-evals/trial:v0.22.4-4d04303',
      digest: SANDBOX.image_digest,
      selftestCommand: 'docker compose run --rm --no-deps worker node dist/sandbox-cli.js selftest',
    });
    SandboxStatusSchema.parse(status);
  });
});
