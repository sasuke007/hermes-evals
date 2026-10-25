/**
 * The evaluate-run job's lifetime against pg-boss's own expiry check, on a
 * real Postgres 17 server (Phase 3 S8). Claim renewal keeps recovery away,
 * but pg-boss fails an active job once started_on + expire_seconds passes,
 * whatever its heartbeats say; so a pass as long as the slowest task the
 * loader accepts (MAX_SCORING_SECONDS) must survive that check and publish
 * once, with nothing dead-lettered.
 *
 * The pass is held open by a gated judge, and its age is set by moving the
 * job's started_on back, which is the column pg-boss's expiry reads; a
 * manual supervise() then runs the expiry sweep at once.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../database/migrator.js';
import * as schema from '../database/schema/index.js';
import { ensureQueues } from '../queue/queue.service.js';
import { EVALUATE_RUN_EXPIRE_SECONDS, MAX_SCORING_SECONDS, QUEUES } from '../queue/queues.js';
import type { JudgeResponse } from '../scoring/judge/contracts.js';
import { BlobStore } from '../storage/blob-store.js';
import { registerEvaluationHandlers } from './evaluate-run.handler.js';
import { sendEvaluateRun } from './job.js';
import {
  executeRun,
  fenced,
  logger,
  recordingReconcile,
  seedScenario,
  type ScenarioTask,
} from './support-spec.js';
import { FakeJudge, judgeAnswer, MOCK_JUDGE_SETTINGS, verdictText } from './support-judge-spec.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

const TASK: ScenarioTask = {
  verification: [
    { key: 'total', type: 'numeric_tolerance', primary: true, params: { path: 'total' } },
    { key: 'judge', type: 'llm_judge', primary: false, params: { rubric: 'rubric.md' } },
    { key: 'exact', type: 'exact_match', primary: false, params: { path: 'total' } },
  ],
  reference: { total: 1042 },
  files: [{ path: 'rubric.md', kind: 'rubric', content: 'Be clear.\n' }],
};

async function waitFor<T>(check: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!SERVER_URL)('the evaluate-run job lifetime on Postgres 17', () => {
  const database = `hermes_evals_evaluate_expiry_e2e_${process.pid}`;
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
    dataDir = await mkdtemp(join(tmpdir(), 'hermes-evals-evaluate-expiry-e2e-'));
    store = new BlobStore(dataDir);
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false, timeout: 1000 });
    await pool?.end();
    await admin(`drop database if exists ${database} with (force)`);
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  /** The job's state and retries, read the way pg-boss stores them. */
  const jobRow = async (jobId: string) =>
    (
      await pool.query<{ state: string; retry_count: number; expire_seconds: number }>(
        `select state, retry_count, expire_seconds from pgboss.job where id = $1`,
        [jobId],
      )
    ).rows[0];

  it('outlives a pass as long as the slowest loadable task: one publish, no dead letter', async () => {
    const scenario = await seedScenario(db, store, TASK);
    const runId = scenario.runIds[0]!;
    const { evaluationId } = await executeRun(db, store, scenario, runId, {
      finalText: fenced({ total: 1042 }),
    });
    let release!: (answer: JudgeResponse) => void;
    const gated = new FakeJudge(
      () =>
        new Promise<JudgeResponse>((resolve) => {
          release = resolve;
        }),
    );
    const { reconcile } = recordingReconcile();
    await registerEvaluationHandlers(
      boss,
      { db, store, reconcile, judge: gated, judgeSettings: MOCK_JUDGE_SETTINGS },
      logger(),
      1,
    );
    const jobId = (await db.transaction((tx) => sendEvaluateRun(boss, tx, evaluationId)))!;
    expect((await jobRow(jobId))!.expire_seconds).toBe(EVALUATE_RUN_EXPIRE_SECONDS);

    // The pass is at its judge key; make it as old as the slowest task the loader
    // accepts can be by now, plus the claim and evidence reads before the first key.
    await waitFor(async () => (gated.requests.length === 1 ? true : undefined));
    const aged = await pool.query(
      `update pgboss.job set started_on = started_on - make_interval(secs => $2)
         where id = $1 and state = 'active'`,
      [jobId, MAX_SCORING_SECONDS + 300],
    );
    expect(aged.rowCount).toBe(1);
    await boss.supervise(QUEUES.evaluateRun);
    expect((await jobRow(jobId))!.state).toBe('active');

    release(judgeAnswer(verdictText(0.9, 'Clear.')));
    const job = await waitFor(async () => {
      const found = await boss.getJobById(QUEUES.evaluateRun, jobId);
      return found?.state === 'completed' ? found : undefined;
    });
    expect(job.output).toEqual({ evaluationId, outcome: 'published' });
    expect((await jobRow(jobId))!.retry_count).toBe(0);

    const rows = await db
      .select({ key: schema.scores.key, status: schema.scores.status })
      .from(schema.scores)
      .where(eq(schema.scores.evaluationId, evaluationId))
      .orderBy(asc(schema.scores.key));
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ['exact', 'passed'],
      ['judge', 'passed'],
      ['total', 'passed'],
    ]);
    const [evaluation] = await db
      .select()
      .from(schema.evaluations)
      .where(eq(schema.evaluations.id, evaluationId));
    expect(evaluation).toMatchObject({ status: 'completed', error: null });
    const [dead] = await db
      .execute<{ n: number }>(
        sql`select count(*)::int as n from pgboss.job
            where name = ${QUEUES.evaluateRunDead} and data->>'evaluationId' = ${evaluationId}`,
      )
      .then((r) => r.rows);
    expect(dead!.n).toBe(0);
  });
});
