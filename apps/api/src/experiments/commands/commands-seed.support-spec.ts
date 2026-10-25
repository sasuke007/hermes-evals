/**
 * Rows the experiment and run command tests build on, inserted the way the
 * loader, the configuration service and the worker store them: a suite
 * directory with versions, configurations with versions, workers, and the
 * worker's side of a run (claim, finish) as direct SQL. Works on PGlite and
 * on node-postgres. Test-only: the name ends in `spec.ts` so the build
 * leaves it out, but not in `.spec.ts`, so vitest does not run it.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ExecutionErrorCategory, Provider, SelfCheck, Tokens } from '@hermes-evals/shared';
import { HERMES_REVISION, sha } from '../../../test/support/seed.js';
import {
  attempts,
  configurations,
  configurationVersions,
  experiments,
  runs,
  suiteSources,
  suites,
  tasks,
  workers,
} from '../../database/schema/index.js';
import type { WorkerSandbox } from '../../database/schema/worker-sandbox.js';
import type { AppDb } from '../../database/types.js';

export { HERMES_REVISION, sha };

/** The scripted mock model every Phase 2 check runs against (provider custom). */
export const MOCK_MODEL = 'mock/scripted';
export const MOCK_BASE_URL = 'http://mock-model:8090/v1';

const SELF_CHECK: SelfCheck = {
  status: 'passed',
  ran_at: '2026-10-24T09:00:00.000Z',
  duration_ms: 5,
  results: [],
};

export interface TaskSeed {
  key: string;
  /** Default true. */
  valid?: boolean;
  /** Changes the content hash, as an edit would. Default 'v1'. */
  content?: string;
  versionNumber?: number;
  budgetS?: number;
}

export interface SeededSuite {
  id: string;
  sourcePath: string;
  versionNumber: number;
  /** Task id by key. */
  taskIds: Map<string, string>;
}

/**
 * One version of a suite directory, made current. The first call for a
 * directory creates its suite_sources row; later calls move its pointer.
 */
export async function seedSuite(
  db: AppDb,
  options: { sourcePath?: string; versionNumber?: number; tasks: TaskSeed[] },
): Promise<SeededSuite> {
  const sourcePath = options.sourcePath ?? 'invoices-v1';
  const versionNumber = options.versionNumber ?? 1;
  const valid = options.tasks.filter((t) => t.valid !== false).length;
  const [suite] = await db
    .insert(suites)
    .values({
      sourcePath,
      versionNumber,
      name: sourcePath,
      versionLabel: String(versionNumber),
      contentHash: sha(`${sourcePath} v${versionNumber} content`),
      checkHash: sha(`${sourcePath} v${versionNumber} checks`),
      taskCount: options.tasks.length,
      validCount: valid,
    })
    .returning();
  const taskIds = new Map<string, string>();
  for (const [position, task] of options.tasks.entries()) {
    const isValid = task.valid !== false;
    const budget = task.budgetS ?? 300;
    const [row] = await db
      .insert(tasks)
      .values({
        suiteId: suite!.id,
        key: task.key,
        versionNumber: task.versionNumber ?? 1,
        introducedInSuiteId: suite!.id,
        position,
        summary: `Task ${task.key}`,
        prompt: isValid ? `Solve ${task.key}. Reply with a fenced JSON block.` : null,
        limits: isValid
          ? { max_turns: 20, run_budget_seconds: budget, toolsets_needed: ['file'] }
          : null,
        reference: isValid ? { answer: 42 } : null,
        verification: [
          { key: 'answer', type: 'exact_match', primary: true, params: { path: 'answer' } },
        ],
        taskYaml: `summary: Task ${task.key}\n`,
        selfCheck: SELF_CHECK,
        valid: isValid,
        invalidReason: isValid ? null : 'self-check failed: the reference does not pass',
        contentHash: sha(`${task.key} ${task.content ?? 'v1'}`),
      })
      .returning({ id: tasks.id });
    taskIds.set(task.key, row!.id);
  }
  await db
    .insert(suiteSources)
    .values({
      path: sourcePath,
      name: sourcePath,
      currentSuiteId: suite!.id,
      lastOutcome: 'created',
    })
    .onConflictDoUpdate({
      target: suiteSources.path,
      set: { currentSuiteId: suite!.id, lastOutcome: 'created' },
    });
  return { id: suite!.id, sourcePath, versionNumber, taskIds };
}

export interface ConfigSeed {
  provider?: Provider;
  model?: string;
  timeBudgetS?: number;
  /** Feeds the config hash; two configurations with the same `settings` share a hash. */
  settings?: string;
}

export interface SeededConfiguration {
  configurationId: string;
  versionId: string;
  version: number;
  configHash: string;
}

const versionValues = (seed: ConfigSeed, name: string) => {
  const provider = seed.provider ?? 'custom';
  return {
    model: seed.model ?? MOCK_MODEL,
    provider,
    baseUrl: provider === 'custom' ? MOCK_BASE_URL : null,
    toolsets: ['file', 'terminal'],
    maxTurns: 20,
    timeBudgetS: seed.timeBudgetS ?? 120,
    configHash: sha(`config ${seed.settings ?? name}`),
  };
};

/** A configuration and its version 1, unfrozen, as POST /configurations stores them. */
export async function seedConfiguration(
  db: AppDb,
  name: string,
  seed: ConfigSeed = {},
): Promise<SeededConfiguration> {
  return db.transaction(async (tx) => {
    const [configuration] = await tx.insert(configurations).values({ name }).returning();
    const values = versionValues(seed, name);
    const [version] = await tx
      .insert(configurationVersions)
      .values({ configurationId: configuration!.id, version: 1, ...values })
      .returning();
    return {
      configurationId: configuration!.id,
      versionId: version!.id,
      version: 1,
      configHash: values.configHash,
    };
  });
}

/** The next version of a configuration, as saving an edit of a frozen version does. */
export async function seedNextVersion(
  db: AppDb,
  configurationId: string,
  name: string,
  seed: ConfigSeed,
): Promise<SeededConfiguration> {
  return db.transaction(async (tx) => {
    const [configuration] = await tx
      .select()
      .from(configurations)
      .where(eq(configurations.id, configurationId))
      .for('update');
    const next = configuration!.latestVersion + 1;
    const values = versionValues(seed, name);
    const [version] = await tx
      .insert(configurationVersions)
      .values({ configurationId, version: next, ...values })
      .returning();
    await tx
      .update(configurations)
      .set({ latestVersion: next })
      .where(eq(configurations.id, configurationId));
    return {
      configurationId,
      versionId: version!.id,
      version: next,
      configHash: values.configHash,
    };
  });
}

export interface WorkerSeed {
  /** Isolation self-test passed. Default true. */
  proven?: boolean;
  revision?: string;
  concurrency?: number;
  slots?: number | null;
  /** Seconds since the last heartbeat. Default 0 (live). */
  silentS?: number;
  egressEnvNames?: string[];
}

const sandbox = (proven: boolean, revision: string): WorkerSandbox => ({
  state: proven ? 'isolated' : 'failed',
  checks: [{ id: 'no-default-route', name: 'has no default route', passed: proven, detail: 'ok' }],
  checked_at: '2026-10-24T09:00:00.000Z',
  image: 'hermes-evals/trial:v0.22.4-4d04303',
  revision,
});

/** A worker row, as WorkerPresenceService inserts and heartbeats it. */
export async function seedWorker(db: AppDb, seed: WorkerSeed = {}): Promise<string> {
  const revision = seed.revision ?? HERMES_REVISION;
  const [row] = await db
    .insert(workers)
    .values({
      hostname: 'worker-test',
      concurrency: seed.concurrency ?? 3,
      slots: seed.slots === undefined ? 4 : seed.slots,
      hermesVersion: '0.22.4',
      hermesRevision: revision,
      toolsets: ['file', 'terminal'],
      egressEnvNames: seed.egressEnvNames ?? [],
      sandbox: sandbox(seed.proven ?? true, revision),
      lastHeartbeatAt: sql`now() - (${seed.silentS ?? 0})::float8 * interval '1 second'`,
    })
    .returning({ id: workers.id });
  return row!.id;
}

/** The worker's claim: attempt n running, the run running and pointing at it. */
export async function claimRun(db: AppDb, runId: string, workerId: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    await tx
      .select({ id: experiments.id })
      .from(experiments)
      .where(eq(experiments.id, run!.experimentId))
      .for('no key update');
    const number = run!.attemptCount + 1;
    const [attempt] = await tx
      .insert(attempts)
      .values({
        runId,
        number,
        trigger: number === 1 ? 'initial' : 'user_retry',
        status: 'running',
        workerId,
        trialPath: `trials/${runId}/a${number}`,
      })
      .returning({ id: attempts.id });
    // As the real claim: the run's recorded next trigger is used up.
    const claimed = await tx
      .update(runs)
      .set({
        status: 'running',
        attemptCount: number,
        currentAttemptId: attempt!.id,
        nextTrigger: null,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, 'queued')))
      .returning({ id: runs.id });
    if (claimed.length !== 1) throw new Error(`run ${runId} was not queued`);
    return attempt!.id;
  });
}

export interface FinishSeed {
  status: 'executed' | 'execution_error';
  category?: ExecutionErrorCategory;
  durationMs?: number;
  tokens?: Tokens | null;
  costUsd?: number | null;
}

/**
 * The worker's finish: the attempt ends, and the run becomes executed or
 * execution_error. Locks experiment, run and attempt in that order.
 */
export async function finishRun(
  db: AppDb,
  runId: string,
  attemptId: string,
  seed: FinishSeed,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    await tx
      .select({ id: experiments.id })
      .from(experiments)
      .where(eq(experiments.id, run!.experimentId))
      .for('no key update');
    await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for('no key update');
    const executed = seed.status === 'executed';
    await tx
      .update(attempts)
      .set({
        status: seed.status,
        finishedAt: sql`now()`,
        exitCode: executed ? 0 : 1,
        errorCategory: executed ? null : (seed.category ?? 'other'),
        errorMessage: executed ? null : 'it broke',
        finalText: executed ? '```json\n{"answer": 42}\n```' : null,
        tokens:
          seed.tokens === undefined
            ? { input: 1000, output: 200, total: 1200, cache_read: 0, cache_write: 0 }
            : seed.tokens,
        durationMs: seed.durationMs ?? 20_000,
        costUsd: seed.costUsd ?? null,
      })
      .where(eq(attempts.id, attemptId));
    await tx
      .update(runs)
      .set(
        executed ? { status: 'executed' } : { status: 'execution_error', finishedAt: sql`now()` },
      )
      .where(eq(runs.id, runId));
  });
}

/**
 * The worker's finish after a cancel request: it stopped the container, so
 * the attempt and the run end cancelled. Locks experiment, run and attempt
 * in that order, like finishRun.
 */
export async function finishCancelled(db: AppDb, runId: string, attemptId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    await tx
      .select({ id: experiments.id })
      .from(experiments)
      .where(eq(experiments.id, run!.experimentId))
      .for('no key update');
    await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for('no key update');
    await tx
      .update(attempts)
      .set({ status: 'cancelled', finishedAt: sql`now()`, durationMs: 5_000 })
      .where(eq(attempts.id, attemptId));
    await tx
      .update(runs)
      .set({ status: 'cancelled', finishedAt: sql`now()` })
      .where(eq(runs.id, runId));
  });
}

/** Moves an executed run straight to scored, as if its scores were published. */
export async function markScored(db: AppDb, runId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    await tx
      .select({ id: experiments.id })
      .from(experiments)
      .where(eq(experiments.id, run!.experimentId))
      .for('no key update');
    await tx
      .update(runs)
      .set({ status: 'scored', finishedAt: sql`now()` })
      .where(eq(runs.id, runId));
  });
}

/** Runs of an experiment, ordered by id. */
export const runsOf = (db: AppDb, experimentId: string) =>
  db.select().from(runs).where(eq(runs.experimentId, experimentId)).orderBy(runs.id);

export async function experimentRow(db: AppDb, id: string) {
  const [row] = await db.select().from(experiments).where(eq(experiments.id, id));
  return row!;
}
