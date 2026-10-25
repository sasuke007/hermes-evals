/**
 * Seeds for the experiment view tests: a suite version with two tasks, a
 * baseline and a candidate configuration (the candidate with one more turn
 * and the invoice-db MCP server), a live worker, and helpers that move runs
 * through their lifecycle the way the worker does, so every row passes the
 * 0001 triggers the views read behind.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type {
  ExecutionErrorCategory,
  ExperimentEstimate,
  ExperimentFailure,
  PauseReason,
  PriceTable,
  ScoreStatus,
  SelfCheck,
  Tokens,
  VerificationEntry,
} from '@hermes-evals/shared';
import {
  attempts,
  configurations,
  configurationVersions,
  evaluations,
  experiments,
  mcpServers,
  mcpServerVersions,
  runEvents,
  runs,
  scores,
  suiteSources,
  suites,
  tasks,
  workers,
} from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';

export const sha = (content: string): string => createHash('sha256').update(content).digest('hex');

export const REVISION = '4d04303818b61bf3aa09278af48356315515965b';
export const PRICED_MODEL = 'openai/gpt-6.1-sol';

export const PRICE_TABLE: PriceTable = {
  sha256: sha('prices'),
  loaded_at: '2026-10-23T09:00:00.000Z',
  models: {
    [PRICED_MODEL]: { input_per_1m: 1.25, output_per_1m: 10, checked_at: '2026-10-20' },
  },
};

const VERIFICATION: VerificationEntry[] = [
  { key: 'answer', type: 'json_match', primary: true, params: { path: 'total' } },
];

const SELF_CHECK: SelfCheck = {
  status: 'passed',
  ran_at: '2026-10-23T09:00:00.000Z',
  duration_ms: 12,
  results: [
    {
      key: 'answer',
      type: 'json_match',
      mode: 'answer',
      status: 'passed',
      score: 1,
      comment: 'ok',
    },
  ],
};

/** Fixed clock for the seeds: T0 plus `s` seconds. */
export const T0 = new Date('2026-10-24T10:00:00.000Z');
export const at = (s: number): Date => new Date(T0.getTime() + s * 1000);

export interface World {
  suiteId: string;
  taskIds: [string, string];
  baselineVersionId: string;
  candidateVersionId: string;
  workerId: string;
}

/** One task of a suite version, valid unless `valid` is false (an invalid one also gets a reason). */
export async function insertTask(
  db: AppDb,
  suiteId: string,
  key: string,
  position: number,
  hash: string,
  valid = true,
): Promise<string> {
  const [task] = await db
    .insert(tasks)
    .values({
      suiteId,
      key,
      versionNumber: 1,
      introducedInSuiteId: suiteId,
      position,
      summary: `Task ${key}`,
      prompt: `Solve ${key}.`,
      limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file'] },
      reference: 1,
      verification: VERIFICATION,
      taskYaml: `summary: Task ${key}\n`,
      selfCheck: SELF_CHECK,
      valid,
      invalidReason: valid ? null : 'the self-check failed',
      contentHash: hash,
    })
    .returning({ id: tasks.id });
  return task!.id;
}

/** A configuration named `name` with one frozen version; resolves the version's id. */
export async function insertVersion(
  db: AppDb,
  name: string,
  overrides: Partial<typeof configurationVersions.$inferInsert> = {},
): Promise<string> {
  return db.transaction(async (tx) => {
    const [configuration] = await tx.insert(configurations).values({ name }).returning();
    const [version] = await tx
      .insert(configurationVersions)
      .values({
        configurationId: configuration!.id,
        version: 1,
        model: PRICED_MODEL,
        provider: 'nous',
        toolsets: ['file', 'terminal'],
        maxTurns: 20,
        timeBudgetS: 300,
        configHash: sha(`config ${name}`),
        frozenAt: new Date(),
        ...overrides,
      })
      .returning({ id: configurationVersions.id });
    return version!.id;
  });
}

export interface WorldOptions {
  /** The candidate's model; the price table prices only PRICED_MODEL. */
  candidateModel?: string;
}

export async function seedWorld(db: AppDb, options: WorldOptions = {}): Promise<World> {
  const [suite] = await db
    .insert(suites)
    .values({
      sourcePath: 'invoices-v1',
      versionNumber: 1,
      name: 'invoices-v1',
      versionLabel: '1',
      contentHash: sha('suite v1'),
      checkHash: sha('checks v1'),
      taskCount: 2,
      validCount: 2,
    })
    .returning();
  await db.insert(suiteSources).values({
    path: 'invoices-v1',
    name: 'invoices-v1',
    currentSuiteId: suite!.id,
    lastOutcome: 'created',
  });
  const taskIds: [string, string] = [
    await insertTask(db, suite!.id, 'total_due', 0, sha('task total_due v1')),
    await insertTask(db, suite!.id, 'dup_invoices', 1, sha('task dup_invoices v1')),
  ];
  const mcpVersionId = await db.transaction(async (tx) => {
    const [server] = await tx.insert(mcpServers).values({ name: 'invoice-db' }).returning();
    const [version] = await tx
      .insert(mcpServerVersions)
      .values({
        mcpServerId: server!.id,
        version: 1,
        transport: 'stdio',
        command: 'invoice-db',
        envNames: ['INVOICE_DB_URL'],
        definitionHash: sha('invoice-db v1'),
      })
      .returning({ id: mcpServerVersions.id });
    return version!.id;
  });
  const baselineVersionId = await insertVersion(db, 'baseline');
  const candidateVersionId = await insertVersion(db, 'with-mcp', {
    model: options.candidateModel ?? PRICED_MODEL,
    maxTurns: 21,
    mcpServerVersionIds: [mcpVersionId],
  });
  const [worker] = await db
    .insert(workers)
    .values({
      hostname: 'worker-1',
      concurrency: 2,
      slots: 4,
      hermesVersion: '0.22.4',
      hermesRevision: REVISION,
    })
    .returning({ id: workers.id });
  return {
    suiteId: suite!.id,
    taskIds,
    baselineVersionId,
    candidateVersionId,
    workerId: worker!.id,
  };
}

export interface LaunchOptions {
  name?: string;
  repetitions?: number;
  concurrency?: number;
  spendCeilingUsd?: number | null;
  estimate?: ExperimentEstimate | null;
  createdAt?: Date;
  /** Candidates after the world's, in order; their runs are keyed `cand2`, `cand3`, … */
  moreCandidates?: string[];
}

/**
 * A running experiment with every run of its matrix queued, keyed
 * `<task>/<config>/<rep>`: task `a` or `b`, config `base`, `cand`, then
 * `cand2`, … for options.moreCandidates.
 */
export async function launch(db: AppDb, w: World, options: LaunchOptions = {}) {
  const candidates = [w.candidateVersionId, ...(options.moreCandidates ?? [])];
  const [experiment] = await db
    .insert(experiments)
    .values({
      name: options.name ?? 'MCP vs baseline',
      suiteId: w.suiteId,
      taskIds: w.taskIds,
      baselineVersionId: w.baselineVersionId,
      candidateVersionIds: candidates,
      repetitions: options.repetitions ?? 2,
      concurrency: options.concurrency ?? 2,
      spendCeilingUsd: options.spendCeilingUsd === undefined ? 5 : options.spendCeilingUsd,
      hermesVersion: '0.22.4',
      hermesRevision: REVISION,
      priceTable: PRICE_TABLE,
      estimate: options.estimate ?? null,
      createdAt: options.createdAt ?? T0,
    })
    .returning();
  const reps = Array.from({ length: options.repetitions ?? 2 }, (_, i) => i + 1);
  const rows = await db
    .insert(runs)
    .values(
      w.taskIds.flatMap((taskId) =>
        [w.baselineVersionId, ...candidates].flatMap((configurationVersionId) =>
          reps.map((repetition) => ({
            experimentId: experiment!.id,
            taskId,
            configurationVersionId,
            repetition,
          })),
        ),
      ),
    )
    .returning();
  const keys = new Map<string, string>();
  for (const run of rows) {
    const task = run.taskId === w.taskIds[0] ? 'a' : 'b';
    const index = candidates.indexOf(run.configurationVersionId);
    const config = index < 0 ? 'base' : index === 0 ? 'cand' : `cand${index + 1}`;
    keys.set(`${task}/${config}/${run.repetition}`, run.id);
  }
  const run = (key: string): string => {
    const id = keys.get(key);
    if (!id) throw new Error(`no run ${key}`);
    return id;
  };
  return { experiment: experiment!, run };
}

/** Starts the run's next attempt (queued → running), as the worker's claim does. */
export async function start(
  db: AppDb,
  w: World,
  runId: string,
  startedAt: Date,
  number = 1,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [attempt] = await tx
      .insert(attempts)
      .values({
        runId,
        number,
        trigger: number === 1 ? 'initial' : 'user_retry',
        status: 'running',
        workerId: w.workerId,
        trialPath: `trials/${runId}/a${number}`,
        startedAt,
      })
      .returning({ id: attempts.id });
    await tx
      .update(runs)
      .set({
        status: 'running',
        attemptCount: number,
        currentAttemptId: attempt!.id,
        finishedAt: null,
      })
      .where(eq(runs.id, runId));
    return attempt!.id;
  });
}

/** Records events on a running attempt at the given times. */
export async function events(db: AppDb, attemptId: string, times: readonly Date[]): Promise<void> {
  await db.insert(runEvents).values(
    times.map((t, i) => ({
      attemptId,
      seq: i + 1,
      ts: t.getTime(),
      type: 'text' as const,
      payload: { type: 'text' as const, text: `step ${i + 1}` },
    })),
  );
}

export interface ScoredRun {
  startedAt: Date;
  durationS: number;
  status: ScoreStatus;
  score?: number | null;
  tokens?: Tokens | null;
  costUsd?: number | null;
}

const tokensOf = (total: number): Tokens => ({
  input: Math.round(total * 0.8),
  output: total - Math.round(total * 0.8),
  total,
  cache_read: 0,
  cache_write: 0,
});

export const tokens = tokensOf;

/** Runs, executes and scores a queued run; it finishes `durationS` after it starts. */
export async function scored(db: AppDb, w: World, runId: string, r: ScoredRun): Promise<void> {
  const attemptId = await start(db, w, runId, r.startedAt);
  const finishedAt = new Date(r.startedAt.getTime() + r.durationS * 1000);
  await db.transaction(async (tx) => {
    await tx
      .update(attempts)
      .set({
        status: 'executed',
        finishedAt,
        exitCode: 0,
        finalText: '```json\n{"total": 1}\n```',
        tokens: r.tokens === undefined ? tokensOf(1000) : r.tokens,
        durationMs: r.durationS * 1000,
        costUsd: r.costUsd ?? null,
      })
      .where(eq(attempts.id, attemptId));
    await tx.update(runs).set({ status: 'executed' }).where(eq(runs.id, runId));
  });
  await db.transaction(async (tx) => {
    await tx.update(runs).set({ status: 'scoring' }).where(eq(runs.id, runId));
    const [evaluation] = await tx
      .insert(evaluations)
      .values({
        runId,
        attemptId,
        cause: 'initial',
        generation: 1,
        status: 'running',
        startedAt: finishedAt,
        claimToken: crypto.randomUUID(),
        claimExpiresAt: new Date(finishedAt.getTime() + 600_000),
      })
      .returning({ id: evaluations.id });
    const passedOrFailed = r.status === 'passed' || r.status === 'failed';
    await tx.insert(scores).values({
      evaluationId: evaluation!.id,
      key: 'answer',
      type: 'json_match',
      status: r.status,
      isPrimary: true,
      score: passedOrFailed ? (r.score ?? (r.status === 'passed' ? 1 : 0)) : null,
      comment: r.status,
      scorerVersion: 1,
    });
    await tx
      .update(evaluations)
      .set({ status: 'completed', finishedAt })
      .where(eq(evaluations.id, evaluation!.id));
    await tx.update(runs).set({ status: 'scored', finishedAt }).where(eq(runs.id, runId));
  });
}

export interface ErroredRun {
  startedAt: Date;
  durationS: number;
  category: ExecutionErrorCategory;
  message?: string;
  stderrTail?: string | null;
  tokens?: Tokens | null;
  costUsd?: number | null;
}

/** Runs a queued run into execution_error. */
export async function errored(db: AppDb, w: World, runId: string, r: ErroredRun): Promise<string> {
  const attemptId = await start(db, w, runId, r.startedAt);
  const finishedAt = new Date(r.startedAt.getTime() + r.durationS * 1000);
  await db.transaction(async (tx) => {
    await tx
      .update(attempts)
      .set({
        status: 'execution_error',
        finishedAt,
        exitCode: 1,
        errorCategory: r.category,
        errorMessage: r.message ?? `${r.category} error`,
        stderrTail: r.stderrTail ?? null,
        tokens: r.tokens ?? null,
        durationMs: r.durationS * 1000,
        costUsd: r.costUsd ?? null,
      })
      .where(eq(attempts.id, attemptId));
    await tx.update(runs).set({ status: 'execution_error', finishedAt }).where(eq(runs.id, runId));
  });
  return attemptId;
}

/** Cancels a queued run. */
export async function cancelled(db: AppDb, runId: string, finishedAt: Date): Promise<void> {
  await db.update(runs).set({ status: 'cancelled', finishedAt }).where(eq(runs.id, runId));
}

export async function pause(
  db: AppDb,
  experimentId: string,
  reason: PauseReason,
  pausedAt: Date,
): Promise<void> {
  await db
    .update(experiments)
    .set({ status: 'paused', pauseReason: reason, pausedAt })
    .where(eq(experiments.id, experimentId));
}

export async function fail(
  db: AppDb,
  experimentId: string,
  failure: ExperimentFailure,
): Promise<void> {
  await db
    .update(experiments)
    .set({ status: 'failed', failure, finishedAt: new Date(failure.at) })
    .where(eq(experiments.id, experimentId));
}

export async function complete(
  db: AppDb,
  experimentId: string,
  finishedAt: Date,
  cancelledAt: Date | null = null,
): Promise<void> {
  await db
    .update(experiments)
    .set({ status: 'completed', finishedAt, cancelledAt })
    .where(eq(experiments.id, experimentId));
}

/**
 * 2 tasks (a, b) x baseline and candidate x 2 repetitions, both models priced:
 *
 *   a/base/1 scored passed      10 s   1000 tok  $0.01   ends at 10
 *   a/base/2 scored failed      20 s   2000 tok  $0.02   ends at 25
 *   b/base/1 execution_error     5 s   provider, no tokens, no cost, ends at 15
 *   b/base/2 running since 30, events at 31 and 60
 *   a/cand/1 scored passed      30 s   3000 tok  $0.03   ends at 30
 *   a/cand/2 scored ungradable  40 s   4000 tok  $0.04   ends at 50
 *   b/cand/1, b/cand/2 queued
 */
export async function seedMatrix(db: AppDb, w: World) {
  const { experiment, run } = await launch(db, w, { concurrency: 2 });
  await scored(db, w, run('a/base/1'), {
    startedAt: at(0),
    durationS: 10,
    status: 'passed',
    tokens: tokens(1000),
    costUsd: 0.01,
  });
  await scored(db, w, run('a/base/2'), {
    startedAt: at(5),
    durationS: 20,
    status: 'failed',
    tokens: tokens(2000),
    costUsd: 0.02,
  });
  await errored(db, w, run('b/base/1'), { startedAt: at(10), durationS: 5, category: 'provider' });
  const live = await start(db, w, run('b/base/2'), at(30));
  await events(db, live, [at(31), at(60)]);
  await scored(db, w, run('a/cand/1'), {
    startedAt: at(0),
    durationS: 30,
    status: 'passed',
    tokens: tokens(3000),
    costUsd: 0.03,
  });
  await scored(db, w, run('a/cand/2'), {
    startedAt: at(10),
    durationS: 40,
    status: 'ungradable',
    tokens: tokens(4000),
    costUsd: 0.04,
  });
  return { experiment, run };
}
