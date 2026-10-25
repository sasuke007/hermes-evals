/**
 * POST /api/experiments (plan 7.1, E7) on PGlite with a real pg-boss: what a
 * launch stores and sends, and every refusal, each leaving nothing behind.
 */
import { writeFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  LaunchExperimentResultSchema,
  type LaunchExperimentInput,
} from '@hermes-evals/shared';
import { configurationVersions, experiments, runs } from '../../database/schema/index.js';
import { addJudgedTask } from '../../runs/commands/rescore-seed.support-spec.js';
import { createCommandsApp, type CommandsApp } from './commands-app.support-spec.js';
import {
  experimentRow,
  HERMES_REVISION,
  runsOf,
  seedConfiguration,
  seedNextVersion,
  seedSuite,
  seedWorker,
  type SeededConfiguration,
  type SeededSuite,
} from './commands-seed.support-spec.js';

let c: CommandsApp;
let suite: SeededSuite;
let base: SeededConfiguration;
let cand: SeededConfiguration;

beforeEach(async () => {
  c = await createCommandsApp();
  suite = await seedSuite(c.t.db, {
    tasks: [{ key: 'alpha' }, { key: 'bravo' }, { key: 'charlie' }, { key: 'delta', valid: false }],
  });
  base = await seedConfiguration(c.t.db, 'baseline');
  cand = await seedConfiguration(c.t.db, 'with-skill');
});

afterEach(() => c.close());

const body = (overrides: Partial<LaunchExperimentInput> = {}): LaunchExperimentInput => ({
  name: '  Skill vs no skill ',
  description: '',
  suiteId: suite.id,
  taskKeys: ['charlie', 'alpha', 'bravo'],
  baselineVersionId: base.versionId,
  candidateVersionIds: [cand.versionId],
  repetitions: 2,
  concurrency: 3,
  spendCeilingUsd: null,
  timeBudgetOverrideS: null,
  expectedConfigHashes: { [base.versionId]: base.configHash, [cand.versionId]: cand.configHash },
  ...overrides,
});

/** Nothing of a refused launch remains: no experiment, run or job, nothing frozen. */
async function expectNothingLaunched(): Promise<void> {
  expect(await c.t.db.select().from(experiments)).toEqual([]);
  expect(await c.t.db.select().from(runs)).toEqual([]);
  expect(await c.jobs()).toEqual([]);
  const frozen = await c.t.db
    .select({ frozenAt: configurationVersions.frozenAt })
    .from(configurationVersions);
  expect(frozen.every((v) => v.frozenAt === null)).toBe(true);
}

const refusal = (res: { body: unknown }) => ApiErrorBodySchema.parse(res.body);

describe('POST /api/experiments', () => {
  it('stores the experiment, its queued run matrix and one execute-run job per run', async () => {
    await seedWorker(c.t.db, { concurrency: 3, slots: 4 });
    const res = await c.post('/experiments', body()).expect(201);
    const { id } = LaunchExperimentResultSchema.parse(res.body);

    const e = await experimentRow(c.t.db, id);
    expect(e).toMatchObject({
      name: 'Skill vs no skill',
      description: null,
      status: 'running',
      suiteId: suite.id,
      // The suite's display order, whatever order the body named them in.
      taskIds: ['alpha', 'bravo', 'charlie'].map((k) => suite.taskIds.get(k)),
      baselineVersionId: base.versionId,
      candidateVersionIds: [cand.versionId],
      repetitions: 2,
      concurrency: 3,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      estimate: { runs: 12, duration_s: 4 * 30, cost_usd: 0, basis: 'budget' },
    });
    expect(Object.keys(e.priceTable.models).sort()).toEqual(['mock/scripted', 'test/priced']);

    const matrix = await runsOf(c.t.db, id);
    expect(matrix).toHaveLength(3 * 2 * 2);
    expect(matrix.every((r) => r.status === 'queued' && r.attemptCount === 0)).toBe(true);
    const cells = new Set(
      matrix.map((r) => `${r.taskId}|${r.configurationVersionId}|${r.repetition}`),
    );
    expect(cells.size).toBe(12);

    const jobs = await c.jobs();
    expect(jobs.map((j) => j.singletonKey ?? '').sort()).toEqual(
      matrix.map((r) => `${r.id}:1`).sort(),
    );
    expect(jobs.every((j) => j.state === 'created' && j.data.trigger === 'initial')).toBe(true);
    expect(jobs.every((j) => j.data.attempt === 1)).toBe(true);

    const frozen = await c.t.db.select().from(configurationVersions);
    expect(frozen.every((v) => v.frozenAt !== null)).toBe(true);
  });

  it('caps concurrency at what the proven workers can run, and launches over the spend ceiling', async () => {
    await seedWorker(c.t.db, { concurrency: 3, slots: 1 });
    await seedWorker(c.t.db, { concurrency: 1, slots: 4 });
    await seedWorker(c.t.db, { proven: false, concurrency: 8, slots: 8 });
    const priced = await seedConfiguration(c.t.db, 'priced', { model: 'test/priced' });
    const res = await c
      .post(
        '/experiments',
        body({
          baselineVersionId: priced.versionId,
          expectedConfigHashes: {
            [priced.versionId]: priced.configHash,
            [cand.versionId]: cand.configHash,
          },
          concurrency: 16,
          // The budget estimate prices 6 runs of test/priced at $0.033 each: over $0.01.
          spendCeilingUsd: 0.01,
          description: 'Does the skill help?',
          timeBudgetOverrideS: 600,
        }),
      )
      .expect(201);
    const e = await experimentRow(c.t.db, LaunchExperimentResultSchema.parse(res.body).id);
    expect(e).toMatchObject({
      concurrency: 2,
      spendCeilingUsd: 0.01,
      description: 'Does the skill help?',
      timeBudgetOverrideS: 600,
    });
    // 12 runs, 2 at a time: 6 waves of a quarter of the overriding 600 s budget.
    expect(e.estimate).toEqual({ runs: 12, duration_s: 6 * 150, cost_usd: 0.198, basis: 'budget' });
  });

  it('answers 400 for a suite, task or configuration version the database does not have', async () => {
    await seedWorker(c.t.db);
    const missing = await c
      .post(
        '/experiments',
        body({
          taskKeys: ['alpha', 'zulu', 'delta'],
          candidateVersionIds: ['cv_gone'],
          expectedConfigHashes: { [base.versionId]: base.configHash, cv_gone: base.configHash },
        }),
      )
      .expect(400);
    expect(refusal(missing).issues).toEqual([
      { path: 'taskKeys.1', message: 'zulu is not a task of invoices-v1 v1' },
      {
        path: 'taskKeys.2',
        message: 'delta is invalid and cannot run: self-check failed: the reference does not pass',
      },
      { path: 'candidateVersionIds.0', message: 'configuration version cv_gone does not exist' },
    ]);
    const noSuite = await c.post('/experiments', body({ suiteId: 'suite_gone' })).expect(400);
    expect(refusal(noSuite).issues).toEqual([
      { path: 'suiteId', message: 'suite version suite_gone does not exist' },
    ]);
    await expectNothingLaunched();
  });

  it('answers 400 for a body the shared schema refuses', async () => {
    const res = await c
      .post('/experiments', { ...body(), candidateVersionIds: [base.versionId], repetitions: 0 })
      .expect(400);
    expect(refusal(res).issues?.map((i) => i.path)).toEqual([
      'repetitions',
      'candidateVersionIds',
      'expectedConfigHashes',
    ]);
  });

  it('answers 409 when no worker is connected, none has proven isolation, or their revisions disagree', async () => {
    await seedWorker(c.t.db, { silentS: 120 });
    const none = await c.post('/experiments', body()).expect(409);
    expect(refusal(none).message).toMatch(/^No worker is connected/);

    await seedWorker(c.t.db, { proven: false });
    const unproven = await c.post('/experiments', body()).expect(409);
    expect(refusal(unproven).message).toMatch(/proven sandbox isolation/);

    await seedWorker(c.t.db);
    await seedWorker(c.t.db, { revision: 'f'.repeat(40) });
    await seedWorker(c.t.db, { revision: 'f'.repeat(40) });
    const split = await c.post('/experiments', body()).expect(409);
    expect(refusal(split).message).toBe(
      'The connected workers run different Hermes revisions (fffffff on 2 workers, 4d04303 on 1 worker). Restart them on one trial image before launching.',
    );
    await expectNothingLaunched();
  });

  it("answers 409 with the provider's reason when a configuration's provider is not ready", async () => {
    await seedWorker(c.t.db);
    const nous = await seedConfiguration(c.t.db, 'on-nous', {
      provider: 'nous',
      model: 'openai/gpt-6.1-sol',
    });
    const router = await seedConfiguration(c.t.db, 'on-router', {
      provider: 'openrouter',
      model: 'x/y',
    });
    c.nous.status = 'not_connected';
    const res = await c
      .post(
        '/experiments',
        body({
          candidateVersionIds: [nous.versionId, router.versionId],
          expectedConfigHashes: {
            [base.versionId]: base.configHash,
            [nous.versionId]: nous.configHash,
            [router.versionId]: router.configHash,
          },
        }),
      )
      .expect(409);
    expect(refusal(res).message).toBe(
      "Nous Portal is not connected.; OPENROUTER_API_KEY is not set in egress's environment. Add it to .env, then run: docker compose up -d egress worker",
    );
    await expectNothingLaunched();

    c.nous.status = 'connected';
    await c
      .post(
        '/experiments',
        body({
          candidateVersionIds: [nous.versionId],
          expectedConfigHashes: {
            [base.versionId]: base.configHash,
            [nous.versionId]: nous.configHash,
          },
        }),
      )
      .expect(201);
  });

  it("answers 409 when a selected task's llm_judge key needs a judge provider that is not ready", async () => {
    await seedWorker(c.t.db);
    // `judged` names `model: judge/model`; with JUDGE_PROVIDER unset its judge runs on nous (S3).
    await addJudgedTask(c.t.db, suite.id);
    c.nous.status = 'not_connected';
    const res = await c.post('/experiments', body({ taskKeys: ['alpha', 'judged'] })).expect(409);
    expect(refusal(res).message).toBe(
      "The LLM judge's provider is not ready: Nous Portal is not connected.",
    );
    await expectNothingLaunched();

    // Without the judged task, nothing needs the judge; the configurations are custom.
    await c.post('/experiments', body({ taskKeys: ['alpha'] })).expect(201);
    c.nous.status = 'connected';
    await c.post('/experiments', body({ taskKeys: ['alpha', 'judged'] })).expect(201);
  });

  it('answers 409 naming a configuration whose hash changed or that has a newer version, and rolls the freeze back', async () => {
    await seedWorker(c.t.db);
    const stale = await c
      .post(
        '/experiments',
        body({
          expectedConfigHashes: {
            [base.versionId]: base.configHash,
            [cand.versionId]: 'e'.repeat(64),
          },
        }),
      )
      .expect(409);
    expect(refusal(stale).message).toBe(
      'configuration with-skill changed since you opened this form',
    );
    await expectNothingLaunched();

    await seedNextVersion(c.t.db, cand.configurationId, 'with-skill', {
      settings: 'with-skill v2',
    });
    const newer = await c.post('/experiments', body()).expect(409);
    expect(refusal(newer).message).toBe(
      'configuration with-skill changed since you opened this form (now v2)',
    );
    await expectNothingLaunched();
  });

  it('answers 500 and launches nothing when the price table cannot be used', async () => {
    await seedWorker(c.t.db);
    await writeFile(c.pricesFile, 'models: [not, a, map]\n');
    const res = await c.post('/experiments', body()).expect(500);
    expect(refusal(res).message).toMatch(/^the price table cannot be used/);
    await expectNothingLaunched();
  });

  it('freezes a version another experiment already froze without touching it', async () => {
    await seedWorker(c.t.db);
    const first = LaunchExperimentResultSchema.parse(
      (await c.post('/experiments', body()).expect(201)).body,
    );
    const [before] = await c.t.db
      .select({ frozenAt: configurationVersions.frozenAt })
      .from(configurationVersions)
      .where(eq(configurationVersions.id, base.versionId));
    const second = LaunchExperimentResultSchema.parse(
      (await c.post('/experiments', body()).expect(201)).body,
    );
    expect(second.id).not.toBe(first.id);
    const [after] = await c.t.db
      .select({ frozenAt: configurationVersions.frozenAt })
      .from(configurationVersions)
      .where(eq(configurationVersions.id, base.versionId));
    expect(after!.frozenAt).toEqual(before!.frozenAt);
    expect(await c.jobs()).toHaveLength(24);
  });
});
