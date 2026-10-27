/**
 * Phase 8 end to end: first-run setup and the fixes the real model showed,
 * on the real AppModule and WorkerModule over a fresh Postgres 17 database,
 * with real pg-boss, the real loader, seed, launch, runner, evaluation and
 * views. As in Phases 2 to 6 only the sandbox is replaced
 * (test/support/fake-engine.ts), so no model is ever called. Every HTTP
 * answer is parsed with its shared schema.
 *
 * - The samples seed (G3), with Compose's defaults (SAMPLES_DIR at the
 *   repository's samples/, the mock judge of G1): the first start creates
 *   every skill folder, every document, both sample MCP servers and every
 *   configuration samples/configurations.yaml declares, read from the
 *   files themselves (test/support/phase8-samples.ts); a second start
 *   creates nothing.
 * - The sample experiment (G4): the body Run a sample experiment builds from
 *   New experiment's options launches on the mock with no warning and
 *   completes.
 * - The judge warning (G2): a real-provider configuration on a task with an
 *   llm_judge key, while the judge is the mock, launches with the warning,
 *   which New experiment's options give the form too.
 * - Unfenced answers (G5): the baseline's trials reply with the bare JSON
 *   object (test/support/phase8-trials.ts); each is found, flagged unfenced
 *   in the inspector, and scored.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { basename } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigurationListRowSchema,
  DocumentRowSchema,
  LaunchExperimentResultSchema,
  MOCK_JUDGE_WARNING,
  McpServerRowSchema,
  NewExperimentOptionsSchema,
  RunDetailSchema,
  RunListResultSchema,
  SAMPLE_EXPERIMENT,
  SkillRowSchema,
  SystemSetupSchema,
  mockJudgeWarning,
  seedCounts,
  type LaunchExperimentInput,
  type NewExperimentOptions,
  type SystemSetup,
} from '@hermes-evals/shared';
import { SampleSeedService } from '../src/samples/seed.service.js';
import { Phase2World } from './support/phase2-app.js';
import {
  CONFIGURATIONS,
  DOCUMENTS,
  EXPECTED_ITEMS,
  MCP_SERVERS,
  SAMPLES,
  SKILLS,
  kindAndName,
  sortItems,
} from './support/phase8-samples.js';
import { INVOICES_SUITE, Phase8Trials, referenceOf } from './support/phase8-trials.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

/** Compose's default judge since Phase 8 (G1): the scripted mock model. */
const MOCK_JUDGE = {
  JUDGE_PROVIDER: 'custom',
  JUDGE_MODEL: 'mock/scripted',
  JUDGE_BASE_URL: 'http://mock-model:8090/v1',
} as const;

describe.skipIf(!SERVER_URL)('Phase 8 on Postgres 17: first-run setup', () => {
  const trials = new Phase8Trials();
  const world = new Phase2World(SERVER_URL!, 'phase8_e2e', {
    suite: INVOICES_SUITE,
    script: trials.script,
    judge: trials.judge,
    env: { SEED_SAMPLES: 'true', SAMPLES_DIR: SAMPLES, ...MOCK_JUDGE },
  });

  const setup = (): Promise<SystemSetup> => world.read('/system/setup', SystemSetupSchema);
  const options = (): Promise<NewExperimentOptions> =>
    world.read('/experiments/new-options', NewExperimentOptionsSchema);
  const configurationsList = () =>
    world.read('/configurations', ConfigurationListRowSchema.array());

  /** A start of the API as main.ts boots it, on the same database and settings. */
  async function startApi(): Promise<NestExpressApplication> {
    const { AppModule } = await import('../src/app.module.js');
    const { configureApi } = await import('../src/app.setup.js');
    const api = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
    configureApi(api);
    await api.init();
    return api;
  }

  /** The launch body Run a sample experiment builds (apps/web sampleExperiment.ts). */
  function sampleBody(opts: NewExperimentOptions): LaunchExperimentInput {
    const suite = opts.suites.find((s) => s.name === SAMPLE_EXPERIMENT.suite)!;
    const byName = (name: string) => opts.configurations.find((c) => c.name === name)!;
    const baseline = byName(SAMPLE_EXPERIMENT.baseline);
    const candidate = byName(SAMPLE_EXPERIMENT.candidate);
    return {
      name: SAMPLE_EXPERIMENT.name,
      description: 'Started with Run a sample experiment.',
      suiteId: suite.suiteId,
      taskKeys: suite.tasks.filter((t) => t.valid).map((t) => t.key),
      baselineVersionId: baseline.versionId,
      candidateVersionIds: [candidate.versionId],
      repetitions: SAMPLE_EXPERIMENT.repetitions,
      concurrency: Math.max(1, Math.min(opts.defaults.concurrency, opts.maxConcurrency)),
      spendCeilingUsd: null,
      timeBudgetOverrideS: null,
      expectedConfigHashes: {
        [baseline.versionId]: baseline.configHash,
        [candidate.versionId]: candidate.configHash,
      },
    };
  }

  beforeAll(async () => {
    await world.start();
    await world.api.get(SampleSeedService).settled();
  }, 180_000);

  afterAll(async () => {
    await world.stop();
  }, 120_000);

  it('seeds every sample at the first start, as samples/ declares it', async () => {
    expect(CONFIGURATIONS).toHaveLength(26);
    const first = await setup();
    expect(first.judge).toEqual({
      provider: 'custom',
      model: 'mock/scripted',
      mock: true,
      mockModelName: false,
    });
    expect(first.seed).toMatchObject({ state: 'done', error: null });
    expect(kindAndName(first.seed.items)).toEqual(sortItems(EXPECTED_ITEMS));
    expect(first.seed.items.filter((i) => i.outcome !== 'created')).toEqual([]);
    expect(seedCounts(first.seed)).toEqual({
      created: EXPECTED_ITEMS.length,
      skipped: 0,
      failed: 0,
    });

    const skills = await world.read('/resources/skills', SkillRowSchema.array());
    expect(skills.map((s) => s.name).sort()).toEqual([...SKILLS].sort());
    const documents = await world.read('/resources/documents', DocumentRowSchema.array());
    expect(documents.map((d) => d.filename).sort()).toEqual(
      DOCUMENTS.map((d) => basename(d)).sort(),
    );

    const servers = await world.read('/resources/mcp-servers', McpServerRowSchema.array());
    const definition = (name: string) => {
      const row = servers.find((s) => s.name === name)!;
      const { transport, command, args, envNames, url, headers } = row;
      return { transport, command, args, envNames, url, headers };
    };
    expect(servers.map((s) => s.name).sort()).toEqual(MCP_SERVERS);
    expect(definition('invoice-db')).toEqual({
      transport: 'stdio',
      command: 'invoice-db-mcp',
      args: [],
      envNames: ['INVOICE_DB_URL'],
      url: null,
      headers: [],
    });
    expect(definition('vendor-directory')).toEqual({
      transport: 'http',
      command: null,
      args: [],
      envNames: [],
      url: 'http://vendor-directory:8000/mcp',
      headers: [{ header: 'Authorization', env: 'VENDOR_DIRECTORY_TOKEN', prefix: 'Bearer ' }],
    });

    const saved = await configurationsList();
    expect(saved.map((c) => c.name).sort()).toEqual(CONFIGURATIONS.map((c) => c.name).sort());
    for (const want of CONFIGURATIONS) {
      const { latest } = saved.find((c) => c.name === want.name)!;
      expect({
        name: want.name,
        provider: latest.provider,
        model: latest.model,
        baseUrl: latest.baseUrl,
        toolsets: [...latest.toolsets].sort(),
        memoryEnabled: latest.memoryEnabled,
        skills: latest.skills.map((s) => s.name).sort(),
        skillLoading: latest.skillLoading,
        documents: latest.documents.map((d) => d.filename).sort(),
        mcpServers: latest.mcpServers.map((m) => m.name).sort(),
        maxTurns: latest.maxTurns,
        timeBudgetS: latest.timeBudgetS,
      }).toEqual(want);
    }
  });

  it('creates nothing at the next start: every sample is skipped', async () => {
    const before = await configurationsList();
    await world.api.close();
    world.api = await startApi();
    await world.api.get(SampleSeedService).settled();
    const again = await setup();
    expect(again.seed.state).toBe('done');
    expect(kindAndName(again.seed.items)).toEqual(sortItems(EXPECTED_ITEMS));
    expect(again.seed.items.filter((i) => i.outcome !== 'skipped')).toEqual([]);
    expect(seedCounts(again.seed)).toEqual({
      created: 0,
      skipped: EXPECTED_ITEMS.length,
      failed: 0,
    });
    const after = await configurationsList();
    expect(after.map((c) => [c.name, c.latest.versionId])).toEqual(
      before.map((c) => [c.name, c.latest.versionId]),
    );
    expect(await world.read('/resources/skills', SkillRowSchema.array())).toHaveLength(
      SKILLS.length,
    );
    expect(await world.read('/resources/documents', DocumentRowSchema.array())).toHaveLength(
      DOCUMENTS.length,
    );
  }, 60_000);

  describe('with a worker', () => {
    beforeAll(async () => {
      await world.startWorker();
    }, 120_000);

    it('launches the sample experiment on the mock with no warning, and scores unfenced answers', async () => {
      const opts = await options();
      expect(opts.judge).toEqual({
        provider: 'custom',
        model: 'mock/scripted',
        mock: true,
        mockModelName: false,
      });
      const suite = opts.suites.find((s) => s.name === SAMPLE_EXPERIMENT.suite)!;
      expect(
        suite.tasks
          .filter((t) => t.valid)
          .map((t) => t.key)
          .sort(),
      ).toEqual([...INVOICES_SUITE.tasks].sort());
      const sample = [SAMPLE_EXPERIMENT.baseline, SAMPLE_EXPERIMENT.candidate].map((name) =>
        opts.configurations.find((c) => c.name === name)!,
      );
      expect(sample.map((c) => c.mockModel)).toEqual([true, true]);
      // disputed has an llm_judge key, but both arms are the mock: no warning.
      expect(mockJudgeWarning(opts.judge, sample, suite.tasks)).toBeNull();

      const body = sampleBody(opts);
      const launched = await world.send(
        'post',
        '/experiments',
        body,
        201,
        LaunchExperimentResultSchema,
      );
      expect(launched.warnings).toEqual([]);
      const done = await world.completed(launched.id, 240_000);
      expect(done.name).toBe(SAMPLE_EXPERIMENT.name);

      const list = await world.read(`/experiments/${launched.id}/runs`, RunListResultSchema);
      expect(list.rows).toHaveLength(
        INVOICES_SUITE.tasks.length * 2 * SAMPLE_EXPERIMENT.repetitions,
      );
      expect(list.rows.filter((r) => r.status !== 'scored')).toEqual([]);
      // Before G5 every baseline run of an answer-graded task was ungradable.
      expect(list.summary.ungradable).toBe(0);
      expect(list.rows.filter((r) => r.primaryScore?.status === 'ungradable')).toEqual([]);

      const totalDue = (name: string) =>
        list.rows.filter((r) => r.taskKey === 'total_due' && r.configuration.name === name);
      for (const row of totalDue(SAMPLE_EXPERIMENT.baseline)) {
        const run = await world.read(`/runs/${row.id}`, RunDetailSchema);
        const reply = run.finalResponse!;
        const start = reply.text.length - reply.text.trimStart().length;
        expect(reply).toMatchObject({
          extraction: 'found',
          unfenced: true,
          fence: null,
          extracted: { start, end: reply.text.trimEnd().length },
          parsed: referenceOf('total_due'),
        });
        expect(run.scores.find((s) => s.key === 'answer')?.status).toBe('passed');
      }
      for (const row of totalDue(SAMPLE_EXPERIMENT.candidate)) {
        const run = await world.read(`/runs/${row.id}`, RunDetailSchema);
        expect(run.finalResponse).toMatchObject({ extraction: 'found', unfenced: false });
        expect(run.finalResponse!.fence).not.toBeNull();
        expect(run.scores.find((s) => s.key === 'answer')?.status).toBe('passed');
      }
    }, 300_000);

    it('warns, without blocking, when the mock judge would grade a real model', async () => {
      // The real arm runs on Nous, which must be ready for the launch (a fake login).
      world.nous.approve();
      const opts = await options();
      const real = opts.configurations.find((c) => c.name === 'invoices-v1-baseline')!;
      const mock = opts.configurations.find((c) => c.name === SAMPLE_EXPERIMENT.candidate)!;
      expect([real.provider, real.model, real.mockModel]).toEqual([
        'nous',
        'openai/gpt-6.1-sol',
        false,
      ]);
      const suite = opts.suites.find((s) => s.name === SAMPLE_EXPERIMENT.suite)!;
      const disputed = suite.tasks.find((t) => t.key === 'disputed')!;
      const totalDue = suite.tasks.find((t) => t.key === 'total_due')!;
      expect([disputed.hasLlmJudge, totalDue.hasLlmJudge]).toEqual([true, false]);
      // The form's rule, from the options.
      expect(mockJudgeWarning(opts.judge, [real, mock], [disputed])).toBe(MOCK_JUDGE_WARNING);
      expect(mockJudgeWarning(opts.judge, [real, mock], [totalDue])).toBeNull();

      const launch = async (taskKeys: string[]) =>
        world.send(
          'post',
          '/experiments',
          {
            ...sampleBody(opts),
            name: `Judge warning: ${taskKeys.join(', ')}`,
            taskKeys,
            baselineVersionId: real.versionId,
            repetitions: 1,
            expectedConfigHashes: {
              [real.versionId]: real.configHash,
              [mock.versionId]: mock.configHash,
            },
          },
          201,
          LaunchExperimentResultSchema,
        );
      const warned = await launch(['disputed']);
      expect(warned.warnings).toEqual([MOCK_JUDGE_WARNING]);
      const quiet = await launch(['total_due']);
      expect(quiet.warnings).toEqual([]);
      // A warning, not a block: the experiment runs (on the fake engine) to the end.
      const done = await world.completed(warned.id, 120_000);
      expect(done.status).toBe('completed');
      await world.completed(quiet.id, 120_000);
    }, 300_000);
  });
});
