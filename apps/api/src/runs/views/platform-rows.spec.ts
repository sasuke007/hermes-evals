/**
 * The `collected` row with memory off (Phase 8 G9): the worker did not read
 * home/memories at all, and the row says so instead of showing no memory
 * files without a reason.
 */
import { TimelineEventSchema } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { platformRow } from './platform-rows.js';

const collected = (payload: Record<string, unknown>) =>
  TimelineEventSchema.parse(
    platformRow(4, 1_000, {
      type: 'platform',
      subtype: 'collected',
      files: 2,
      agent_files: 1,
      ...payload,
    }),
  );

describe('the collected row and memory', () => {
  it('says home/memories was not collected when memory was off', () => {
    const row = collected({ memories_collected: false });
    expect([row.summary, row.text]).toEqual([
      '2 files collected · 1 written by the agent',
      'Memory was off, so home/memories was not collected.',
    ]);
  });

  it('adds nothing with memory on, or on an event from before Phase 8', () => {
    for (const payload of [{ memories_collected: true, home_files: 0 }, {}]) {
      const row = collected(payload);
      expect([row.summary, row.text]).toEqual(['2 files collected · 1 written by the agent', null]);
    }
  });
});
