/**
 * The mock-judge warning over HTTP (Phase 8 G2): New experiment's options
 * carry what the form needs to compute it (each task's `hasLlmJudge`, each
 * configuration's `mockModel`, the judge), and the launch answer carries the
 * same warning from the same values. A warning, never a block.
 *
 * And Compose's per-setting judge defaults (Phase 8 review): JUDGE_PROVIDER
 * alone in .env leaves the mock's model beside a real provider, which env.ts
 * reads as no model (409, as in Phase 7); a custom judge on a real base URL
 * keeps the name, and both places warn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  LaunchExperimentResultSchema,
  MOCK_JUDGE_WARNING,
  MOCK_MODEL_NAME_JUDGE_WARNING,
  mockJudgeWarning,
  NewExperimentOptionsSchema,
  type NewExperimentOptions,
} from '@hermes-evals/shared';
import { validateEnv } from '../../config/env.js';
import { runs } from '../../database/schema/index.js';
import { noJudgeModelReason } from '../../providers/judge-readiness.js';
import {
  addJudgedTask,
  setSetting,
  UNMODELLED_VERIFICATION,
} from '../../runs/commands/rescore-seed.support-spec.js';
import { createCommandsApp, type CommandsApp } from './commands-app.support-spec.js';
import {
  seedConfiguration,
  seedSuite,
  seedWorker,
  type SeededConfiguration,
  type SeededSuite,
} from './commands-seed.support-spec.js';

let c: CommandsApp;
let suite: SeededSuite;
let mock: SeededConfiguration;
let mockToo: SeededConfiguration;
let real: SeededConfiguration;

beforeEach(async () => {
  c = await createCommandsApp();
  suite = await seedSuite(c.t.db, { tasks: [{ key: 'alpha' }] });
  // `judged` has an llm_judge key that names its own model, so a judge provider is all it needs;
  // `graded`'s names none, so only JUDGE_MODEL can grade it.
  await addJudgedTask(c.t.db, suite.id);
  await addJudgedTask(c.t.db, suite.id, 'graded', {
    verification: UNMODELLED_VERIFICATION,
    position: 11,
  });
  mock = await seedConfiguration(c.t.db, 'mock');
  mockToo = await seedConfiguration(c.t.db, 'mock-too');
  real = await seedConfiguration(c.t.db, 'real', { provider: 'nous', model: 'openai/gpt-6.1-sol' });
  await seedWorker(c.t.db);
});

afterEach(() => c.close());

/** Compose's default judge since Phase 8: the scripted mock model. */
const COMPOSE_JUDGE = {
  JUDGE_PROVIDER: 'custom',
  JUDGE_MODEL: 'mock/scripted',
  JUDGE_BASE_URL: 'http://mock-model:8090/v1',
};

/** The judge settings the api reads when Compose's defaults meet `dotenv`, through validateEnv. */
function judgeFromCompose(dotenv: Record<string, string> = {}): void {
  const env = validateEnv({ ...COMPOSE_JUDGE, ...dotenv });
  setSetting(c, 'JUDGE_PROVIDER', env.JUDGE_PROVIDER);
  setSetting(c, 'JUDGE_MODEL', env.JUDGE_MODEL);
  setSetting(c, 'JUDGE_BASE_URL', env.JUDGE_BASE_URL);
}

const judgeIsTheMock = (): void => judgeFromCompose();

const options = async (): Promise<NewExperimentOptions> =>
  NewExperimentOptionsSchema.parse((await c.get('/experiments/new-options').expect(200)).body);

function send(baseline: SeededConfiguration, candidate: SeededConfiguration, taskKeys: string[]) {
  return c.post('/experiments', {
    name: 'Judge warning',
    description: '',
    suiteId: suite.id,
    taskKeys,
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
  });
}

async function launch(
  baseline: SeededConfiguration,
  candidate: SeededConfiguration,
  taskKeys: string[],
) {
  return LaunchExperimentResultSchema.parse(
    (await send(baseline, candidate, taskKeys).expect(201)).body,
  );
}

describe('GET /api/experiments/new-options for the judge warning', () => {
  it('marks the tasks with an llm_judge key and the configurations on the mock model', async () => {
    const shown = await options();
    expect(shown.suites[0]!.tasks.map((t) => [t.key, t.hasLlmJudge])).toEqual([
      ['alpha', false],
      ['judged', true],
      ['graded', true],
    ]);
    expect(shown.configurations.map((o) => [o.name, o.mockModel])).toEqual([
      ['mock', true],
      ['mock-too', true],
      ['real', false],
    ]);
  });

  it('shows the judge: nous with no model when unset, the mock when Compose defaults it', async () => {
    expect((await options()).judge).toEqual({
      provider: 'nous',
      model: null,
      mock: false,
      mockModelName: false,
    });
    judgeIsTheMock();
    expect((await options()).judge).toEqual({
      provider: 'custom',
      model: 'mock/scripted',
      mock: true,
      mockModelName: false,
    });
  });
});

describe('POST /api/experiments warnings', () => {
  it("warns, and still launches, when the mock judges a real model's llm_judge checks", async () => {
    judgeIsTheMock();
    c.nous.status = 'connected';
    const answer = await launch(mock, real, ['alpha', 'judged']);
    expect(answer.warnings).toEqual([MOCK_JUDGE_WARNING]);
    expect(await c.t.db.select().from(runs)).toHaveLength(4);

    // The form computes the same warning from its options.
    const shown = await options();
    const pick = (name: string) => shown.configurations.find((o) => o.name === name)!;
    expect(
      mockJudgeWarning(shown.judge, [pick('mock'), pick('real')], shown.suites[0]!.tasks),
    ).toBe(MOCK_JUDGE_WARNING);
  });

  it('does not warn when every configuration is the mock, or no selected task has a judge key', async () => {
    judgeIsTheMock();
    c.nous.status = 'connected';
    expect((await launch(mock, mockToo, ['alpha', 'judged'])).warnings).toEqual([]);
    expect((await launch(mock, real, ['alpha'])).warnings).toEqual([]);
  });

  it('does not warn when the judge is a real model', async () => {
    // JUDGE_* unset: `judged` names its model and runs on nous, which is connected.
    c.nous.status = 'connected';
    expect((await launch(mock, real, ['alpha', 'judged'])).warnings).toEqual([]);
  });
});

describe("POST /api/experiments with Compose's judge defaults beside a partial .env", () => {
  it('refuses with 409, as before Phase 8, when .env sets only JUDGE_PROVIDER=openrouter', async () => {
    judgeFromCompose({ JUDGE_PROVIDER: 'openrouter' });
    c.nous.status = 'connected';
    expect((await options()).judge).toEqual({
      provider: 'openrouter',
      model: null,
      mock: false,
      mockModelName: false,
    });
    const res = await send(mock, real, ['alpha', 'graded']).expect(409);
    expect(ApiErrorBodySchema.parse(res.body).message).toBe(noJudgeModelReason(['graded.tone']));
    expect(await c.t.db.select().from(runs)).toHaveLength(0);
  });

  it('warns, whatever the configurations, when a custom judge on a real base URL keeps mock/scripted', async () => {
    judgeFromCompose({ JUDGE_BASE_URL: 'https://judge.example.com/v1' });
    c.nous.status = 'connected';
    const shown = await options();
    expect(shown.judge).toEqual({
      provider: 'custom',
      model: 'mock/scripted',
      mock: false,
      mockModelName: true,
    });
    expect((await launch(mock, mockToo, ['alpha', 'graded'])).warnings).toEqual([
      MOCK_MODEL_NAME_JUDGE_WARNING,
    ]);
    expect((await launch(mock, real, ['alpha', 'judged'])).warnings).toEqual([
      MOCK_MODEL_NAME_JUDGE_WARNING,
    ]);
    expect((await launch(mock, real, ['alpha'])).warnings).toEqual([]);
    // The form computes the same warning from its options.
    const pick = (name: string) => shown.configurations.find((o) => o.name === name)!;
    expect(
      mockJudgeWarning(shown.judge, [pick('mock'), pick('mock-too')], shown.suites[0]!.tasks),
    ).toBe(MOCK_MODEL_NAME_JUDGE_WARNING);
  });
});
