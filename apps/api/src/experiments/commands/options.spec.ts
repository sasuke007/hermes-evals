/**
 * The New experiment reads and Duplicate over HTTP (plan 7.2 and 7.3,
 * UI_FLOWS 11): GET /experiments/new-options, GET /experiments/estimate and
 * POST /experiments/:id/duplicate, each answer parsed with its shared schema.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  ExperimentEstimateViewSchema,
  LaunchExperimentInputSchema,
  NewExperimentDraftSchema,
  NewExperimentOptionsSchema,
} from '@hermes-evals/shared';
import { configurationVersions, experiments } from '../../database/schema/index.js';
import { createCommandsApp, launched, type CommandsApp } from './commands-app.support-spec.js';
import {
  claimRun,
  finishRun,
  HERMES_REVISION,
  runsOf,
  seedConfiguration,
  seedNextVersion,
  seedSuite,
  seedWorker,
} from './commands-seed.support-spec.js';

let c: CommandsApp;

beforeEach(async () => {
  c = await createCommandsApp();
});

afterEach(() => c.close());

describe('GET /api/experiments/new-options', () => {
  it('offers current suites with every task, latest configurations with estimates, and worker limits', async () => {
    await seedSuite(c.t.db, { tasks: [{ key: 'alpha', budgetS: 600 }] });
    const v2 = await seedSuite(c.t.db, {
      versionNumber: 2,
      tasks: [
        { key: 'alpha', budgetS: 600 },
        { key: 'bravo', valid: false },
      ],
    });
    const base = await seedConfiguration(c.t.db, 'baseline', { timeBudgetS: 200 });
    const old = await seedConfiguration(c.t.db, 'priced', { model: 'test/priced' });
    const latest = await seedNextVersion(c.t.db, old.configurationId, 'priced', {
      model: 'test/priced',
      settings: 'priced v2',
    });
    await seedWorker(c.t.db, { concurrency: 2, slots: 4 });
    await seedWorker(c.t.db, { concurrency: 3, slots: null });
    await seedWorker(c.t.db, { proven: false });

    const options = NewExperimentOptionsSchema.parse(
      (await c.get('/experiments/new-options').expect(200)).body,
    );
    expect(options.suites).toHaveLength(1);
    expect(options.suites[0]).toMatchObject({
      suiteId: v2.id,
      versionNumber: 2,
      path: './suites/invoices-v1',
      taskCount: 2,
      validCount: 1,
      budgetS: 600,
      tasks: [
        {
          key: 'alpha',
          version: 1,
          summary: 'Task alpha',
          verificationCount: 1,
          valid: true,
          invalidReason: null,
        },
        {
          key: 'bravo',
          valid: false,
          invalidReason: 'self-check failed: the reference does not pass',
        },
      ],
    });
    expect(options.configurations.map((o) => [o.name, o.versionId])).toEqual([
      ['baseline', base.versionId],
      ['priced', latest.versionId],
    ]);
    expect(options.configurations[0]).toMatchObject({
      configHash: base.configHash,
      provider: 'custom',
      memoryEnabled: false,
      skills: [],
      mcpServers: [],
      estimates: {
        [v2.id]: { seconds: 50, costUsd: 0, tokens: 15_000, basis: 'budget', pastRuns: 0 },
      },
    });
    expect(options.configurations[1]!.estimates[v2.id]!.costUsd).toBe(0.033);
    expect(options).toMatchObject({
      defaults: { repetitions: 5, concurrency: 3 },
      maxConcurrency: 5,
      workerCount: 3,
    });
    expect(options.priceTable).toEqual([
      { model: 'mock/scripted', inputPer1M: 0, outputPer1M: 0, checkedAt: '2026-10-24' },
      { model: 'test/priced', inputPer1M: 1, outputPer1M: 10, checkedAt: '2026-10-24' },
    ]);
  });

  it('offers nothing to run on without a proven worker', async () => {
    const options = NewExperimentOptionsSchema.parse(
      (await c.get('/experiments/new-options').expect(200)).body,
    );
    expect(options).toMatchObject({
      suites: [],
      configurations: [],
      maxConcurrency: 0,
      workerCount: 0,
    });
  });
});

describe('GET /api/experiments/estimate', () => {
  it('estimates from the budget without history, then from past executed attempts', async () => {
    const x = await launched(c, { taskKeys: ['alpha', 'bravo', 'charlie'], repetitions: 2 });
    const query = `suite=${x.suite.id}&versions=${x.baseline.versionId},${x.candidate.versionId}&tasks=3&repetitions=2&concurrency=4`;
    const before = ExperimentEstimateViewSchema.parse(
      (await c.get(`/experiments/estimate?${query}`).expect(200)).body,
    );
    expect(before).toMatchObject({
      runs: 12,
      waves: 3,
      perRunSeconds: 30,
      durationS: 90,
      costUsd: 0,
      basis: 'budget',
      pastRuns: 0,
    });

    const baselineRuns = (await runsOf(c.t.db, x.id)).filter(
      (r) => r.configurationVersionId === x.baseline.versionId,
    );
    for (const [i, run] of baselineRuns.slice(0, 3).entries()) {
      const attempt = await claimRun(c.t.db, run.id, x.workerId);
      await finishRun(c.t.db, run.id, attempt, {
        status: 'executed',
        durationMs: (i + 1) * 10_000,
      });
    }
    const after = ExperimentEstimateViewSchema.parse(
      (await c.get(`/experiments/estimate?${query}`).expect(200)).body,
    );
    // The baseline's median is 20 s; the candidate has no history yet, so the basis stays budget.
    expect(after).toMatchObject({ perRunSeconds: 25, durationS: 75, basis: 'budget', pastRuns: 0 });

    const onlyBaseline = ExperimentEstimateViewSchema.parse(
      (
        await c
          .get(
            `/experiments/estimate?suite=${x.suite.id}&versions=${x.baseline.versionId}&tasks=3&repetitions=2&concurrency=4`,
          )
          .expect(200)
      ).body,
    );
    expect(onlyBaseline).toMatchObject({
      runs: 6,
      perRunSeconds: 20,
      basis: 'history',
      pastRuns: 3,
    });
  });

  it('matches history by config hash, so a renamed configuration with the same settings counts', async () => {
    const x = await launched(c);
    const [run] = await runsOf(c.t.db, x.id);
    const attempt = await claimRun(c.t.db, run!.id, x.workerId);
    await finishRun(c.t.db, run!.id, attempt, { status: 'executed', durationMs: 8000 });
    const twin = await seedConfiguration(c.t.db, 'renamed', {
      settings: run!.configurationVersionId === x.baseline.versionId ? 'baseline' : 'with-skill',
    });
    const view = ExperimentEstimateViewSchema.parse(
      (
        await c
          .get(
            `/experiments/estimate?suite=${x.suite.id}&versions=${twin.versionId}&tasks=1&repetitions=1&concurrency=1`,
          )
          .expect(200)
      ).body,
    );
    expect(view).toMatchObject({ perRunSeconds: 8, basis: 'history', pastRuns: 1 });
  });

  it('answers 400 for a bad query and 404 for what does not exist', async () => {
    const bad = await c
      .get('/experiments/estimate?suite=s&versions=&tasks=0&repetitions=21&concurrency=1')
      .expect(400);
    expect(ApiErrorBodySchema.parse(bad.body).issues?.map((i) => i.path)).toEqual([
      'versions',
      'tasks',
      'repetitions',
    ]);
    const suite = await seedSuite(c.t.db, { tasks: [{ key: 'alpha' }] });
    const none = await c
      .get(
        `/experiments/estimate?suite=${suite.id}&versions=cv_gone&tasks=1&repetitions=1&concurrency=1`,
      )
      .expect(404);
    expect(ApiErrorBodySchema.parse(none.body).message).toBe(
      'configuration version cv_gone not found',
    );
    await c
      .get(
        '/experiments/estimate?suite=suite_gone&versions=cv_gone&tasks=1&repetitions=1&concurrency=1',
      )
      .expect(404);
  });
});

describe('POST /api/experiments/:id/duplicate', () => {
  it("prefills the form on the suite's current version and lists what changed since", async () => {
    const x = await launched(c, { taskKeys: ['alpha', 'bravo', 'charlie', 'delta'] });
    const v2 = await seedSuite(c.t.db, {
      versionNumber: 2,
      tasks: [
        { key: 'alpha', content: 'edited', versionNumber: 2 },
        { key: 'bravo', valid: false },
        { key: 'delta' },
        { key: 'echo' },
      ],
    });
    const next = await seedNextVersion(c.t.db, x.baseline.configurationId, 'baseline', {
      settings: 'baseline v2',
    });

    const draft = NewExperimentDraftSchema.parse(
      (await c.post(`/experiments/${x.id}/duplicate`).expect(200)).body,
    );
    expect(draft).toEqual({
      sourceExperimentId: x.id,
      values: {
        name: 'Skill vs no skill',
        description: 'Does the skill help?',
        suiteId: v2.id,
        taskKeys: ['alpha', 'delta'],
        baselineVersionId: next.versionId,
        candidateVersionIds: [x.candidate.versionId],
        repetitions: 1,
        concurrency: 2,
        spendCeilingUsd: null,
        timeBudgetOverrideS: null,
      },
      changes: {
        suiteVersionFrom: 1,
        suiteVersionTo: 2,
        changedTasks: ['alpha'],
        removedTasks: ['charlie'],
        invalidTasks: [{ key: 'bravo', reason: 'self-check failed: the reference does not pass' }],
      },
    });
    // The draft is launchable as it stands, once the form adds the hashes it shows.
    const launch = LaunchExperimentInputSchema.safeParse({
      ...draft.values,
      expectedConfigHashes: {
        [next.versionId]: next.configHash,
        [x.candidate.versionId]: x.candidate.configHash,
      },
    });
    expect(launch.success).toBe(true);
  });

  it('keeps the original versions when two versions of one configuration were compared', async () => {
    const suite = await seedSuite(c.t.db, { tasks: [{ key: 'alpha' }] });
    const v1 = await seedConfiguration(c.t.db, 'tuned');
    await c.t.db
      .update(configurationVersions)
      .set({ frozenAt: new Date() })
      .where(eq(configurationVersions.id, v1.versionId));
    const v2 = await seedNextVersion(c.t.db, v1.configurationId, 'tuned', { settings: 'tuned v2' });
    await c.t.db
      .update(configurationVersions)
      .set({ frozenAt: new Date() })
      .where(eq(configurationVersions.id, v2.versionId));
    // Launched before tuned had a v3: as the launch transaction stores it.
    const [e] = await c.t.db
      .insert(experiments)
      .values({
        name: 'v1 vs v2',
        suiteId: suite.id,
        taskIds: [suite.taskIds.get('alpha')!],
        baselineVersionId: v1.versionId,
        candidateVersionIds: [v2.versionId],
        repetitions: 1,
        concurrency: 1,
        hermesVersion: '0.22.4',
        hermesRevision: HERMES_REVISION,
        priceTable: { sha256: 'a'.repeat(64), loaded_at: '2026-10-24T09:00:00.000Z', models: {} },
      })
      .returning({ id: experiments.id });
    await seedNextVersion(c.t.db, v1.configurationId, 'tuned', { settings: 'tuned v3' });
    const draft = NewExperimentDraftSchema.parse(
      (await c.post(`/experiments/${e!.id}/duplicate`).expect(200)).body,
    );
    expect(draft.values).toMatchObject({
      baselineVersionId: v1.versionId,
      candidateVersionIds: [v2.versionId],
      description: '',
    });
  });

  it('answers 404 for an unknown experiment', async () => {
    await c.post('/experiments/exp_gone/duplicate').expect(404);
  });
});
