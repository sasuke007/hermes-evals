/**
 * What the re-score specs build on, over the command app (PGlite or
 * Postgres 17): a run taken to `scored` the way the pipeline does it (the
 * finish queues generation 1 with its evaluate-run job, a worker grades and
 * publishes it with the real handler), a task with an llm_judge key, and the
 * reads that check what each evaluation became. Test-only (see
 * experiments/commands/commands-seed.support-spec.ts).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { asc, eq } from 'drizzle-orm';
import { vi } from 'vitest';
import { LaunchExperimentResultSchema, type VerificationEntry } from '@hermes-evals/shared';
import { sha } from '../../../test/support/seed.js';
import type { Env } from '../../config/env.js';
import { evaluations, experiments, runs, scores, tasks } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import {
  handleEvaluateRunJob,
  type EvaluateRunOutcome,
  type EvaluationLogger,
} from '../../evaluation/evaluate-run.handler.js';
import { queueEvaluation } from '../../evaluation/job.js';
import type {
  CommandsApp,
  Launched,
} from '../../experiments/commands/commands-app.support-spec.js';
import {
  claimRun,
  finishRun,
  seedConfiguration,
  seedSuite,
  seedWorker,
} from '../../experiments/commands/commands-seed.support-spec.js';
import { QUEUES, type EvaluateRunJob } from '../../queue/queues.js';
import { BlobStore } from '../../storage/blob-store.js';

export const quietLogger = (): EvaluationLogger =>
  ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) as unknown as EvaluationLogger;

/** A blob store over a temp directory, for the scorers' scratch directories. */
export async function scratchStore(): Promise<{
  store: BlobStore;
  dispose: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-evals-rescore-'));
  return { store: new BlobStore(dir), dispose: () => rm(dir, { recursive: true, force: true }) };
}

/**
 * Runs a queued run to `executed` (its answer `{"answer": 42}`) and queues
 * generation 1 with its job in the finish's transaction, locking the
 * experiment, then the run.
 */
export async function executeRun(
  c: CommandsApp,
  runId: string,
  workerId: string,
): Promise<{ attemptId: string; evaluationId: string }> {
  const attemptId = await claimRun(c.t.db, runId, workerId);
  await finishRun(c.t.db, runId, attemptId, { status: 'executed' });
  const { evaluationId } = await c.t.db.transaction(async (tx) => {
    const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
    await tx
      .select({ id: experiments.id })
      .from(experiments)
      .where(eq(experiments.id, run!.experimentId))
      .for('no key update');
    await tx.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).for('no key update');
    return queueEvaluation(c.boss, tx, { runId, attemptId, cause: 'initial' });
  });
  return { attemptId, evaluationId };
}

/** One delivery of evaluate-run for `evaluationId`, as a worker runs it. */
export async function grade(
  db: AppDb,
  store: BlobStore,
  evaluationId: string,
): Promise<EvaluateRunOutcome> {
  const job: EvaluateRunJob = { evaluationId };
  return (await handleEvaluateRunJob(job, { db, store }, quietLogger())).outcome;
}

/** Runs a queued run all the way to `scored` with a published generation 1. */
export async function scoreRun(
  c: CommandsApp,
  store: BlobStore,
  runId: string,
  workerId: string,
): Promise<{ attemptId: string; evaluationId: string }> {
  const executed = await executeRun(c, runId, workerId);
  const outcome = await grade(c.t.db, store, executed.evaluationId);
  if (outcome !== 'published') throw new Error(`generation 1 of ${runId} was ${outcome}`);
  return executed;
}

/** A run's evaluations, oldest generation first, without their answers. */
export const evaluationsOf = (db: AppDb, runId: string) =>
  db
    .select({
      id: evaluations.id,
      generation: evaluations.generation,
      cause: evaluations.cause,
      status: evaluations.status,
      supersededAt: evaluations.supersededAt,
      error: evaluations.error,
    })
    .from(evaluations)
    .where(eq(evaluations.runId, runId))
    .orderBy(asc(evaluations.generation));

/** The score rows of one evaluation, by key. */
export const scoresOf = (db: AppDb, evaluationId: string) =>
  db
    .select({
      key: scores.key,
      status: scores.status,
      scorerVersion: scores.scorerVersion,
    })
    .from(scores)
    .where(eq(scores.evaluationId, evaluationId))
    .orderBy(asc(scores.key));

/** Every evaluate-run job, by its singleton key (the evaluation id). */
export async function evaluateRunJobKeys(c: CommandsApp): Promise<string[]> {
  const jobs = await c.boss.findJobs<EvaluateRunJob>(QUEUES.evaluateRun, { limit: 100_000 });
  return jobs.map((j) => j.singletonKey ?? '').sort();
}

/** The keys of a task graded with an exact_match primary and an LLM judge. */
export const JUDGED_VERIFICATION: VerificationEntry[] = [
  { key: 'answer', type: 'exact_match', primary: true, params: { path: 'answer' } },
  {
    key: 'method',
    type: 'llm_judge',
    primary: false,
    params: { rubric: 'rubric.md', model: 'judge/model' },
  },
];

/** The same task with a judge key that names no model: only JUDGE_MODEL can grade it. */
export const UNMODELLED_VERIFICATION: VerificationEntry[] = [
  { key: 'answer', type: 'exact_match', primary: true, params: { path: 'answer' } },
  { key: 'tone', type: 'llm_judge', primary: false, params: { rubric: 'rubric.md' } },
];

/**
 * Adds a valid task with an llm_judge key to a seeded suite version, as the
 * loader would have stored it with the others, so a launch can select it.
 */
export async function addJudgedTask(
  db: AppDb,
  suiteId: string,
  key = 'judged',
  { verification = JUDGED_VERIFICATION, position = 10 } = {},
): Promise<void> {
  await db.insert(tasks).values({
    suiteId,
    key,
    versionNumber: 1,
    introducedInSuiteId: suiteId,
    position,
    summary: `Task ${key}`,
    prompt: `Solve ${key}. Reply with a fenced JSON block.`,
    limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file'] },
    reference: { answer: 42 },
    verification,
    taskYaml: `summary: Task ${key}\n`,
    selfCheck: { status: 'passed', ran_at: null, duration_ms: null, results: [] },
    valid: true,
    contentHash: sha(`${key} judged`),
  });
}

/**
 * Launches, through the API, an experiment of `alpha` (exact_match only) and
 * `judged` (with the llm_judge key) under two custom configurations, one
 * repetition each, with a proven worker; like `launched`, plus the judge.
 */
export async function launchedWithJudge(
  c: CommandsApp,
  verification: VerificationEntry[] = JUDGED_VERIFICATION,
): Promise<Launched> {
  const suite = await seedSuite(c.t.db, { tasks: [{ key: 'alpha' }] });
  await addJudgedTask(c.t.db, suite.id, 'judged', { verification });
  const baseline = await seedConfiguration(c.t.db, 'baseline');
  const candidate = await seedConfiguration(c.t.db, 'with-skill');
  const workerId = await seedWorker(c.t.db);
  const res = await c
    .post('/experiments', {
      name: 'Judged',
      description: '',
      suiteId: suite.id,
      taskKeys: ['alpha', 'judged'],
      baselineVersionId: baseline.versionId,
      candidateVersionIds: [candidate.versionId],
      repetitions: 1,
      concurrency: 2,
      spendCeilingUsd: null,
      timeBudgetOverrideS: null,
      expectedConfigHashes: {
        [baseline.versionId]: baseline.configHash,
        [candidate.versionId]: candidate.configHash,
      },
    })
    .expect(201);
  return {
    id: LaunchExperimentResultSchema.parse(res.body).id,
    workerId,
    baseline,
    candidate,
    suite,
  };
}

/**
 * Sets one setting of the app's ConfigService for the rest of the test, as
 * a restarted api with that value in .env would read it; undefined unsets it.
 */
export function setSetting(c: CommandsApp, key: keyof Env, value: string | undefined): void {
  const config = c.app.get(ConfigService) as { get: (name: string) => unknown };
  const read = config.get.bind(config);
  config.get = (name: string) => (name === key ? value : read(name));
}
