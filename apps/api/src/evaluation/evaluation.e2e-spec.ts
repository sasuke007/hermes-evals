/**
 * The evaluation pipeline on a real Postgres 17 server with real pg-boss
 * queues, for what PGlite cannot show: deliveries racing on separate
 * connections, the exclusive job key, retries ending in the dead-letter
 * queue, and the claim rules under concurrency (plan 9.4).
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { VerificationEntry } from '@hermes-evals/shared';
import { runMigrations } from '../database/migrator.js';
import * as schema from '../database/schema/index.js';
import { ensureQueues } from '../queue/queue.service.js';
import { QUEUES } from '../queue/queues.js';
import { BlobStore } from '../storage/blob-store.js';
import { claimEvaluation } from './claim.js';
import {
  handleEvaluateRunJob,
  registerEvaluateRunDeadHandler,
  registerEvaluateRunHandler,
  type EvaluateRunResult,
} from './evaluate-run.handler.js';
import { loadEvidence } from './evidence.js';
import { evaluateRunKey, queueEvaluation, sendEvaluateRun } from './job.js';
import { publishEvaluation } from './publish.js';
import { scoreEvidence } from './score.js';
import {
  executeRun,
  fenced,
  logger,
  recordingReconcile,
  seedScenario,
  type ScenarioTask,
} from './support-spec.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

const VERIFICATION: VerificationEntry[] = [
  { key: 'total', type: 'numeric_tolerance', primary: true, params: { path: 'total' } },
  { key: 'summary', type: 'file_check', primary: false, params: { path: 'summary.txt' } },
  { key: 'judge', type: 'llm_judge', primary: false, params: { rubric: 'rubric.md' } },
];
const TASK: ScenarioTask = {
  verification: VERIFICATION,
  reference: { total: 1042 },
  files: [{ path: 'rubric.md', kind: 'rubric', content: 'Be clear.\n' }],
};
const EVIDENCE = {
  finalText: fenced({ total: 1042 }),
  files: [{ path: 'summary.txt', content: 'Total: 1042\n' }],
};

/** Polls until `check` resolves a value other than undefined, or fails after `timeoutMs`. */
async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe.skipIf(!SERVER_URL)('evaluation on Postgres 17', () => {
  const database = `hermes_evals_evaluation_e2e_${process.pid}`;
  let pool: pg.Pool;
  let db: NodePgDatabase<typeof schema>;
  let boss: PgBoss;
  let dataDir: string;
  let store: BlobStore;

  const admin = async (statement: string) => {
    const client = new pg.Client({ connectionString: SERVER_URL });
    await client.connect();
    try {
      await client.query(statement);
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    await admin(`drop database if exists ${database}`);
    await admin(`create database ${database}`);
    const url = new URL(SERVER_URL!);
    url.pathname = `/${database}`;
    await runMigrations(url.toString());
    pool = new pg.Pool({ connectionString: url.toString(), max: 10 });
    db = drizzle(pool, { schema });
    boss = new PgBoss({
      connectionString: url.toString(),
      schema: 'pgboss',
      supervise: false,
      schedule: false,
    });
    boss.on('error', () => {});
    await boss.start();
    await ensureQueues(boss);
    dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-evaluation-e2e-'));
    store = new BlobStore(dataDir);
  });

  afterEach(async () => {
    await boss.offWork(QUEUES.evaluateRun);
    await boss.offWork(QUEUES.evaluateRunDead);
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false, timeout: 1000 });
    await pool?.end();
    await admin(`drop database if exists ${database} with (force)`);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const scoreCount = async (evaluationId: string) =>
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.scores)
        .where(eq(schema.scores.evaluationId, evaluationId))
    )[0]!.n;

  const evaluationRow = async (id: string) =>
    (await db.select().from(schema.evaluations).where(eq(schema.evaluations.id, id)))[0]!;

  const runStatus = async (id: string) =>
    (await db.select().from(schema.runs).where(eq(schema.runs.id, id)))[0]!.status;

  it('publishes each evaluation once when deliveries race, and completes the experiment once', async () => {
    const scenario = await seedScenario(db, store, TASK);
    const evaluationIds: string[] = [];
    for (const runId of scenario.runIds) {
      evaluationIds.push((await executeRun(db, store, scenario, runId, EVIDENCE)).evaluationId);
    }

    // The exclusive key: a second send for a live job is a no-op.
    const sent = await db.transaction(async (tx) => [
      await sendEvaluateRun(boss, tx, evaluationIds[0]!),
      await sendEvaluateRun(boss, tx, evaluationIds[0]!),
    ]);
    expect(sent[0]).toEqual(expect.any(String));
    expect(sent[1]).toBeNull();
    await boss.cancel(QUEUES.evaluateRun, sent[0]!);

    // Four redeliveries of each evaluation, racing on their own connections,
    // with the real reconcile: the last claim of each publishes, once, and
    // the experiment row taken first keeps the two runs' finishers in order.
    const deps = { db, store };
    const results = await Promise.all(
      evaluationIds.flatMap((evaluationId) =>
        Array.from({ length: 4 }, () => handleEvaluateRunJob({ evaluationId }, deps, logger())),
      ),
    );
    for (const evaluationId of evaluationIds) {
      const published = results.filter(
        (r) => r.evaluationId === evaluationId && r.outcome === 'published',
      );
      expect(published).toHaveLength(1);
      expect(await scoreCount(evaluationId)).toBe(VERIFICATION.length);
      expect((await evaluationRow(evaluationId)).status).toBe('completed');
    }
    for (const runId of scenario.runIds) expect(await runStatus(runId)).toBe('scored');
    const [experiment] = await db
      .select()
      .from(schema.experiments)
      .where(eq(schema.experiments.id, scenario.experimentId));
    expect(experiment).toMatchObject({ status: 'completed', verdictHistory: [] });
    expect(experiment!.verdictRevision).toBe(experiment!.resultsRevision);
  });

  it('runs a job through pg-boss, and a job sent again after publishing changes nothing', async () => {
    const scenario = await seedScenario(db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { attemptId } = await executeRun(db, store, scenario, runId, EVIDENCE);
    const { calls, reconcile } = recordingReconcile();
    await registerEvaluateRunHandler(boss, { db, store, reconcile }, logger(), 2);

    // executeRun inserted generation 1 without a job, as a finish transaction would before sending it.
    const first = await db
      .select({ id: schema.evaluations.id })
      .from(schema.evaluations)
      .where(eq(schema.evaluations.runId, runId));
    const firstJob = await db.transaction((tx) => sendEvaluateRun(boss, tx, first[0]!.id));
    await waitFor(async () =>
      (await evaluationRow(first[0]!.id)).status === 'completed' ? true : undefined,
    );
    const job = await waitFor(async () => {
      const found = await boss.getJobById(QUEUES.evaluateRun, firstJob!);
      return found?.state === 'completed' ? found : undefined;
    });
    expect(job.output).toEqual({ evaluationId: first[0]!.id, outcome: 'published' });
    expect(calls).toEqual([scenario.experimentId]);

    // The key is free once the job completed; the new job finds nothing to do.
    const again = await db.transaction((tx) => sendEvaluateRun(boss, tx, first[0]!.id));
    const repeated = await waitFor(async () => {
      const found = await boss.getJobById(QUEUES.evaluateRun, again!);
      return found?.state === 'completed' ? found : undefined;
    });
    expect(repeated.output as EvaluateRunResult).toMatchObject({ outcome: 'finished' });
    expect(await scoreCount(first[0]!.id)).toBe(VERIFICATION.length);

    // A re-score through queueEvaluation supersedes the first result.
    const rescore = await db.transaction((tx) =>
      queueEvaluation(boss, tx, { runId, attemptId, cause: 'rescore' }),
    );
    expect(rescore.generation).toBe(2);
    await waitFor(async () =>
      (await evaluationRow(rescore.evaluationId)).status === 'completed' ? true : undefined,
    );
    expect((await evaluationRow(first[0]!.id)).supersededAt).toBeInstanceOf(Date);
    const current = await db
      .select({ id: schema.evaluations.id })
      .from(schema.evaluations)
      .where(
        and(
          eq(schema.evaluations.runId, runId),
          eq(schema.evaluations.status, 'completed'),
          isNull(schema.evaluations.supersededAt),
        ),
      );
    expect(current).toEqual([{ id: rescore.evaluationId }]);
    expect(await runStatus(runId)).toBe('scored');
  });

  it('refuses the publish of a delivery whose expired claim a second delivery took', async () => {
    const scenario = await seedScenario(db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { evaluationId } = await executeRun(db, store, scenario, runId, EVIDENCE);
    const reconcile = recordingReconcile().reconcile;

    // Delivery 1 claims and scores, then stalls past its claim.
    const stale = await claimEvaluation(db, evaluationId);
    const staleScores = await scoreEvidence((await loadEvidence(db, stale!))!, { db, store });
    await db
      .update(schema.evaluations)
      .set({ claimExpiresAt: sql`now() - interval '1 minute'` })
      .where(eq(schema.evaluations.id, evaluationId));

    // Recovery re-sends the job; delivery 2 claims afresh and publishes.
    const second = await handleEvaluateRunJob({ evaluationId }, { db, store, reconcile }, logger());
    expect(second.outcome).toBe('published');
    const published = await evaluationRow(evaluationId);
    expect(published.claimToken).not.toBe(stale!.token);

    // Delivery 1 wakes up: its token is gone, so nothing it scored is written.
    expect(await publishEvaluation(db, stale!, staleScores, reconcile)).toBe('lost');
    expect(await scoreCount(evaluationId)).toBe(VERIFICATION.length);
    expect(await evaluationRow(evaluationId)).toEqual(published);
  });

  it('dead-letters a first evaluation that keeps failing and publishes error scores', async () => {
    const scenario = await seedScenario(db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { evaluationId } = await executeRun(db, store, scenario, runId, EVIDENCE);
    const failing = async (): Promise<never> => {
      throw new Error('reconcile exploded');
    };
    const { calls, reconcile } = recordingReconcile();
    await registerEvaluateRunDeadHandler(boss, { db, reconcile }, logger());
    await registerEvaluateRunHandler(boss, { db, store, reconcile: failing }, logger(), 1);

    // No retries for the test: the first failure goes straight to the dead-letter queue.
    await boss.send(
      QUEUES.evaluateRun,
      { evaluationId },
      {
        singletonKey: evaluateRunKey(evaluationId),
        retryLimit: 0,
      },
    );
    await waitFor(async () =>
      (await evaluationRow(evaluationId)).status === 'completed' ? true : undefined,
    );

    const rows = await db
      .select()
      .from(schema.scores)
      .where(eq(schema.scores.evaluationId, evaluationId));
    expect(rows.map((r) => r.key).sort()).toEqual(VERIFICATION.map((v) => v.key).sort());
    for (const row of rows) {
      expect(row).toMatchObject({
        status: 'error',
        score: null,
        comment: 'grading failed after 1 try: reconcile exploded',
      });
    }
    expect(await evaluationRow(evaluationId)).toMatchObject({
      status: 'completed',
      error: 'grading failed after 1 try: reconcile exploded',
    });
    expect(await runStatus(runId)).toBe('scored');
    expect(calls).toEqual([scenario.experimentId]);
  });
});
