import { describe, expect, it } from 'vitest';
import type { RunCounts } from '@hermes-evals/shared';
import { doneRuns, emptyCounts } from './numbers.js';

const counts = (patch: Partial<RunCounts>): RunCounts => ({ ...emptyCounts(), ...patch });

describe('doneRuns', () => {
  it('counts every settled run of a finished experiment, so its bar is full', () => {
    // 'MCP smoke test': 71 scored and one execution error is 72 of 72.
    expect(doneRuns('completed', counts({ scored: 71, execution_error: 1 }))).toBe(72);
    // Cancelled, then completed: 40 scored and 80 cancelled is 120 of 120.
    expect(doneRuns('completed', counts({ scored: 40, cancelled: 80 }))).toBe(120);
    // The breaker's experiment counts its errors, and what is still settling is not done.
    expect(doneRuns('failed', counts({ scored: 3, execution_error: 14, scoring: 1 }))).toBe(17);
  });

  it('counts only scored runs while the experiment runs or is paused', () => {
    const live = counts({ scored: 5, execution_error: 2, cancelled: 1, running: 3, queued: 9 });
    expect(doneRuns('running', live)).toBe(5);
    expect(doneRuns('paused', live)).toBe(5);
  });
});
