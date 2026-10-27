/**
 * Phase 6 end to end: the platform additions on the real AppModule and
 * WorkerModule over a fresh Postgres 17 database, with real pg-boss, the real
 * loader, lifecycle, runner, collection, evaluation and views. As in Phases
 * 2 to 4 only the sandbox is replaced (test/support/fake-engine.ts), so no
 * model is ever called. Every HTTP answer is parsed with its shared schema.
 *
 * - Home seeds (P1) and memory files (P2): the phase6 suite's one task seeds
 *   home/memories/MEMORY.md and USER.md. Only memory on starts with the
 *   seeds in the trial home (Phase 8 G9: with memory off nothing there is
 *   memory, so no seed goes in and nothing is collected from it); the run
 *   with memory on saves an entry to MEMORY.md
 *   (test/support/phase6-trials.ts), which is collected with root home and
 *   scored by a file_check with `root: home` and a verifier that reads
 *   `--home`. The run detail lists the memory files, the launch record the
 *   seeds, the ones memory off left out, and the background review
 *   intervals (P3).
 * - Skill loading (P5): preload passes `-s`; on demand passes none and adds
 *   the `skills` toolset, the skill still installed in the home.
 * - Unset MCP variables (decision #13 of phase-5.md 6.4): launch answers 409
 *   naming each, and New experiment's options show them.
 * - The repository's five suites (invoices-v1, and Phase 6b's mcp-v1,
 *   memory-v1, knowledge-v1 and tools-v1) load valid through the worker's
 *   loader at start, beside the e2e suite: 42 tasks.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApiErrorBodySchema,
  ConfigDiffSchema,
  ConfigurationDetailSchema,
  McpServerRowSchema,
  MissingSecretsConflictSchema,
  NewExperimentOptionsSchema,
  RunDetailSchema,
  RunListResultSchema,
  SKILL_LOADING_NEEDS_SKILLS,
  SkillRowSchema,
  SkillUploadValidationSchema,
  SuiteDetailSchema,
  SuiteListRowSchema,
  TaskDetailSchema,
  missingSecretText,
  missingSecretsConflictMessage,
  type McpServerInput,
  type MissingMcpSecret,
  type RunDetail,
} from '@hermes-evals/shared';
import * as schema from '../src/database/schema/index.js';
import { invoiceMethodZip } from '../src/resources/skills/testing.helper-spec.js';
import { Phase2World, type ConfigRef } from './support/phase2-app.js';
import {
  PHASE6_SUITE,
  Phase6Trials,
  SAVED_MEMORY,
  SEEDS,
  preloadedOf,
  toolsetsOf,
} from './support/phase6-trials.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const REPO = join(import.meta.dirname, '..', '..', '..');
/** The repository's suites (plan 18.1 and 18.3). */
const REPO_SUITES = ['invoices-v1', 'mcp-v1', 'memory-v1', 'knowledge-v1', 'tools-v1'];
const { artifacts, experiments, taskFiles, tasks } = schema;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A stdio server whose variable the worker does not hold, and the sample http server. */
const LEDGER_DB: McpServerInput = {
  name: 'ledger-db',
  transport: 'stdio',
  command: 'ledger-db-mcp',
  args: [],
  envNames: ['PHASE6_E2E_LEDGER_URL'],
  url: null,
  headers: [],
  include: [],
  exclude: [],
  timeoutS: 30,
};
const VENDOR_DIRECTORY: McpServerInput = {
  name: 'vendor-directory',
  transport: 'http',
  command: null,
  args: [],
  envNames: [],
  url: 'http://vendor-directory:8000/mcp',
  headers: [{ header: 'Authorization', env: 'VENDOR_DIRECTORY_TOKEN' }],
  include: [],
  exclude: [],
  timeoutS: 30,
};

describe.skipIf(!SERVER_URL)('Phase 6 on Postgres 17: the platform additions', () => {
  const trials = new Phase6Trials();
  const world = new Phase2World(SERVER_URL!, 'phase6_e2e', {
    suite: PHASE6_SUITE,
    script: trials.script,
  });
  let skillId = '';
  const configs = {} as Record<'memoryOff' | 'memoryOn' | 'preload' | 'onDemand', ConfigRef>;

  beforeAll(async () => {
    // Neither may be set where the launch check looks: the worker's env (stdio)
    // or egress's (http, the fake egress reports no names).
    delete process.env['PHASE6_E2E_LEDGER_URL'];
    delete process.env['VENDOR_DIRECTORY_TOKEN'];
    await world.start();
    // The repository's suites beside the e2e suite: the worker loads them all at start.
    for (const name of REPO_SUITES) {
      await cp(join(REPO, 'suites', name), join(world.suitesDir, name), { recursive: true });
    }
    await world.startWorker();
  }, 180_000);

  afterAll(async () => {
    await world.stop();
  }, 120_000);

  const runDetail = (id: string): Promise<RunDetail> => world.read(`/runs/${id}`, RunDetailSchema);

  /** The experiment's runs by configuration name, once it has completed. */
  async function runsByConfiguration(experimentId: string): Promise<Map<string, RunDetail>> {
    await world.completed(experimentId, 120_000);
    const list = await world.read(`/experiments/${experimentId}/runs`, RunListResultSchema);
    const out = new Map<string, RunDetail>();
    for (const row of list.rows) out.set(row.configuration.name, await runDetail(row.id));
    return out;
  }

  const scoreOf = (run: RunDetail, key: string) => run.scores.find((s) => s.key === key);

  it("loads the e2e suite and the repository's five suites through the worker's loader", async () => {
    const list = await world.read('/suites', z.array(SuiteListRowSchema));
    const counts = list.map((s) => [s.name, s.taskCount, s.validCount] as const);
    expect(counts.sort((a, b) => a[0].localeCompare(b[0]))).toEqual([
      ['invoices-v1', 12, 12],
      ['knowledge-v1', 8, 8],
      ['mcp-v1', 8, 8],
      ['memory-v1', 8, 8],
      ['phase6', 1, 1],
      ['tools-v1', 6, 6],
    ]);
    const invoices = list.find((s) => s.name === 'invoices-v1')!;
    const detail = await world.read(`/suites/${invoices.suiteId}`, SuiteDetailSchema);
    expect(detail.tasks.map((t) => [t.key, t.valid])).toEqual(
      [
        'total_due',
        'overdue_list',
        'dup_invoices',
        'vat_split',
        'credit_notes',
        'currency_mix',
        'missing_po',
        'late_fees',
        'per_vendor',
        'disputed',
        'partial_pay',
        'summary_file',
      ].map((key) => [key, true]),
    );
  });

  it('shows the home seeds and the home checks on Task detail', async () => {
    const list = await world.read('/suites', z.array(SuiteListRowSchema));
    const suite = list.find((s) => s.name === 'phase6')!;
    const task = await world.read(`/suites/${suite.suiteId}/tasks/remember`, TaskDetailSchema);
    const expected = readFileSync(
      join(PHASE6_SUITE.dir, 'remember', 'expected_home', 'memories', 'MEMORY.md'),
      'utf8',
    );
    expect(task.homeFiles).toEqual([
      {
        kind: 'home_seed',
        path: 'home/memories/MEMORY.md',
        homePath: 'memories/MEMORY.md',
        sizeBytes: Buffer.byteLength(SEEDS['memories/MEMORY.md']),
        sha256: sha(SEEDS['memories/MEMORY.md']),
        text: SEEDS['memories/MEMORY.md'],
      },
      {
        kind: 'home_seed',
        path: 'home/memories/USER.md',
        homePath: 'memories/USER.md',
        sizeBytes: Buffer.byteLength(SEEDS['memories/USER.md']),
        sha256: sha(SEEDS['memories/USER.md']),
        text: SEEDS['memories/USER.md'],
      },
      {
        kind: 'expected_home',
        path: 'expected_home/memories/MEMORY.md',
        homePath: 'memories/MEMORY.md',
        sizeBytes: Buffer.byteLength(expected),
        sha256: sha(expected),
        text: expected,
      },
    ]);
    // Seeds and the expected home are never fixtures, so never in the workspace.
    expect(task.fixtures.map((f) => f.path)).toEqual(['vendors.csv']);
    expect(task.verification.find((v) => v.key === 'saved')?.sentence).toBe(
      'file_check: memories/MEMORY.md in the home exists as text; contains "largest first"',
    );
    expect(task.selfCheck.results.map((r) => [r.key, r.status, r.note])).toEqual([
      [
        'saved',
        'passed',
        'passes on the expected home; fails on the home seeds alone, as it should',
      ],
      [
        'kept',
        'passed',
        'passes on the expected home; fails on the home seeds alone, as it should',
      ],
      ['count', 'passed', 'scored against the reference answer'],
    ]);
    const [row] = await world.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.key, 'remember'), eq(tasks.suiteId, suite.suiteId)));
    const kinds = await world.db
      .select({ path: taskFiles.path, kind: taskFiles.kind })
      .from(taskFiles)
      .where(eq(taskFiles.taskId, row!.id));
    expect(kinds.filter((f) => f.kind !== 'fixture' && f.kind !== 'verifier')).toEqual(
      expect.arrayContaining([
        { path: 'home/memories/MEMORY.md', kind: 'home_seed' },
        { path: 'home/memories/USER.md', kind: 'home_seed' },
        { path: 'expected_home/memories/MEMORY.md', kind: 'expected_home' },
      ]),
    );
  });

  it('uploads a skill and saves the configurations', async () => {
    const validated = await request(world.api.getHttpServer())
      .post('/api/resources/skills/validate')
      .set('X-Requested-With', 'hermes-evals')
      .attach('file', await invoiceMethodZip(), 'invoice-method.zip')
      .expect(200);
    const { token } = SkillUploadValidationSchema.parse(validated.body);
    skillId = (await world.send('post', '/resources/skills', { token }, 201, SkillRowSchema)).id;

    configs.memoryOff = await world.configuration('memory-off', 'mock/scripted');
    configs.memoryOn = await world.configuration('memory-on', 'mock/scripted', {
      memoryEnabled: true,
    });
    configs.preload = await world.configuration('skill-preload', 'mock/scripted', {
      skillIds: [skillId],
    });
    configs.onDemand = await world.configuration('skill-on-demand', 'mock/scripted', {
      skillIds: [skillId],
      skillLoading: 'on_demand',
    });

    const detail = await world.read(
      `/configurations/${configs.onDemand.configurationId}`,
      ConfigurationDetailSchema,
    );
    expect(detail.shown.skillLoading).toBe('on_demand');
    const diff = await world.read(
      `/configurations/diff?versions=${configs.preload.versionId},${configs.onDemand.versionId}`,
      ConfigDiffSchema,
    );
    expect(diff.rows.find((r) => r.field === 'skill_loading')).toEqual({
      field: 'skill_loading',
      values: ['preload', 'on demand'],
      differs: true,
    });

    // On demand without a skill has nothing to find: refused at save.
    const refused = await world.refused(
      'post',
      '/configurations',
      {
        name: 'on-demand-nothing',
        model: 'mock/scripted',
        provider: 'custom',
        baseUrl: 'http://mock-model:8090/v1',
        toolsets: ['file'],
        memoryEnabled: false,
        skillIds: [],
        skillLoading: 'on_demand',
        documentIds: [],
        mcpServerVersionIds: [],
        maxTurns: 10,
        timeBudgetS: 120,
        duplicatedFromVersionId: null,
      },
      400,
    );
    expect(refused.issues).toEqual([{ path: 'skillLoading', message: SKILL_LOADING_NEEDS_SKILLS }]);
  });

  it('seeds the home with memory on only, collects the memory file and scores it', async () => {
    const id = await world.launch('memory', configs.memoryOff, [configs.memoryOn]);
    const runs = await runsByConfiguration(id);
    const off = runs.get('memory-off')!;
    const on = runs.get('memory-on')!;

    // P1, Phase 8 G9: the seeds in the home only with memory on; memory off lists them as skipped.
    for (const [run, memoryEnabled] of [
      [off, false],
      [on, true],
    ] as const) {
      const seen = trials.of(run.id)!;
      expect(seen.memoryEnabled).toBe(memoryEnabled);
      // Phase 6 #1: memory on adds the memory toolset at launch, once.
      expect(toolsetsOf(seen.argv)).toEqual(
        memoryEnabled ? ['file', 'memory', 'terminal'] : ['file', 'terminal'],
      );
      expect(seen.memories).toEqual(memoryEnabled ? SEEDS : {});
      expect(run.launchRecord?.homeSeeds).toEqual(
        memoryEnabled
          ? [
              { path: 'memories/MEMORY.md', sha256: sha(SEEDS['memories/MEMORY.md']) },
              { path: 'memories/USER.md', sha256: sha(SEEDS['memories/USER.md']) },
            ]
          : [],
      );
      expect(run.launchRecord?.homeMemory).toEqual({
        memoryEnabled,
        seedsSkipped: memoryEnabled ? [] : ['memories/MEMORY.md', 'memories/USER.md'],
        memoriesCollected: memoryEnabled,
      });
      // P3: Hermes's defaults written explicitly, the same in every arm.
      expect(run.launchRecord?.backgroundReview).toEqual({
        memoryNudgeInterval: 10,
        skillCreationNudgeInterval: 10,
      });
      expect(run.launchRecord?.configYaml).toMatch(/nudge_interval: 10/);
      expect(run.launchRecord?.configYaml).toMatch(/creation_nudge_interval: 10/);
    }

    // P2: the memory files are collected with root home, labelled against the seeds; with memory off, none.
    const homeOf = (run: RunDetail) =>
      run.artifacts.items.filter((a) => a.root === 'home').map((a) => [a.path, a.origin]);
    expect(homeOf(on)).toEqual([
      ['home/memories/MEMORY.md', 'home_seed_modified'],
      ['home/memories/USER.md', 'home_seed_unchanged'],
    ]);
    expect(homeOf(off)).toEqual([]);
    expect(off.timeline.events.find((e) => e.title === 'collected')?.text).toBe(
      'Memory was off, so home/memories was not collected.',
    );
    // Memory files are not the workspace: neither run wrote a file there.
    expect([on.artifacts.agentWroteNothing, off.artifacts.agentWroteNothing]).toEqual([true, true]);
    const saved = on.artifacts.items.find((a) => a.path === 'home/memories/MEMORY.md')!;
    const content = await request(world.api.getHttpServer())
      .get(`/api/runs/${on.id}/artifacts/${saved.id}/content`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((content.body as Buffer).toString('utf8')).toBe(SAVED_MEMORY);
    const stored = await world.db
      .select({ root: artifacts.root, path: artifacts.path, sha256: artifacts.sha256 })
      .from(artifacts)
      .where(and(eq(artifacts.root, 'home'), eq(artifacts.path, 'memories/MEMORY.md')));
    // Only memory on's: memory off collects nothing from the home (Phase 8 G9).
    expect(stored.map((a) => a.sha256)).toEqual([sha(SAVED_MEMORY)]);
    const collected = on.timeline.events.find((e) => e.title === 'collected');
    expect(collected?.summary).toMatch(/2 memory files/);

    // file_check root home and the verifier reading --home score what was saved.
    expect([on.primary, off.primary]).toEqual([
      { key: 'saved', status: 'passed' },
      { key: 'saved', status: 'failed' },
    ]);
    expect([scoreOf(on, 'kept')?.status, scoreOf(on, 'kept')?.score]).toEqual(['passed', 1]);
    // Memory off leaves no MEMORY.md for the verifier to read: nothing kept, nothing added.
    expect([scoreOf(off, 'kept')?.status, scoreOf(off, 'kept')?.score]).toEqual(['failed', 0]);
    expect([scoreOf(on, 'count')?.status, scoreOf(off, 'count')?.status]).toEqual([
      'passed',
      'passed',
    ]);
  }, 180_000);

  it('loads skills on demand without -s and with the skills toolset; preload is unchanged', async () => {
    const id = await world.launch('skills', configs.preload, [configs.onDemand]);
    const runs = await runsByConfiguration(id);
    const preload = runs.get('skill-preload')!;
    const onDemand = runs.get('skill-on-demand')!;

    const pre = trials.of(preload.id)!;
    expect(preloadedOf(pre.argv)).toEqual(['invoice-method']);
    expect(toolsetsOf(pre.argv)).toEqual(['file', 'terminal']);
    const lazy = trials.of(onDemand.id)!;
    expect(preloadedOf(lazy.argv)).toEqual([]);
    expect(toolsetsOf(lazy.argv)).toEqual(['file', 'skills', 'terminal']);
    // Installed in the home either way; on demand the agent finds it with the toolset.
    expect([pre.skills, lazy.skills]).toEqual([['invoice-method'], ['invoice-method']]);

    expect(preload.launchRecord?.container.skillLoading).toBe('preload');
    expect(preload.launchRecord?.command).toMatch(/ -s invoice-method /);
    expect(onDemand.launchRecord?.container.skillLoading).toBe('on_demand');
    expect(onDemand.launchRecord?.command).not.toMatch(/ -s /);
    expect(onDemand.launchRecord?.command).toMatch(/ -t file,skills,terminal /);
    expect(onDemand.launchRecord?.configYaml).toMatch(/toolsets:[\s\S]*skills/);
  }, 180_000);

  it('refuses a launch while a chosen configuration names an unset MCP variable', async () => {
    const ledger = await world.send(
      'post',
      '/resources/mcp-servers',
      LEDGER_DB,
      201,
      McpServerRowSchema,
    );
    const vendors = await world.send(
      'post',
      '/resources/mcp-servers',
      VENDOR_DIRECTORY,
      201,
      McpServerRowSchema,
    );
    const withMcp = await world.configuration('with-mcp', 'mock/scripted', {
      mcpServerVersionIds: [ledger.versionId, vendors.versionId],
    });
    const missing: MissingMcpSecret[] = [
      { server: 'ledger-db', name: 'PHASE6_E2E_LEDGER_URL', transport: 'stdio' },
      { server: 'vendor-directory', name: 'VENDOR_DIRECTORY_TOKEN', transport: 'http' },
    ];

    const options = await world.read('/experiments/new-options', NewExperimentOptionsSchema);
    const optionOf = (ref: ConfigRef) =>
      options.configurations.find((o) => o.versionId === ref.versionId);
    expect(optionOf(withMcp)?.missingSecrets).toEqual(missing);
    expect(optionOf(configs.memoryOff)?.missingSecrets).toEqual([]);
    expect(optionOf(configs.onDemand)?.skillLoading).toBe('on_demand');

    const before = (await world.db.select({ id: experiments.id }).from(experiments)).length;
    const body = await world.launchBody('mcp', configs.memoryOff, [withMcp]);
    const res = await request(world.api.getHttpServer())
      .post('/api/experiments')
      .set('X-Requested-With', 'hermes-evals')
      .send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const conflict = MissingSecretsConflictSchema.parse(res.body);
    expect(ApiErrorBodySchema.parse(res.body).message).toBe(
      missingSecretsConflictMessage([{ configuration: 'with-mcp', missing }]),
    );
    expect(conflict.issues).toEqual(
      missing.map((s) => ({ path: 'candidateVersionIds.0', message: missingSecretText(s) })),
    );
    expect((await world.db.select({ id: experiments.id }).from(experiments)).length).toBe(before);
  });
});
