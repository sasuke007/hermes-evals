/**
 * buildAttemptPlan on PGlite, for what Phase 6 added to the plan: the task's
 * home seeds (P1), how the configuration's skills load (P5) and the `memory`
 * toolset memory on brings (Phase 6 #1), carried through to the `hermes
 * chat` command and config.yaml the runner builds from the plan.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { blob } from '../../../test/support/seed.js';
import {
  configurations,
  configurationVersions,
  skills,
  taskFiles,
} from '../../database/schema/index.js';
import type { SkillLoadingMode } from '@hermes-evals/shared';
import { hermesChatCmd } from '../attempt/launch.js';
import { attemptConfig } from '../attempt/trial-config.js';
import { buildAttemptPlan, PlanError, plannedToolsets } from './plan.js';
import {
  HERMES_REVISION,
  MOCK_BASE_URL,
  MOCK_MODEL,
  seedLifecycle,
  sha,
  type LifecycleSeed,
} from './testing.support-spec.js';
import type { ClaimedAttempt } from './types.js';

let t: TestDatabase;
let seed: LifecycleSeed;

beforeEach(async () => {
  t = await createTestDatabase();
  seed = await seedLifecycle(t.db);
});

afterEach(async () => {
  await t.close();
});

const PLAN_INPUT = {
  slot: 'hermes-evals-trial-1',
  trialsDir: '/trials',
  token: 'tok_'.padEnd(43, 'Z'),
  hermesRevision: HERMES_REVISION,
};

/** What the claim hands the plan for the seeded experiment's first task under `versionId`. */
const claimed = (configurationVersionId: string): ClaimedAttempt => ({
  attemptId: 'att_1',
  leaseToken: 'lease',
  attemptNumber: 1,
  trigger: 'initial',
  runId: seed.runIds[0]!,
  experimentId: seed.experimentId,
  taskId: seed.taskIds[0]!,
  configurationVersionId,
  provider: 'custom',
  model: MOCK_MODEL,
  workerId: 'wrk_1',
});

async function seedSkill(name: string): Promise<string> {
  const [row] = await t.db
    .insert(skills)
    .values({
      name,
      version: '1.0.0',
      description: `${name} method`,
      contentHash: sha(`skill ${name}`),
      fileCount: 1,
      sizeBytes: 100,
    })
    .returning({ id: skills.id });
  return row!.id;
}

/** The settings a test version varies; the rest are the seeded baseline's. */
interface VersionSettings {
  toolsets?: string[];
  skillIds?: string[];
  skillLoading?: SkillLoadingMode;
  memoryEnabled?: boolean;
}

/** A frozen version with `settings`, created with its configuration as the configuration service does. */
async function frozenVersion(name: string, settings: VersionSettings = {}): Promise<string> {
  return t.db.transaction(async (tx) => {
    const [configuration] = await tx.insert(configurations).values({ name }).returning();
    const [version] = await tx
      .insert(configurationVersions)
      .values({
        configurationId: configuration!.id,
        version: 1,
        model: MOCK_MODEL,
        provider: 'custom',
        baseUrl: MOCK_BASE_URL,
        toolsets: settings.toolsets ?? ['terminal', 'file'],
        memoryEnabled: settings.memoryEnabled ?? false,
        skillIds: settings.skillIds ?? [],
        skillLoading: settings.skillLoading ?? 'preload',
        maxTurns: 20,
        timeBudgetS: 300,
        configHash: sha(`config ${name}`),
        frozenAt: new Date(),
      })
      .returning({ id: configurationVersions.id });
    return version!.id;
  });
}

/** A frozen version with two skills, loaded as `skillLoading` says. */
async function skilledVersion(
  name: string,
  skillLoading: SkillLoadingMode,
  toolsets = ['terminal', 'file'],
  memoryEnabled = false,
): Promise<string> {
  const skillIds = [await seedSkill(`${name}-a`), await seedSkill(`${name}-b`)];
  return frozenVersion(name, { toolsets, skillIds, skillLoading, memoryEnabled });
}

/** The stored row of a version: what the configuration hash was computed over. */
const storedVersion = async (id: string) =>
  (await t.db.select().from(configurationVersions).where(eq(configurationVersions.id, id)))[0]!;

const flagValue = (cmd: string[], flag: string) => cmd[cmd.indexOf(flag) + 1];

describe('skill loading', () => {
  it('plans a version without skills as preload with its own toolsets', async () => {
    const plan = await buildAttemptPlan(t.db, claimed(seed.baselineVersionId), PLAN_INPUT);
    expect(plan.configuration).toMatchObject({
      skillLoading: 'preload',
      skills: [],
      toolsets: ['file', 'terminal'],
    });
  });

  it('preloads: the version’s toolsets, and -s per skill', async () => {
    const id = await skilledVersion('preloaded', 'preload');
    const plan = await buildAttemptPlan(t.db, claimed(id), PLAN_INPUT);
    expect(plan.configuration.skillLoading).toBe('preload');
    expect(plan.configuration.toolsets).toEqual(['file', 'terminal']);
    const cmd = hermesChatCmd(plan);
    expect(flagValue(cmd, '-t')).toBe('file,terminal');
    expect(cmd.filter((_, i) => cmd[i - 1] === '-s')).toEqual(['preloaded-a', 'preloaded-b']);
  });

  it('on demand: the skills toolset once, no -s, and config.yaml listing the same toolsets', async () => {
    const id = await skilledVersion('on-demand', 'on_demand', ['terminal', 'skills', 'file']);
    const plan = await buildAttemptPlan(t.db, claimed(id), PLAN_INPUT);
    expect(plan.configuration.skillLoading).toBe('on_demand');
    expect(plan.configuration.toolsets).toEqual(['file', 'skills', 'terminal']);
    // Still installed in home/skills/: only how the agent reaches them changes.
    expect(plan.configuration.skills.map((s) => s.name)).toEqual(['on-demand-a', 'on-demand-b']);
    const cmd = hermesChatCmd(plan);
    expect(cmd).not.toContain('-s');
    expect(flagValue(cmd, '-t')).toBe('file,skills,terminal');
    expect((attemptConfig(plan) as { toolsets: string[] }).toolsets).toEqual([
      'file',
      'skills',
      'terminal',
    ]);
  });

  it('adds the skills toolset only for on demand loading', () => {
    const off = { memoryEnabled: false };
    expect(
      plannedToolsets(['terminal', 'file', 'terminal'], { skillLoading: 'preload', ...off }),
    ).toEqual(['file', 'terminal']);
    expect(plannedToolsets([], { skillLoading: 'on_demand', ...off })).toEqual(['skills']);
    expect(plannedToolsets(['web', 'skills'], { skillLoading: 'on_demand', ...off })).toEqual([
      'skills',
      'web',
    ]);
  });
});

describe('the memory toolset (Phase 6 #1)', () => {
  it('memory on: the memory toolset once, in -t and config.yaml, and the stored version untouched', async () => {
    const id = await frozenVersion('memory-on', { memoryEnabled: true });
    const before = await storedVersion(id);
    const plan = await buildAttemptPlan(t.db, claimed(id), PLAN_INPUT);
    expect(plan.configuration).toMatchObject({
      memoryEnabled: true,
      toolsets: ['file', 'memory', 'terminal'],
    });
    const cmd = hermesChatCmd(plan);
    expect(flagValue(cmd, '-t')).toBe('file,memory,terminal');
    expect((attemptConfig(plan) as { toolsets: string[] }).toolsets).toEqual([
      'file',
      'memory',
      'terminal',
    ]);
    // Derived at launch: the version keeps the toolsets and the hash it was saved with.
    const after = await storedVersion(id);
    expect(after.toolsets).toEqual(['terminal', 'file']);
    expect(after.configHash).toBe(before.configHash);
  });

  it('memory off: the version’s own toolsets, with or without memory among them', async () => {
    const plain = await buildAttemptPlan(t.db, claimed(seed.baselineVersionId), PLAN_INPUT);
    expect(plain.configuration).toMatchObject({
      memoryEnabled: false,
      toolsets: ['file', 'terminal'],
    });
    expect(flagValue(hermesChatCmd(plain), '-t')).toBe('file,terminal');

    // Removing nothing: Hermes hides the memory tool while memory is off whatever -t says.
    const listed = await frozenVersion('memory-off-listed', {
      toolsets: ['memory', 'terminal', 'file'],
    });
    const plan = await buildAttemptPlan(t.db, claimed(listed), PLAN_INPUT);
    expect(flagValue(hermesChatCmd(plan), '-t')).toBe('file,memory,terminal');
  });

  it('memory on with skills on demand adds both, each once', async () => {
    const id = await skilledVersion('both', 'on_demand', ['memory', 'terminal', 'file'], true);
    const plan = await buildAttemptPlan(t.db, claimed(id), PLAN_INPUT);
    expect(flagValue(hermesChatCmd(plan), '-t')).toBe('file,memory,skills,terminal');
    expect(
      plannedToolsets(['memory', 'file'], { skillLoading: 'preload', memoryEnabled: true }),
    ).toEqual(['file', 'memory']);
    expect(plannedToolsets([], { skillLoading: 'preload', memoryEnabled: true })).toEqual([
      'memory',
    ]);
  });
});

describe('home seeds', () => {
  it('plans the task’s home seeds relative to the home, sorted, beside its fixtures', async () => {
    const taskId = seed.taskIds[0]!;
    await t.db.insert(taskFiles).values([
      {
        taskId,
        path: 'home/memories/USER.md',
        kind: 'home_seed',
        sha256: await blob(t.db, 'user profile'),
        size: 12,
      },
      {
        taskId,
        path: 'home/memories/MEMORY.md',
        kind: 'home_seed',
        sha256: await blob(t.db, 'memory'),
        size: 6,
      },
      {
        taskId,
        path: 'expected_home/memories/MEMORY.md',
        kind: 'expected_home',
        sha256: await blob(t.db, 'memory after'),
        size: 12,
      },
    ]);
    const plan = await buildAttemptPlan(t.db, claimed(seed.baselineVersionId), PLAN_INPUT);
    expect(plan.task.homeSeeds).toEqual([
      { path: 'memories/MEMORY.md', sha256: sha('memory'), size: 6 },
      { path: 'memories/USER.md', sha256: sha('user profile'), size: 12 },
    ]);
    expect(plan.task.fixtures.map((f) => f.path)).toEqual(['invoices.csv']);
  });

  it('plans none for a task without them, and refuses a seed outside memories/', async () => {
    const plan = await buildAttemptPlan(t.db, claimed(seed.baselineVersionId), PLAN_INPUT);
    expect(plan.task.homeSeeds).toEqual([]);

    await t.db.insert(taskFiles).values({
      taskId: seed.taskIds[0]!,
      path: 'home/.env',
      kind: 'home_seed',
      sha256: await blob(t.db, 'X=1'),
      size: 3,
    });
    const refused = buildAttemptPlan(t.db, claimed(seed.baselineVersionId), PLAN_INPUT);
    await expect(refused).rejects.toBeInstanceOf(PlanError);
    await expect(refused).rejects.toThrow('task task_1 has a home seed at home/.env');
  });
});
