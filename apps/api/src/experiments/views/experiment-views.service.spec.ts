/**
 * GET /experiments and GET /experiments/:id over PGlite with the real
 * migrations and triggers: a small matrix whose every figure is worked out
 * by hand below, then an experiment in each state (running, paused for each
 * reason, failed by the breaker, completed, cancelled), unpriced models and
 * a suite directory that moved on. Every answer parses with its shared schema.
 */
import { eq } from 'drizzle-orm';
import {
  ExperimentDetailSchema,
  ExperimentListRowSchema,
  type ExperimentDetail,
} from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { experiments, suiteSources, suites, workers } from '../../database/schema/index.js';
import { ExperimentViewsService } from './experiment-views.service.js';
import {
  at,
  cancelled,
  complete,
  errored,
  fail,
  insertTask,
  launch,
  pause,
  REVISION,
  scored,
  seedMatrix,
  seedWorld,
  sha,
  start,
  T0,
} from './seed.support-spec.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let t: TestDatabase;
let views: ExperimentViewsService;

beforeEach(async () => {
  t = await createTestDatabase();
  views = new ExperimentViewsService(t.db);
});

afterEach(async () => {
  await t.close();
});

const detail = async (id: string, now: Date): Promise<ExperimentDetail> =>
  ExperimentDetailSchema.parse(await views.detail(id, now));

const listRow = async (id: string) => {
  const rows = ExperimentListRowSchema.array().parse(await views.list());
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error(`no list row ${id}`);
  return row;
};

describe('the hand-checked matrix', () => {
  it('GET /experiments/:id: every figure', async () => {
    const w = await seedWorld(t.db);
    const { experiment, run } = await seedMatrix(t.db, w);
    const d = await detail(experiment.id, at(100));

    expect(d).toMatchObject({
      status: 'running',
      pauseReason: null,
      pausedAt: null,
      description: '',
      createdAt: T0.toISOString(),
      finishedAt: null,
      elapsedS: 100,
      // Median of the finished attempts (5, 10, 20, 30, 40) is 20 s; 3 runs wait at
      // concurrency 2: 2 waves.
      remainingEstimateS: 40,
      lastEventAt: at(60).toISOString(),
      hermes: { package: 'hermes-agent', version: 'v0.22.4', revision: REVISION },
      scoreKey: 'primary',
      repetitions: 2,
      concurrency: 2,
      timeBudgetOverrideS: null,
      totalRuns: 8,
      verdicts: [],
      failure: null,
    });
    expect(d.counts).toEqual({
      queued: 2,
      running: 1,
      executed: 0,
      scoring: 0,
      scored: 4,
      execution_error: 1,
      cancelled: 0,
    });
    // Spent 0.01 + 0.02 + 0.03 + 0.04. Left: the running baseline run at its mean
    // (0.03 / 2) plus two queued candidate runs at theirs (0.07 / 2 each).
    expect(d.spend).toEqual({
      spentUsd: 0.1,
      ceilingUsd: 5,
      projectedTotalUsd: 0.185,
      remainingEstimateUsd: 0.085,
      unpricedAttempts: 0,
    });
    expect(d.baseline).toMatchObject({ name: 'baseline', role: 'baseline', version: 1 });
    expect(d.candidates).toEqual([
      expect.objectContaining({ name: 'with-mcp', role: 'candidate', provider: 'nous' }),
    ]);
    expect(d.perConfiguration).toEqual([
      expect.objectContaining({
        total: 4,
        counts: expect.objectContaining({ running: 1, scored: 2, execution_error: 1, queued: 0 }),
        passed: 1,
        provisionalPassRate: 0.5,
      }),
      expect.objectContaining({
        total: 4,
        counts: expect.objectContaining({ queued: 2, scored: 2 }),
        passed: 1,
        provisionalPassRate: 0.5,
      }),
    ]);
    expect(d.aggregates.map(({ configuration, ...rest }) => [configuration.name, rest])).toEqual([
      [
        'baseline',
        {
          runs: 4,
          // Counted: two scored and the execution error; one passed.
          passRate: 0.333,
          meanScore: 0.333,
          medianDurationS: 10,
          meanTokens: 1500,
          costUsd: 0.03,
          executionErrors: 1,
          executionErrorCategories: ['provider'],
          ungradable: 0,
        },
      ],
      [
        'with-mcp',
        {
          runs: 4,
          passRate: 0.5,
          // The ungradable run scores nothing.
          meanScore: 0.5,
          medianDurationS: 35,
          meanTokens: 3500,
          costUsd: 0.07,
          executionErrors: 0,
          executionErrorCategories: [],
          ungradable: 1,
        },
      ],
    ]);
    expect(d.feed.map((f) => [f.runId, f.result, f.durationS, f.finishedAt])).toEqual([
      [run('a/cand/2'), 'ungradable', 40, at(50).toISOString()],
      [run('a/cand/1'), 'passed', 30, at(30).toISOString()],
      [run('a/base/2'), 'failed', 20, at(25).toISOString()],
      [run('b/base/1'), 'execution_error', 5, at(15).toISOString()],
      [run('a/base/1'), 'passed', 10, at(10).toISOString()],
    ]);
    expect(d.feed[0]).toMatchObject({
      taskKey: 'total_due',
      configuration: 'with-mcp',
      repetition: 2,
    });
    expect(d.suite).toMatchObject({
      suiteId: w.suiteId,
      name: 'invoices-v1',
      path: './suites/invoices-v1',
      taskCount: 2,
      tasks: [
        { key: 'total_due', version: 1 },
        { key: 'dup_invoices', version: 1 },
      ],
      newerVersion: null,
    });
    expect(d.differences).toEqual([
      {
        field: 'mcp_servers',
        candidate: 'with-mcp',
        baselineValue: '—',
        candidateValue: 'invoice-db (stdio)',
        hash: sha('invoice-db v1'),
      },
      {
        field: 'max_turns',
        candidate: 'with-mcp',
        baselineValue: '20',
        candidateValue: '21',
        hash: null,
      },
    ]);
    expect(d.worker).toMatchObject({ connected: true, workerLostRuns: 0 });
    expect(d.worker.lastHeartbeatAt).not.toBeNull();
  });

  it('GET /experiments: the same numbers on the list row', async () => {
    const w = await seedWorld(t.db);
    const { experiment } = await seedMatrix(t.db, w);
    const row = await listRow(experiment.id);
    expect(row).toMatchObject({
      name: 'MCP vs baseline',
      status: 'running',
      pauseReason: null,
      statusReason: null,
      repetitions: 2,
      totalRuns: 8,
      doneRuns: 4,
      verdicts: [],
      createdAt: T0.toISOString(),
      costUsd: 0.1,
      suite: expect.objectContaining({ suiteId: w.suiteId, versionNumber: 1 }),
      baseline: expect.objectContaining({ versionId: w.baselineVersionId }),
      candidates: [expect.objectContaining({ versionId: w.candidateVersionId })],
    });
    expect(row.counts).toMatchObject({ queued: 2, running: 1, scored: 4, execution_error: 1 });
  });

  it('answers 404 for an unknown experiment', async () => {
    await expect(views.detail('01NOPE')).rejects.toMatchObject({
      status: 404,
      response: { statusCode: 404, message: 'Experiment 01NOPE does not exist.' },
    });
  });
});

describe('an experiment in every state', () => {
  it('lists newest first with the status reason and done runs of each', async () => {
    const w = await seedWorld(t.db);
    const fresh = await launch(t.db, w, { name: 'fresh', createdAt: at(0) });
    const byUser = await launch(t.db, w, { name: 'by user', createdAt: at(1) });
    await pause(t.db, byUser.experiment.id, 'user', at(51));
    const bySpend = await launch(t.db, w, { name: 'by spend', createdAt: at(2) });
    await pause(t.db, bySpend.experiment.id, 'spend_ceiling', at(60));
    const byProvider = await launch(t.db, w, { name: 'by provider', createdAt: at(3) });
    await errored(t.db, w, byProvider.run('b/base/1'), {
      startedAt: at(4),
      durationS: 3,
      category: 'worker_lost',
    });
    await pause(t.db, byProvider.experiment.id, 'provider_disconnected', at(70));

    const broken = await launch(t.db, w, { name: 'broken', createdAt: at(4) });
    const stderr = 'Error: INVOICE_DB_URL is not set\n    at connect (invoice-db.js:3)';
    await errored(t.db, w, broken.run('a/cand/1'), {
      startedAt: at(5),
      durationS: 2,
      category: 'setup',
      message: 'invoice-db failed to start',
      stderrTail: `\n${stderr}`,
    });
    await errored(t.db, w, broken.run('b/cand/1'), {
      startedAt: at(5),
      durationS: 2,
      category: 'setup',
      message: 'invoice-db failed to start',
      stderrTail: 'Traceback: something else',
    });
    const tripping = await errored(t.db, w, broken.run('a/cand/2'), {
      startedAt: at(6),
      durationS: 2,
      category: 'setup',
      message: 'invoice-db failed to start',
      stderrTail: stderr,
    });
    await fail(t.db, broken.experiment.id, {
      at: at(9).toISOString(),
      threshold: 3,
      category: 'setup',
      exit_code: 1,
      message: 'invoice-db failed to start',
      stderr_first_line: 'Error: INVOICE_DB_URL is not set',
      attempt_id: tripping,
      run_id: broken.run('a/cand/2'),
    });

    const done = await launch(t.db, w, { name: 'done', createdAt: at(5) });
    for (const key of ['a/base/1', 'a/base/2', 'b/base/1', 'b/base/2']) {
      await scored(t.db, w, done.run(key), { startedAt: at(10), durationS: 10, status: 'passed' });
    }
    for (const key of ['a/cand/1', 'a/cand/2', 'b/cand/1', 'b/cand/2']) {
      await scored(t.db, w, done.run(key), { startedAt: at(10), durationS: 20, status: 'failed' });
    }
    await complete(t.db, done.experiment.id, at(40));

    const stopped = await launch(t.db, w, { name: 'stopped', createdAt: at(6) });
    await scored(t.db, w, stopped.run('a/base/1'), {
      startedAt: at(10),
      durationS: 5,
      status: 'passed',
    });
    await scored(t.db, w, stopped.run('a/cand/1'), {
      startedAt: at(10),
      durationS: 5,
      status: 'passed',
    });
    for (const key of ['a/base/2', 'b/base/1', 'b/base/2', 'a/cand/2', 'b/cand/1', 'b/cand/2']) {
      await cancelled(t.db, stopped.run(key), at(20));
    }
    await complete(t.db, stopped.experiment.id, at(20), at(19));

    // Cancel pressed while a run is in flight: still running until it drains.
    const draining = await launch(t.db, w, { name: 'draining', createdAt: at(7) });
    await start(t.db, w, draining.run('a/base/1'), at(8));
    for (const key of [
      'a/base/2',
      'b/base/1',
      'b/base/2',
      'a/cand/1',
      'a/cand/2',
      'b/cand/1',
      'b/cand/2',
    ]) {
      await cancelled(t.db, draining.run(key), at(9));
    }
    await t.db
      .update(experiments)
      .set({ cancelledAt: at(9) })
      .where(eq(experiments.id, draining.experiment.id));

    const rows = ExperimentListRowSchema.array().parse(await views.list());
    expect(rows.map((r) => [r.name, r.status, r.pauseReason, r.statusReason, r.doneRuns])).toEqual([
      ['draining', 'running', null, 'Cancelling: in-flight runs are finishing', 0],
      // A finished experiment's bar is full: its cancelled runs are settled too.
      ['stopped', 'completed', null, 'Cancelled: 6 of 8 runs cancelled', 8],
      ['done', 'completed', null, null, 8],
      // The breaker's experiment counts its execution errors as done.
      ['broken', 'failed', null, 'invoice-db failed to start (setup) in 2 of 3 runs', 3],
      ['by provider', 'paused', 'provider_disconnected', 'Paused: Nous Portal is not connected', 0],
      ['by spend', 'paused', 'spend_ceiling', 'Paused at the $5.00 spend ceiling', 0],
      ['by user', 'paused', 'user', 'Paused by the user', 0],
      ['fresh', 'running', null, null, 0],
    ]);

    // Nothing ran yet: a quarter of the 300 s budget per run, 8 runs at concurrency 2.
    const f = await detail(fresh.experiment.id, at(30));
    expect(f).toMatchObject({ remainingEstimateS: 300, elapsedS: 30, lastEventAt: null, feed: [] });
    expect(f.spend).toMatchObject({
      spentUsd: 0,
      remainingEstimateUsd: null,
      projectedTotalUsd: null,
    });
    expect(f.aggregates[0]).toMatchObject({ runs: 4, passRate: null, meanScore: null, costUsd: 0 });

    // A paused experiment's clock stops at the pause.
    const u = await detail(byUser.experiment.id, at(500));
    expect(u).toMatchObject({ pauseReason: 'user', pausedAt: at(51).toISOString(), elapsedS: 50 });

    const p = await detail(byProvider.experiment.id, at(500));
    expect(p.worker).toMatchObject({ connected: true, workerLostRuns: 1 });

    const b = await detail(broken.experiment.id, at(500));
    expect(b).toMatchObject({
      status: 'failed',
      finishedAt: at(9).toISOString(),
      elapsedS: 5,
      remainingEstimateS: null,
      failure: {
        at: at(9).toISOString(),
        threshold: 3,
        category: 'setup',
        message: 'invoice-db failed to start',
        stderrFirstLine: 'Error: INVOICE_DB_URL is not set',
        // The first non-blank stderr line matches in two of the three runs.
        identicalIn: 2,
        // INVOICE_DB_URL is a variable invoice-db reads.
        fix: { label: 'check Secrets', to: '/resources/secrets' },
        runId: broken.run('a/cand/2'),
      },
    });
    expect(b.aggregates[1]).toMatchObject({
      executionErrors: 3,
      executionErrorCategories: ['setup'],
      passRate: 0,
    });

    const c = await detail(done.experiment.id, at(500));
    expect(c).toMatchObject({
      status: 'completed',
      finishedAt: at(40).toISOString(),
      elapsedS: 35,
      remainingEstimateS: null,
      failure: null,
    });
    expect(c.spend).toMatchObject({ remainingEstimateUsd: null, projectedTotalUsd: null });
    expect(c.aggregates.map((a) => [a.passRate, a.meanScore, a.medianDurationS])).toEqual([
      [1, 1, 10],
      [0, 0, 20],
    ]);
    expect(c.feed).toHaveLength(8);

    // Cancelled runs never count toward a pass rate.
    const s = await detail(stopped.experiment.id, at(500));
    expect(s.counts).toMatchObject({ scored: 2, cancelled: 6 });
    expect(s.aggregates.map((a) => [a.runs, a.passRate])).toEqual([
      [4, 1],
      [4, 1],
    ]);
  });

  it('reports a worker that stopped as disconnected, with its last heartbeat', async () => {
    const w = await seedWorld(t.db);
    const { experiment } = await launch(t.db, w);
    await t.db.update(workers).set({ stoppedAt: new Date() }).where(eq(workers.id, w.workerId));
    const d = await detail(experiment.id, at(10));
    expect(d.worker.connected).toBe(false);
    expect(d.worker.lastHeartbeatAt).not.toBeNull();
  });
});

describe('money with an unpriced model', () => {
  it('counts unpriced attempts, never as zero', async () => {
    const w = await seedWorld(t.db, { candidateModel: 'mystery/model-1' });
    const mixed = await launch(t.db, w, { name: 'mixed', createdAt: at(0) });
    await scored(t.db, w, mixed.run('a/base/1'), {
      startedAt: at(1),
      durationS: 10,
      status: 'passed',
      costUsd: 0.01,
    });
    await scored(t.db, w, mixed.run('a/cand/1'), {
      startedAt: at(1),
      durationS: 10,
      status: 'passed',
    });
    await scored(t.db, w, mixed.run('a/cand/2'), {
      startedAt: at(1),
      durationS: 10,
      status: 'passed',
    });

    const d = await detail(mixed.experiment.id, at(60));
    // The candidate's queued runs have no price, so nothing can be projected.
    expect(d.spend).toEqual({
      spentUsd: 0.01,
      ceilingUsd: 5,
      projectedTotalUsd: null,
      remainingEstimateUsd: null,
      unpricedAttempts: 2,
    });
    expect(d.aggregates.map((a) => a.costUsd)).toEqual([0.01, null]);
    expect((await listRow(mixed.experiment.id)).costUsd).toBe(0.01);

    // Only the unpriced arm has run: its cost is unknown, not $0.
    const onlyUnpriced = await launch(t.db, w, { name: 'only unpriced', createdAt: at(1) });
    await scored(t.db, w, onlyUnpriced.run('a/cand/1'), {
      startedAt: at(1),
      durationS: 10,
      status: 'passed',
    });
    expect((await listRow(onlyUnpriced.experiment.id)).costUsd).toBeNull();
  });

  it('projects from the launch estimate before any attempt is priced', async () => {
    const w = await seedWorld(t.db);
    const { experiment } = await launch(t.db, w, {
      estimate: { runs: 8, duration_s: 400, cost_usd: 0.16, basis: 'budget' },
    });
    const d = await detail(experiment.id, at(10));
    // 8 waiting runs at 0.16 / 8 each; 4 waves of 400 / 4 s.
    expect(d.spend).toMatchObject({
      spentUsd: 0,
      remainingEstimateUsd: 0.16,
      projectedTotalUsd: 0.16,
    });
    expect(d.remainingEstimateS).toBe(400);
  });
});

describe('the suite snapshot', () => {
  it('reports a newer version of the directory and what it means for the tasks', async () => {
    const w = await seedWorld(t.db);
    const { experiment } = await launch(t.db, w);
    const [v2] = await t.db
      .insert(suites)
      .values({
        sourcePath: 'invoices-v1',
        versionNumber: 2,
        name: 'invoices-v1',
        versionLabel: '2',
        contentHash: sha('suite v2'),
        checkHash: sha('checks v2'),
        taskCount: 1,
        validCount: 0,
      })
      .returning();
    await insertTask(t.db, v2!.id, 'total_due', 0, sha('task total_due v2'), false);
    await t.db
      .update(suiteSources)
      .set({ currentSuiteId: v2!.id })
      .where(eq(suiteSources.path, 'invoices-v1'));

    const d = await detail(experiment.id, at(10));
    expect(d.suite.newerVersion).toEqual({
      suiteId: v2!.id,
      versionNumber: 2,
      changedTasks: ['total_due'],
      removedTasks: ['dup_invoices'],
      invalidTasks: ['total_due'],
    });
    // The experiment's own frozen tasks are unchanged.
    expect(d.suite.tasks).toEqual([
      { key: 'total_due', version: 1 },
      { key: 'dup_invoices', version: 1 },
    ]);
  });
});
