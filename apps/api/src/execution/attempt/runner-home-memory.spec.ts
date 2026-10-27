/**
 * The home's memory through the whole attempt runner (Phase 6 P1 and P2,
 * Phase 8 G9): with memory on the task's home seeds are copied in, the
 * memory files left in the home are collected before it is deleted, and the
 * launch record says so; with memory off no seed is copied in, nothing in
 * home/memories is collected, and the launch record lists the seeds it left
 * out.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchRecordSchema } from '@hermes-evals/shared';
import { hermesRun } from '../../../test/support/fake-engine.js';
import type { AttemptPlan } from '../contracts.js';
import {
  createAttemptWorld,
  MemorySink,
  runnerKit,
  snapshotTree,
  type AttemptWorld,
} from './testing.helper-spec.js';

const SEEDED = 'Works in Lisbon.';

let world: AttemptWorld;

beforeEach(async () => {
  world = await createAttemptWorld();
});

afterEach(async () => {
  await world.cleanup();
});

/**
 * Runs a plan with one seed (memories/USER.md) whose agent saves to both
 * stores, writes a file elsewhere in the home and leaves a link in
 * memories/; returns the outcome, the launch record and the home as the
 * container first saw it.
 */
async function runWithSeed(memoryEnabled: boolean) {
  const seed = await world.blobs.putBuffer(Buffer.from(SEEDED));
  const plan: AttemptPlan = world.plan({
    task: { homeSeeds: [{ path: 'memories/USER.md', sha256: seed.sha256, size: seed.size }] },
    configuration: { memoryEnabled },
  });
  let homeAtStart: Record<string, string> = {};
  const { runner } = runnerKit(world, (info) => {
    homeAtStart = snapshotTree(info.homeDir!);
    const run = hermesRun('done');
    run.steps!.push(
      {
        file: { in: 'home', path: 'memories/USER.md', content: `${SEEDED}\n§\nReports in EUR.` },
      },
      { file: { in: 'home', path: 'memories/MEMORY.md', content: 'ACME is one vendor.' } },
      // Nothing else of the home is collected, and no link is followed.
      { file: { in: 'home', path: 'notes.txt', content: 'not collected' } },
      { symlink: { in: 'home', path: 'memories/escape', target: world.trialsDir } },
    );
    return run;
  });
  const sink = new MemorySink(plan.attemptId);
  const outcome = await runner.run(plan, sink, new AbortController().signal);
  const collected = outcome.finalEvents.find((e) => e.payload.subtype === 'collected')!;
  return {
    plan,
    seed,
    outcome,
    homeAtStart,
    collected: collected.payload,
    record: LaunchRecordSchema.parse(sink.launch),
  };
}

describe('the home with memory on', () => {
  it('copies the seeds in and collects the memory files before deleting the home', async () => {
    const { plan, seed, outcome, homeAtStart, collected, record } = await runWithSeed(true);
    expect(homeAtStart['memories/USER.md']).toBe(SEEDED);
    expect(
      outcome.artifacts.filter((a) => a.root === 'home').map((a) => [a.path, a.origin]),
    ).toEqual([
      ['memories/MEMORY.md', 'agent'],
      ['memories/USER.md', 'home_seed_modified'],
    ]);
    expect(collected).toMatchObject({
      memories_collected: true,
      home_files: 2,
      home_agent_files: 1,
      home_not_collected: [
        { path: 'home/memories/escape', kind: 'symlink', detail: world.trialsDir },
      ],
      deleted_home_seeds: [],
    });
    expect(record.inputs.filter((i) => i.source === 'home_seed')).toEqual([
      { path: 'memories/USER.md', sha256: seed.sha256, source: 'home_seed' },
    ]);
    expect(record.home_memory).toEqual({
      memory_enabled: true,
      seeds_skipped: [],
      memories_collected: true,
    });
    expect(existsSync(plan.paths.home)).toBe(false);
  });
});

describe('the home with memory off (Phase 8 G9)', () => {
  it('copies no seed in, collects nothing from memories/, and records the seed it left out', async () => {
    const { plan, outcome, homeAtStart, collected, record } = await runWithSeed(false);
    // The real model read a seeded USER.md with its file tools while memory was off.
    expect(Object.keys(homeAtStart).filter((path) => path.startsWith('memories/'))).toEqual([]);
    // What the agent wrote there is not memory: no artifact, no home part on the event.
    expect(outcome.artifacts.filter((a) => a.root === 'home')).toEqual([]);
    expect(outcome.artifacts.map((a) => a.path)).not.toContain('memories/USER.md');
    expect(collected).toMatchObject({ memories_collected: false });
    expect(Object.keys(collected).filter((key) => key.startsWith('home_'))).toEqual([]);
    expect(record.inputs.some((i) => i.source === 'home_seed')).toBe(false);
    expect(record.home_memory).toEqual({
      memory_enabled: false,
      seeds_skipped: ['memories/USER.md'],
      memories_collected: false,
    });
    expect(existsSync(plan.paths.home)).toBe(false);
  });
});
