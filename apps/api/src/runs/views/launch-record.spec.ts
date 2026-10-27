/**
 * What Phase 6 added to the inspector's Launch record: how the skills
 * loaded (P5), the home seeds copied in (P1) and the background review
 * intervals config.yaml set (P3), on a record from a Phase 6 runner and on
 * one from before it. And what Phase 8 added (G9): what memory decided about
 * the home.
 */
import { describe, expect, it } from 'vitest';
import { LaunchRecordSchema, LaunchRecordViewSchema } from '@hermes-evals/shared';
import { sha } from '../../../test/support/seed.js';
import { launchRecordView } from './launch-record.js';
import { launchRecord } from './run-fixtures-spec.js';

const attempt = { startedAt: new Date('2026-10-24T15:00:00.000Z'), exitCode: 0 };
const view = (record: unknown) =>
  LaunchRecordViewSchema.parse(
    launchRecordView({ record, attempt, worker: null, fallbackImage: 'trial:x' }),
  );

describe('the launch record of Phase 6', () => {
  it('shows on demand loading, the home seeds and the intervals a Phase 6 runner recorded', () => {
    const base = launchRecord(sha('fixture'));
    const record = LaunchRecordSchema.parse({
      ...base,
      argv: base.argv.filter((arg) => arg !== '-s' && arg !== 'invoice-method'),
      skill_loading: 'on_demand',
      inputs: [
        ...base.inputs,
        { path: 'memories/MEMORY.md', sha256: sha('memory'), source: 'home_seed' },
        { path: 'memories/USER.md', sha256: sha('user'), source: 'home_seed' },
      ],
      background_review: { memory_nudge_interval: 10, skill_creation_nudge_interval: 10 },
    });
    const shown = view(record);
    expect(shown.container.skillLoading).toBe('on_demand');
    expect(shown.container.skills.map((s) => s.name)).toEqual(['invoice-method']);
    expect(shown.homeSeeds).toEqual([
      { path: 'memories/MEMORY.md', sha256: sha('memory') },
      { path: 'memories/USER.md', sha256: sha('user') },
    ]);
    expect(shown.backgroundReview).toEqual({
      memoryNudgeInterval: 10,
      skillCreationNudgeInterval: 10,
    });
  });

  it('reads a record from before Phase 6 as preload, with no seeds and no intervals', () => {
    const record: Record<string, unknown> = { ...launchRecord(sha('fixture')) };
    delete record.skill_loading;
    delete record.background_review;
    const shown = view(record);
    expect(shown.container.skillLoading).toBe('preload');
    expect(shown.homeSeeds).toEqual([]);
    expect(shown.backgroundReview).toBeNull();
    expect(shown.homeMemory).toBeNull();
  });
});

describe('the launch record of Phase 8 (G9)', () => {
  it('shows the seeds memory off left out, and that home/memories was not collected', () => {
    const record = LaunchRecordSchema.parse({
      ...launchRecord(sha('fixture')),
      home_memory: {
        memory_enabled: false,
        seeds_skipped: ['memories/USER.md'],
        memories_collected: false,
      },
    });
    const shown = view(record);
    expect(shown.homeMemory).toEqual({
      memoryEnabled: false,
      seedsSkipped: ['memories/USER.md'],
      memoriesCollected: false,
    });
    // Nothing was copied in, so no seed is listed as one.
    expect(shown.homeSeeds).toEqual([]);
  });

  it('shows memory on with every seed copied in', () => {
    const base = launchRecord(sha('fixture'));
    const shown = view({
      ...base,
      inputs: [
        ...base.inputs,
        { path: 'memories/USER.md', sha256: sha('user'), source: 'home_seed' },
      ],
      home_memory: { memory_enabled: true, seeds_skipped: [], memories_collected: true },
    });
    expect(shown.homeMemory).toEqual({
      memoryEnabled: true,
      seedsSkipped: [],
      memoriesCollected: true,
    });
    expect(shown.homeSeeds).toEqual([{ path: 'memories/USER.md', sha256: sha('user') }]);
  });

  it('reads a home_memory block that breaks its rules as absent, and still shows the record', () => {
    const shown = view({
      ...launchRecord(sha('fixture')),
      home_memory: { memory_enabled: false, seeds_skipped: [], memories_collected: true },
    });
    expect(shown.homeMemory).toBeNull();
    expect(shown.command).toContain('hermes');
  });
});
