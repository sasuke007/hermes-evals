/**
 * Where a configuration was used, read from real experiment, run,
 * evaluation and score rows (seedExperiment: one task, baseline and
 * with-skill at v1, two repetitions each).
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationDetailSchema, ConfigurationListRowSchema } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import {
  finishAttempt,
  rescoreRun,
  runningClaim,
  seedExperiment,
  startAttempt,
} from '../../test/support/seed.js';
import { configurationVersions, evaluations, runs, scores } from '../database/schema/index.js';
import { ConfigurationReadsService } from './configuration-reads.service.js';
import { ConfigurationWritesService } from './configuration-writes.service.js';
import { configurationInput as input } from './support-spec.js';

let t: TestDatabase;
let reads: ConfigurationReadsService;
let seed: Awaited<ReturnType<typeof seedExperiment>>;

beforeEach(async () => {
  t = await createTestDatabase();
  seed = await seedExperiment(t.db);
  reads = new ConfigurationReadsService(t.db);
});

afterEach(async () => {
  await t.close();
});

const configurationOf = async (versionId: string) => {
  const [row] = await t.db
    .select({ id: configurationVersions.configurationId })
    .from(configurationVersions)
    .where(eq(configurationVersions.id, versionId));
  return row!.id;
};

/** Executes a run and publishes a score set whose primary key has `status`. */
async function score(runId: string, status: 'passed' | 'failed') {
  const attemptId = await startAttempt(t.db, runId, seed.worker.id);
  await finishAttempt(t.db, runId, attemptId);
  const [evaluation] = await t.db
    .insert(evaluations)
    .values({ runId, attemptId, cause: 'initial', generation: 1, ...runningClaim() })
    .returning({ id: evaluations.id });
  await t.db.insert(scores).values({
    evaluationId: evaluation!.id,
    key: 'answer',
    type: 'json_match',
    status,
    isPrimary: true,
    score: status === 'passed' ? 1 : 0,
    comment: status,
    scorerVersion: 1,
  });
  await t.db.transaction(async (tx) => {
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

const runOf = (versionId: string, repetition: number) =>
  seed.runs.find((r) => r.configurationVersionId === versionId && r.repetition === repetition)!;

describe('usage', () => {
  it('lists each experiment with the arm this configuration plays in it', async () => {
    await score(runOf(seed.baselineVersionId, 1).id, 'passed');
    await score(runOf(seed.baselineVersionId, 2).id, 'failed');
    await score(runOf(seed.candidateVersionId, 1).id, 'passed');

    const baseline = ConfigurationDetailSchema.parse(
      await reads.detail(await configurationOf(seed.baselineVersionId)),
    );
    expect(baseline.latest.experimentCount).toBe(1);
    expect(baseline.usedIn).toEqual([
      {
        experimentId: seed.experiment.id,
        experimentName: 'Skill vs no skill',
        role: 'baseline',
        status: 'running',
        version: 1,
        repetitions: 2,
        passRate: 0.5,
        scored: 2,
        total: 2,
        verdict: null,
        verdictReason: null,
        baselinePassRate: null,
        taskCount: 1,
        delta: null,
      },
    ]);

    const candidate = ConfigurationDetailSchema.parse(
      await reads.detail(await configurationOf(seed.candidateVersionId)),
    );
    expect(candidate.usedIn).toEqual([
      expect.objectContaining({
        role: 'candidate',
        passRate: 1,
        scored: 1,
        total: 2,
        // One task: no verdict, even once it completes (a verdict needs 3 tasks).
        verdict: 'not_computable',
        verdictReason: 'too_few_tasks',
        baselinePassRate: 0.5,
        // For "No interval (1 task)"; the provisional Δ is 1 − 0.5 on the one task.
        taskCount: 1,
        delta: 0.5,
      }),
    ]);

    const rows = ConfigurationListRowSchema.array().parse(await reads.list());
    expect(rows.map((r) => r.usedInExperiments)).toEqual([1, 1]);
  });

  it('counts a re-scored run once, with its current result', async () => {
    await score(runOf(seed.baselineVersionId, 1).id, 'passed');
    await score(runOf(seed.baselineVersionId, 2).id, 'failed');
    // Baseline's pass becomes a fail; its fail is re-scored twice and stays one.
    await rescoreRun(t.db, runOf(seed.baselineVersionId, 1).id, 'failed');
    await rescoreRun(t.db, runOf(seed.baselineVersionId, 2).id, 'failed');
    await rescoreRun(t.db, runOf(seed.baselineVersionId, 2).id, 'failed');

    const baseline = ConfigurationDetailSchema.parse(
      await reads.detail(await configurationOf(seed.baselineVersionId)),
    );
    expect(baseline.usedIn).toEqual([
      expect.objectContaining({ role: 'baseline', passRate: 0, scored: 2, total: 2 }),
    ]);
  });

  it('reports nothing scored yet as no pass rate and a verdict that cannot be computed', async () => {
    const candidate = await reads.detail(await configurationOf(seed.candidateVersionId));
    expect(candidate.usedIn[0]).toMatchObject({
      passRate: null,
      scored: 0,
      total: 2,
      verdict: 'not_computable',
      baselinePassRate: null,
    });
  });

  it('keeps the used version for its experiments when an edit creates the next one', async () => {
    const configurationId = await configurationOf(seed.baselineVersionId);
    const writes = new ConfigurationWritesService(t.db);
    const draft = await reads.editDraft(configurationId);
    expect(draft).toMatchObject({
      createsNewVersion: true,
      nextVersion: 2,
      experimentsKeepingVersion: [{ id: seed.experiment.id, name: 'Skill vs no skill' }],
    });
    const saved = await writes.update(configurationId, input({ maxTurns: 40 }));
    expect(saved).toMatchObject({ version: 2, createdNewVersion: true });

    const shown = await reads.detail(configurationId);
    expect(shown.latest).toMatchObject({
      version: 2,
      experimentCount: 0,
      change: 'changed max turns',
    });
    expect(shown.versions.find((v) => v.version === 1)).toMatchObject({ experimentCount: 1 });
    expect(shown.usedIn.map((u) => [u.experimentId, u.version])).toEqual([[seed.experiment.id, 1]]);
    // The new version has not been used yet, so its draft has nobody keeping it.
    expect(await reads.editDraft(configurationId)).toMatchObject({
      createsNewVersion: false,
      experimentsKeepingVersion: [],
    });
  });
});
