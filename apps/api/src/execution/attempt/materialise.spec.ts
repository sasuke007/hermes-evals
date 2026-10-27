/**
 * Home seeds in materialisation (Phase 6 P1, Phase 8 G9): with memory on
 * each seed is copied, hash re-checked, to its place under the trial home's
 * memories/, and listed with its hash among the launch record's inputs;
 * with memory off none is, and the record's `home_memory` lists them as
 * skipped. Nothing else of the task reaches the home.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HomeMemoryRecordSchema, LaunchRecordSchema } from '@hermes-evals/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareTrialDirs } from '../../sandbox/trial-runner.js';
import type { AttemptPlan } from '../contracts.js';
import { AttemptSetupError } from './errors.js';
import { materialiseTrial } from './materialise.js';
import { createAttemptWorld, type AttemptWorld } from './testing.helper-spec.js';

const USER_MD = 'Works in Lisbon.\n§\nPrefers reports in EUR.';
const MEMORY_MD = 'ACME Ltd and ACME Limited are one vendor.';

let world: AttemptWorld;
let seeds: AttemptPlan['task']['homeSeeds'];

beforeAll(async () => {
  world = await createAttemptWorld();
  const memory = await world.blobs.putBuffer(Buffer.from(MEMORY_MD));
  const user = await world.blobs.putBuffer(Buffer.from(USER_MD));
  seeds = [
    { path: 'memories/MEMORY.md', sha256: memory.sha256, size: memory.size },
    { path: 'memories/USER.md', sha256: user.sha256, size: user.size },
  ];
});
afterAll(() => world.cleanup());

/** A plan for this world with the given seeds, its trial directories made fresh. */
async function prepared(
  homeSeeds: AttemptPlan['task']['homeSeeds'],
  memoryEnabled: boolean,
): Promise<AttemptPlan> {
  const plan = world.plan({
    task: { homeSeeds },
    configuration: { memoryEnabled, skillLoading: 'preload' },
  });
  await prepareTrialDirs(world.trialsDir, plan.attemptId);
  return plan;
}

const deps = () => ({ blobs: world.blobs, skillsDir: world.skillsDir });

describe('materialiseTrial with home seeds', () => {
  it('with memory on copies each seed into home/memories/', async () => {
    const plan = await prepared(seeds, true);
    const built = await materialiseTrial(plan, 'model: {}\n', deps());
    const memories = join(plan.paths.home, 'memories');
    expect((await readdir(memories)).sort()).toEqual(['MEMORY.md', 'USER.md']);
    expect(await readFile(join(memories, 'USER.md'), 'utf8')).toBe(USER_MD);
    expect(await readFile(join(memories, 'MEMORY.md'), 'utf8')).toBe(MEMORY_MD);
    // Listed with their hashes after the workspace inputs, home-relative.
    expect(built.inputs.filter((i) => i.source === 'home_seed')).toEqual(
      seeds.map((s) => ({ path: s.path, sha256: s.sha256, source: 'home_seed' })),
    );
    expect(LaunchRecordSchema.shape.inputs.parse(built.inputs).map((i) => i.source)).toEqual([
      'fixture',
      'document',
      'home_seed',
      'home_seed',
    ]);
    expect([...built.homeSeeds]).toEqual(
      seeds.map((s) => [s.path, { source: 'home_seed', sha256: s.sha256, size: s.size }]),
    );
    expect(HomeMemoryRecordSchema.parse(built.homeMemory)).toEqual({
      memory_enabled: true,
      seeds_skipped: [],
      memories_collected: true,
    });
    // Seeds never land in the workspace.
    expect(await readdir(plan.paths.workspace)).not.toContain('memories');
  });

  it('with memory off copies no seed, and says which it left out', async () => {
    // Phase 8 G9: the real model read a seeded USER.md with its file tools while memory was off.
    const plan = await prepared(seeds, false);
    const built = await materialiseTrial(plan, 'model: {}\n', deps());
    expect(await readdir(plan.paths.home)).not.toContain('memories');
    expect(await readdir(plan.paths.workspace)).not.toContain('memories');
    expect(built.homeSeeds.size).toBe(0);
    expect(LaunchRecordSchema.shape.inputs.parse(built.inputs).map((i) => i.source)).toEqual([
      'fixture',
      'document',
    ]);
    expect(HomeMemoryRecordSchema.parse(built.homeMemory)).toEqual({
      memory_enabled: false,
      seeds_skipped: ['memories/MEMORY.md', 'memories/USER.md'],
      memories_collected: false,
    });
  });

  it('leaves the home without memories/ when the task has no seed', async () => {
    const plan = await prepared([], true);
    const built = await materialiseTrial(plan, 'model: {}\n', deps());
    expect(await readdir(plan.paths.home)).not.toContain('memories');
    expect(built.homeSeeds.size).toBe(0);
    expect(built.inputs.some((i) => i.source === 'home_seed')).toBe(false);
  });

  it('refuses a seed whose stored copy changed, or that would land anywhere else', async () => {
    const tampered = await world.blobs.putBuffer(Buffer.from('original'));
    // The blob store's copy no longer hashes to its name.
    await writeFile(world.blobs.path(tampered.sha256), 'changed!');
    const changed = await prepared(
      [{ path: 'memories/USER.md', sha256: tampered.sha256, size: tampered.size }],
      true,
    );
    await expect(materialiseTrial(changed, 'model: {}\n', deps())).rejects.toThrow(
      new AttemptSetupError(
        'home seed memories/USER.md does not match its recorded hash: the blob store copy has changed',
      ),
    );

    const elsewhere = await prepared([{ ...seeds[0]!, path: 'config.yaml' }], true);
    await expect(materialiseTrial(elsewhere, 'model: {}\n', deps())).rejects.toThrow(
      'home seed config.yaml is not one of memories/MEMORY.md, memories/USER.md',
    );
  });
});
