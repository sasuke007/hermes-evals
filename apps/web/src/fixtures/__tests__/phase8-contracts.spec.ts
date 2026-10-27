/**
 * Phase 8's fixtures parse with their shared contracts: GET /system/setup (the judge and the
 * samples seed) in each of its scenarios, and the judge fields New experiment's options carry
 * for the mock-judge warning. The data-layer functions that serve them are checked in
 * src/api/__tests__ (contracts.spec.ts sweeps every scenario).
 */
import { describe, expect, it } from 'vitest';
import {
  mockJudgeWarning,
  NewExperimentOptionsSchema,
  seedCounts,
  SystemSetupSchema,
} from '@hermes-evals/shared';
import { newExperimentOptionsFixture } from '@/fixtures/experiments';
import { systemSetupFixture } from '@/fixtures/setup';

describe('Phase 8 fixtures', () => {
  it('serve the judge and a finished seed with one item of each outcome', () => {
    const setup = SystemSetupSchema.parse(systemSetupFixture());
    expect(setup.judge.mock).toBe(false);
    expect(setup.seed.state).toBe('done');
    expect(seedCounts(setup.seed)).toEqual({ created: 3, skipped: 2, failed: 0 });
  });

  it('serve each seed state and the mock judge in their scenarios', () => {
    const setup = (scenario: string) =>
      SystemSetupSchema.parse(systemSetupFixture((name) => name === scenario));
    expect(setup('seed-off').seed.state).toBe('off');
    expect(setup('seed-running').seed.state).toBe('running');
    expect(setup('seed-failed').seed.state).toBe('failed');
    expect(seedCounts(setup('seed-item-failed').seed)).toEqual({
      created: 3,
      skipped: 2,
      failed: 1,
    });
    for (const scenario of ['judge-mock', 'samples-seeded']) {
      expect(setup(scenario).judge).toEqual({
        provider: 'custom',
        model: 'mock/scripted',
        mock: true,
        mockModelName: false,
      });
      // New experiment's options and System say the same of the judge.
      const options = newExperimentOptionsFixture((name) => name === scenario);
      expect(options.judge).toEqual(setup(scenario).judge);
    }
    expect(setup('judge-mock-name').judge).toEqual({
      provider: 'custom',
      model: 'mock/scripted',
      mock: false,
      mockModelName: true,
    });
    expect(newExperimentOptionsFixture((name) => name === 'judge-mock-name').judge).toEqual(
      setup('judge-mock-name').judge,
    );
  });

  it('give New experiment a real judge, so the fixture world never warns', () => {
    for (const scenario of ['', 'openrouter-in-use', 'no-history', 'secret-not-set']) {
      const options = NewExperimentOptionsSchema.parse(
        newExperimentOptionsFixture((name) => name === scenario),
      );
      const tasks = options.suites.flatMap((s) => s.tasks);
      expect(tasks.some((t) => t.hasLlmJudge)).toBe(true);
      expect(options.configurations.every((c) => !c.mockModel)).toBe(true);
      expect(mockJudgeWarning(options.judge, options.configurations, tasks)).toBe(null);
    }
  });
});
