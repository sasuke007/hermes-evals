/**
 * Builds a small, valid object graph: one suite version with one task, a
 * baseline and a candidate configuration, a worker, and an experiment with
 * 1 task x 2 configurations x 2 repetitions = 4 queued runs.
 */
import { createHash } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PriceTable, SelfCheck, VerificationEntry } from '@hermes-evals/shared';
import {
  attempts,
  blobs,
  configurations,
  evaluations,
  experiments,
  runs,
  scores,
  suiteSources,
  suites,
  taskFiles,
  tasks,
  workers,
} from '../../src/database/schema/index.js';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { newId } from '../../src/database/ids.js';
import type * as schema from '../../src/database/schema/index.js';

/** Any Drizzle Postgres database over our schema: PGlite in unit tests, node-postgres in e2e. */
type TestDb = PgDatabase<PgQueryResultHKT, typeof schema>;

export const sha = (content: string): string => createHash('sha256').update(content).digest('hex');

export const HERMES_REVISION = '4d04303818b61bf3aa09278af48356315515965b';

/** Registers a blob for `content` (as the blob store would after writing the file) and returns its hash. */
export async function blob(db: TestDb, content: string): Promise<string> {
  const hash = sha(content);
  await db
    .insert(blobs)
    .values({ sha256: hash, size: Buffer.byteLength(content) })
    .onConflictDoNothing();
  return hash;
}

/** Columns that put an evaluation in the running state with a fresh claim. */
export const runningClaim = () => ({
  status: 'running' as const,
  startedAt: new Date(),
  claimToken: crypto.randomUUID(),
  claimExpiresAt: new Date(Date.now() + 600_000),
});

const PRICE_TABLE: PriceTable = {
  sha256: sha('prices'),
  loaded_at: '2026-10-23T09:00:00.000Z',
  models: {
    'openai/gpt-6.1-sol': { input_per_1m: 1.25, output_per_1m: 10, checked_at: '2026-10-20' },
  },
};

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
      comment: 'matches',
    },
  ],
};

const VERIFICATION: VerificationEntry[] = [
  { key: 'answer', type: 'json_match', primary: true, params: { path: 'duplicates' } },
];

const TASK_YAML = `summary: Find invoices billed twice
limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: [file] }
verification:
  - key: answer
    type: json_match
    primary: true
    params: { path: duplicates }
`;

export async function seedExperiment(db: TestDb) {
  const [suite] = await db
    .insert(suites)
    .values({
      sourcePath: 'invoices-v1',
      versionNumber: 1,
      name: 'invoices-v1',
      versionLabel: '1',
      contentHash: sha('suite v1'),
      checkHash: sha('checks v1'),
      taskCount: 1,
      validCount: 1,
    })
    .returning();
  await db.insert(suiteSources).values({
    path: 'invoices-v1',
    name: 'invoices-v1',
    currentSuiteId: suite!.id,
    lastOutcome: 'created',
  });
  const [task] = await db
    .insert(tasks)
    .values({
      suiteId: suite!.id,
      key: 'dup_invoices',
      versionNumber: 1,
      introducedInSuiteId: suite!.id,
      position: 0,
      summary: 'Find invoices billed twice',
      prompt: 'Find duplicates. Reply with a fenced JSON block.',
      limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file'] },
      // A JSON string that looks like a number: must read back as a string.
      reference: '1042',
      verification: VERIFICATION,
      taskYaml: TASK_YAML,
      selfCheck: SELF_CHECK,
      valid: true,
      contentHash: sha('task dup_invoices'),
    })
    .returning();
  await db.insert(taskFiles).values({
    taskId: task!.id,
    path: 'fixtures/invoices.csv',
    kind: 'fixture',
    sha256: await blob(db, 'invoices.csv'),
    size: 2048,
  });

  const versionIds: string[] = [];
  for (const name of ['baseline', 'with-skill']) {
    // A configuration and its version 1 are created together: latest_version must resolve at commit.
    // Raw SQL naming only these columns, so the upgrade specs can seed a database
    // migrated before 0008 (skill_loading): Drizzle's insert names every column.
    const version = await db.transaction(async (tx) => {
      const [configuration] = await tx.insert(configurations).values({ name }).returning();
      const id = newId();
      await tx.execute(sql`
        insert into configuration_versions
          (id, configuration_id, version, model, provider, toolsets, max_turns, time_budget_s, config_hash, frozen_at)
        values (${id}, ${configuration!.id}, 1, 'openai/gpt-6.1-sol', 'nous', ${sql.raw(`'{file,terminal}'`)},
          20, 300, ${sha(`config ${name}`)}, now())`);
      return { id };
    });
    versionIds.push(version.id);
  }
  const [baselineVersionId, candidateVersionId] = versionIds as [string, string];

  const [worker] = await db
    .insert(workers)
    .values({
      hostname: 'worker-1',
      concurrency: 3,
      slots: 4,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      toolsets: ['file', 'terminal', 'web'],
      envNames: ['NOUS_API_KEY', 'PATH'],
    })
    .returning();

  const [experiment] = await db
    .insert(experiments)
    .values({
      name: 'Skill vs no skill',
      suiteId: suite!.id,
      taskIds: [task!.id],
      baselineVersionId,
      candidateVersionIds: [candidateVersionId],
      repetitions: 2,
      concurrency: 2,
      spendCeilingUsd: 5,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      priceTable: PRICE_TABLE,
    })
    .returning();

  const runRows = await db
    .insert(runs)
    .values(
      [baselineVersionId, candidateVersionId].flatMap((configurationVersionId) =>
        [1, 2].map((repetition) => ({
          experimentId: experiment!.id,
          taskId: task!.id,
          configurationVersionId,
          repetition,
        })),
      ),
    )
    .returning();

  return {
    suite: suite!,
    task: task!,
    worker: worker!,
    experiment: experiment!,
    baselineVersionId,
    candidateVersionId,
    runs: runRows,
  };
}

/** Claims a queued run the way the worker does: new attempt plus run pointer, in one transaction. */
export async function startAttempt(
  db: TestDb,
  runId: string,
  workerId: string,
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
        workerId,
        trialPath: `trials/${runId}/a${number}`,
      })
      .returning({ id: attempts.id });
    const claimed = await tx
      .update(runs)
      .set({
        status: 'running',
        attemptCount: number,
        currentAttemptId: attempt!.id,
        finishedAt: null,
      })
      .where(and(eq(runs.id, runId), eq(runs.status, 'queued')))
      .returning({ id: runs.id });
    if (claimed.length !== 1) throw new Error(`run ${runId} was not queued`);
    return attempt!.id;
  });
}

/** Finishes a running attempt as executed and moves its run to executed. */
export async function finishAttempt(db: TestDb, runId: string, attemptId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(attempts)
      .set({
        status: 'executed',
        finishedAt: new Date(),
        exitCode: 0,
        finalText: 'Done.\n```json\n{"duplicates": []}\n```',
        tokens: { input: 1200, output: 300, total: 1500, cache_read: 0, cache_write: 0 },
        durationMs: 4200,
        costUsd: 0.0045,
      })
      .where(eq(attempts.id, attemptId));
    await tx.update(runs).set({ status: 'executed' }).where(eq(runs.id, runId));
  });
}

/**
 * Re-scores a scored run whose task has the single key `answer` (as every
 * seed with one primary json_match key does), the way publish.ts publishes a
 * re-score: the next generation claimed, its primary written with `status`,
 * the current result superseded, then completed. The run stays scored, and
 * the superseded generation keeps its rows. Resolves the new evaluation id.
 */
export async function rescoreRun(
  db: TestDb,
  runId: string,
  status: 'passed' | 'failed',
): Promise<string> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ attemptId: runs.currentAttemptId })
      .from(runs)
      .where(eq(runs.id, runId));
    const prior = await tx
      .select({ generation: evaluations.generation })
      .from(evaluations)
      .where(eq(evaluations.runId, runId));
    const [evaluation] = await tx
      .insert(evaluations)
      .values({
        runId,
        attemptId: run!.attemptId!,
        cause: 'rescore',
        generation: Math.max(0, ...prior.map((p) => p.generation)) + 1,
        ...runningClaim(),
      })
      .returning({ id: evaluations.id });
    await tx.insert(scores).values({
      evaluationId: evaluation!.id,
      key: 'answer',
      type: 'json_match',
      status,
      isPrimary: true,
      score: status === 'passed' ? 1 : 0,
      comment: `re-scored ${status}`,
      scorerVersion: 1,
    });
    await tx
      .update(evaluations)
      .set({ supersededAt: new Date() })
      .where(
        and(
          eq(evaluations.runId, runId),
          eq(evaluations.status, 'completed'),
          isNull(evaluations.supersededAt),
        ),
      );
    await tx
      .update(evaluations)
      .set({ status: 'completed', finishedAt: new Date() })
      .where(eq(evaluations.id, evaluation!.id));
    return evaluation!.id;
  });
}
