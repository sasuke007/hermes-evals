/**
 * Verdict entries and the comparison on a real Postgres 17 server through
 * node-postgres, the driver production uses (plan 7.4 and 10.3):
 * - finishers at the same moment, lined up behind the experiment row and
 *   let go together, append exactly one entry per candidate: the first
 *   completes the experiment and moves the verdict revision, the rest find
 *   the revisions equal (READ COMMITTED re-reads the row once the lock is
 *   released);
 * - two runs finishing at once, each publishing and reconciling in its own
 *   transaction, append once too;
 * - the design's Skill vs no skill gives the same comparison through
 *   node-postgres's result types (counts and numeric sums as strings) as on
 *   PGlite, in its REPEATABLE READ READ ONLY transaction;
 * - GET /api/experiments/:id/comparison answers afresh after an execution
 *   error, a retry, a cancellation and a re-score.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import type { Server } from 'node:http';
import request from 'supertest';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import {
  ComparisonViewSchema,
  VerdictEntrySchema,
  type ComparisonView,
  type ScoreStatus,
} from '@hermes-evals/shared';
import { rescoreRun } from '../../../test/support/seed.js';
import { DB } from '../../database/db.provider.js';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationsInSync, runMigrations } from '../../database/migrator.js';
import * as schema from '../../database/schema/index.js';
import {
  attempts,
  configurations,
  configurationVersions,
  evaluations,
  experiments,
  runs,
  scores,
} from '../../database/schema/index.js';
import { reconcileExperiment, type ReconcileResult } from '../reconcile.js';
import {
  at,
  cancelled,
  errored,
  launch,
  PRICE_TABLE,
  PRICED_MODEL,
  REVISION,
  scored,
  seedWorld,
  sha,
  start,
  type World,
} from '../views/seed.support-spec.js';
import { ComparisonModule } from './comparison.module.js';
import { ComparisonService } from './comparison.service.js';
import { Design } from './design-world.support-spec.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

/** The statement reconcile waits in while another holds the experiment row. */
const ROW_LOCK = '%from "experiments"%for no key update%';

interface E2eDatabase {
  db: NodePgDatabase<typeof schema>;
  /** Connections apart from the app's, for the lock holder and the observer. */
  side: pg.Pool;
  close(): Promise<void>;
}

let created = 0;
let current: E2eDatabase | null = null;

async function admin(statement: string): Promise<void> {
  const client = new pg.Client({ connectionString: SERVER_URL });
  await client.connect();
  try {
    await client.query(statement);
  } finally {
    await client.end();
  }
}

async function createDatabase(): Promise<E2eDatabase> {
  const database = `hermes_evals_verdicts_e2e_${process.pid}_${++created}`;
  await admin(`drop database if exists ${database}`);
  await admin(`create database ${database}`);
  const parsed = new URL(SERVER_URL!);
  parsed.pathname = `/${database}`;
  expect(migrationsInSync(await runMigrations(parsed.toString()))).toBe(true);
  const pool = new pg.Pool({ connectionString: parsed.toString(), max: 8 });
  const side = new pg.Pool({ connectionString: parsed.toString(), max: 3 });
  current = {
    db: drizzle(pool, { schema }),
    side,
    close: async () => {
      await pool.end();
      await side.end();
      await admin(`drop database if exists ${database} with (force)`);
    },
  };
  return current;
}

afterEach(async () => {
  await current?.close();
  current = null;
});

/** Holds the experiment row on its own connection until `release`. */
async function holdExperiment(side: pg.Pool, id: string) {
  const client = await side.connect();
  await client.query('begin');
  await client.query('select 1 from experiments where id = $1 for no key update', [id]);
  return async () => {
    try {
      await client.query('commit');
    } finally {
      client.release();
    }
  };
}

/** Resolves once `n` sessions wait for a lock in the experiment row statement. */
async function waitForLockWaits(side: pg.Pool, n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await side.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity
        where datname = current_database() and backend_type = 'client backend'
          and wait_event_type = 'Lock' and query ilike $1`,
      [ROW_LOCK],
    );
    if (rows[0]!.n >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`expected ${n} sessions waiting for the experiment row`);
}

/**
 * a and c: baseline 1 of 2, each candidate 2 of 2; b: baseline 0 of 2, each
 * candidate 1 of 2.
 */
function statusOf(task: 'a' | 'b' | 'c', baseline: boolean, repetition: number): ScoreStatus {
  if (task !== 'b') return baseline && repetition === 2 ? 'failed' : 'passed';
  return !baseline && repetition === 1 ? 'passed' : 'failed';
}

/** An experiment on two candidates (with-mcp, then with-skill), every run scored. */
async function twoCandidates(e: E2eDatabase, w: World) {
  const second = await e.db.transaction(async (tx) => {
    const [configuration] = await tx
      .insert(configurations)
      .values({ name: 'with-skill' })
      .returning();
    const [version] = await tx
      .insert(configurationVersions)
      .values({
        configurationId: configuration!.id,
        version: 1,
        model: PRICED_MODEL,
        provider: 'nous',
        toolsets: ['file'],
        maxTurns: 20,
        timeBudgetS: 300,
        configHash: sha('config with-skill'),
        frozenAt: new Date(),
      })
      .returning({ id: configurationVersions.id });
    return version!.id;
  });
  const [experiment] = await e.db
    .insert(experiments)
    .values({
      name: 'two candidates',
      suiteId: w.suiteId,
      taskIds: w.taskIds,
      baselineVersionId: w.baselineVersionId,
      candidateVersionIds: [w.candidateVersionId, second],
      repetitions: 2,
      concurrency: 2,
      hermesVersion: '0.22.4',
      hermesRevision: REVISION,
      priceTable: PRICE_TABLE,
    })
    .returning({ id: experiments.id });
  const inserted = await e.db
    .insert(runs)
    .values(
      w.taskIds.flatMap((taskId) =>
        [w.baselineVersionId, w.candidateVersionId, second].flatMap((configurationVersionId) =>
          [1, 2].map((repetition) => ({
            experimentId: experiment!.id,
            taskId,
            configurationVersionId,
            repetition,
          })),
        ),
      ),
    )
    .returning();
  for (const run of inserted) {
    const status = statusOf(
      (['a', 'b', 'c'] as const)[w.taskIds.indexOf(run.taskId)]!,
      run.configurationVersionId === w.baselineVersionId,
      run.repetition,
    );
    await scored(e.db, w, run.id, { startedAt: at(0), durationS: 5, status });
  }
  return { experimentId: experiment!.id, candidates: [w.candidateVersionId, second] };
}

describe.skipIf(!SERVER_URL)('verdict entries on Postgres 17', () => {
  it('appends one entry per candidate when three finishers reconcile at the same moment', async () => {
    const e = await createDatabase();
    // Three tasks, the fewest a verdict needs.
    const w = await seedWorld(e.db, { tasks: 3 });
    const { experimentId, candidates } = await twoCandidates(e, w);

    const release = await holdExperiment(e.side, experimentId);
    const finishers: Promise<ReconcileResult>[] = [1, 2, 3].map(() =>
      e.db.transaction((tx) => reconcileExperiment(tx, experimentId)),
    );
    await waitForLockWaits(e.side, 3);
    await release();
    const results = await Promise.all(finishers);
    expect(results.toSorted()).toEqual(['completed', 'unchanged', 'unchanged']);

    const [row] = await e.db.select().from(experiments).where(eq(experiments.id, experimentId));
    expect(row).toMatchObject({ status: 'completed', verdictRevision: row!.resultsRevision });
    const entries = row!.verdictHistory.map((entry) => VerdictEntrySchema.parse(entry));
    expect(
      entries.map((entry) => [entry.candidate_version_id, entry.cause, entry.verdict]),
    ).toEqual([
      [candidates[0], 'initial', 'better'],
      [candidates[1], 'initial', 'better'],
    ]);
    expect(new Set(entries.map((entry) => entry.at)).size).toBe(1);
    expect(entries.every((entry) => entry.results_revision === row!.resultsRevision)).toBe(true);
  });

  it('appends once when the last two runs finish at once, each reconciling in its own transaction', async () => {
    const e = await createDatabase();
    const w = await seedWorld(e.db);
    const { experiment, run } = await launch(e.db, w);
    const last = ['b/cand/1', 'b/cand/2'];
    for (const key of ['a/base/1', 'a/base/2', 'a/cand/1', 'a/cand/2', 'b/base/1', 'b/base/2']) {
      await scored(e.db, w, run(key), { startedAt: at(0), durationS: 5, status: 'passed' });
    }
    // The last two are executed with their first evaluation claimed, waiting to publish.
    const pending: { runId: string; evaluationId: string }[] = [];
    for (const key of last) {
      const attemptId = await start(e.db, w, run(key), at(1));
      const evaluationId = await e.db.transaction(async (tx) => {
        await tx
          .update(attempts)
          .set({
            status: 'executed',
            finishedAt: at(6),
            exitCode: 0,
            durationMs: 5000,
            finalText: '```json\n{}\n```',
          })
          .where(eq(attempts.id, attemptId));
        await tx
          .update(runs)
          .set({ status: 'executed' })
          .where(eq(runs.id, run(key)));
        await tx
          .update(runs)
          .set({ status: 'scoring' })
          .where(eq(runs.id, run(key)));
        const [evaluation] = await tx
          .insert(evaluations)
          .values({
            runId: run(key),
            attemptId,
            cause: 'initial',
            generation: 1,
            status: 'running',
            startedAt: at(6),
            claimToken: crypto.randomUUID(),
            claimExpiresAt: new Date(Date.now() + 600_000),
          })
          .returning({ id: evaluations.id });
        await tx.insert(scores).values({
          evaluationId: evaluation!.id,
          key: 'answer',
          type: 'json_match',
          status: 'failed',
          isPrimary: true,
          score: 0,
          comment: 'failed',
          scorerVersion: 1,
        });
        return evaluation!.id;
      });
      pending.push({ runId: run(key), evaluationId });
    }

    const release = await holdExperiment(e.side, experiment.id);
    // publish.ts: the experiment row first, then the evaluation and the run, then reconcile.
    const publishers = pending.map(({ runId, evaluationId }) =>
      e.db.transaction(async (tx) => {
        await tx
          .select({ id: experiments.id })
          .from(experiments)
          .where(eq(experiments.id, experiment.id))
          .for('no key update');
        await tx
          .update(evaluations)
          .set({ status: 'completed', finishedAt: sql`now()` })
          .where(eq(evaluations.id, evaluationId));
        await tx
          .update(runs)
          .set({ status: 'scored', finishedAt: sql`now()` })
          .where(eq(runs.id, runId));
        return reconcileExperiment(tx, experiment.id);
      }),
    );
    await waitForLockWaits(e.side, 2);
    await release();
    expect((await Promise.all(publishers)).toSorted()).toEqual(['completed', 'unchanged']);

    const [row] = await e.db.select().from(experiments).where(eq(experiments.id, experiment.id));
    expect(row!.verdictHistory).toHaveLength(1);
    expect(row!.verdictHistory[0]).toMatchObject({
      cause: 'initial',
      results_revision: row!.resultsRevision,
      pass_counts: { baseline: { passed: 4, counted: 4 }, candidate: { passed: 2, counted: 4 } },
      task_counts: { improved: 0, regressed: 1, unchanged: 1 },
    });
    expect(row!.verdictRevision).toBe(row!.resultsRevision);
  });

  it('gives the design’s comparison through node-postgres', async () => {
    const e = await createDatabase();
    const design = await Design.load();
    const world = await design.insert(e.db, design.seed('skillVsNoSkill'));
    await e.db.transaction((tx) => reconcileExperiment(tx, world.experimentId));
    const view = await new ComparisonService(e.db).comparison(world.experimentId, {});
    expect(view).toMatchObject({
      experimentStatus: 'completed',
      passRates: { baseline: 0.633, candidate: 0.85 },
      passCounts: { baseline: { passed: 38, counted: 60 }, candidate: { passed: 51, counted: 60 } },
      statistics: { observedDelta: 0.217, lo: 0.117, hi: 0.333, verdict: 'better' },
      filterCounts: { all: 12, improved: 8, regressed: 0, unchanged: 4 },
      progress: { scored: 119, total: 120 },
    });
    expect(view.secondary.map((r) => [r.medianDurationS, r.meanTokens, r.costUsd])).toEqual([
      [48, 14_200, 0.7077],
      [61, 19_800, 0.9855],
    ]);
    const [row] = await e.db
      .select()
      .from(experiments)
      .where(eq(experiments.id, world.experimentId));
    expect(row!.verdictHistory).toMatchObject([
      {
        cause: 'initial',
        verdict: 'better',
        pass_counts: view.passCounts,
        task_counts: { improved: 8, regressed: 0, unchanged: 4 },
      },
    ]);
  });

  it('answers GET /api/experiments/:id/comparison afresh after every kind of change', async () => {
    const e = await createDatabase();
    const w = await seedWorld(e.db);
    const { experiment, run } = await launch(e.db, w);

    @Global()
    @Module({ providers: [{ provide: DB, useValue: e.db }], exports: [DB] })
    class Postgres {}
    const moduleRef = await Test.createTestingModule({
      imports: [Postgres, ComparisonModule],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    await app.init();
    try {
      const server = app.getHttpServer() as Server;
      const get = async (): Promise<ComparisonView> =>
        ComparisonViewSchema.parse(
          (await request(server).get(`/api/experiments/${experiment.id}/comparison`).expect(200))
            .body,
        );
      const cell = (view: ComparisonView, runId: string) =>
        view.rows.flatMap((r) => [...r.baseline, ...r.candidate]).find((c) => c.runId === runId)!;

      expect(cell(await get(), run('a/base/1')).runStatus).toBe('queued');
      // An execution error.
      await errored(e.db, w, run('a/base/1'), {
        startedAt: at(0),
        durationS: 4,
        category: 'timeout',
        message: 'no final response',
      });
      expect(cell(await get(), run('a/base/1'))).toMatchObject({
        runStatus: 'execution_error',
        comment: 'execution_error · timeout: no final response',
      });
      // A retry.
      await e.db
        .update(runs)
        .set({ status: 'queued', finishedAt: null, nextTrigger: 'user_retry' })
        .where(eq(runs.id, run('a/base/1')));
      expect(cell(await get(), run('a/base/1'))).toMatchObject({
        runStatus: 'queued',
        comment: null,
      });
      // A cancellation.
      await cancelled(e.db, run('b/cand/2'), at(5));
      expect(cell(await get(), run('b/cand/2')).runStatus).toBe('cancelled');
      // A re-score.
      await scored(e.db, w, run('a/cand/1'), { startedAt: at(0), durationS: 5, status: 'passed' });
      expect(cell(await get(), run('a/cand/1')).scoreStatus).toBe('passed');
      await rescoreRun(e.db, run('a/cand/1'), 'failed');
      const last = await get();
      expect(cell(last, run('a/cand/1'))).toMatchObject({
        scoreStatus: 'failed',
        comment: 're-scored failed',
      });
      expect(last.passCounts.candidate).toEqual({ passed: 0, counted: 1 });
      expect(last.progress).toEqual({ scored: 1, total: 8 });
    } finally {
      await app.close();
    }
  });
});
