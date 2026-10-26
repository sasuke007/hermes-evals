/**
 * The background review intervals config.yaml pins (Phase 6 P3): Hermes's
 * own defaults, written out in every trial whatever the configuration, and
 * the same values in the launch record.
 */
import { LaunchRecordSchema } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  BACKGROUND_REVIEW,
  backgroundReviewRecord,
  configYaml,
  hermesConfig,
  type HermesConfigInput,
} from './trial-config.js';

const input = (memoryEnabled: boolean): HermesConfigInput => ({
  model: {
    default: 'mock/scripted',
    provider: 'custom',
    base_url: 'http://egress:8080/v1',
    context_length: 131072,
  },
  toolsets: ['file', 'skills'],
  memoryEnabled,
  maxTurns: 6,
  runBudgetSeconds: 120,
  mcpServers: [],
});

describe('background review in config.yaml', () => {
  it.each([false, true])(
    "writes Hermes's default intervals with memory_enabled %s",
    (memoryEnabled) => {
      const config = parse(configYaml(hermesConfig(input(memoryEnabled)))) as Record<
        string,
        Record<string, unknown>
      >;
      expect(config.memory).toEqual({
        memory_enabled: memoryEnabled,
        user_profile_enabled: memoryEnabled,
        nudge_interval: 10,
      });
      // agent_init.py reads the skill interval from the top-level skills section.
      expect(config.skills).toEqual({ creation_nudge_interval: 10 });
    },
  );

  it('states the same intervals in the launch record', () => {
    expect(BACKGROUND_REVIEW).toEqual({ memoryNudgeInterval: 10, skillCreationNudgeInterval: 10 });
    expect(LaunchRecordSchema.shape.background_review.parse(backgroundReviewRecord())).toEqual({
      memory_nudge_interval: 10,
      skill_creation_nudge_interval: 10,
    });
  });
});
