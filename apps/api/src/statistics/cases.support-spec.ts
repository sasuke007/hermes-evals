/**
 * Constructed inputs for the statistics tests. Runs are written as the web's
 * cell letters: P passed, F failed, U ungradable, X scorer error (scored, by
 * the selected key) and E an execution error (timeout). A cancelled run is
 * simply absent, as it is from a StatsInput.
 */
import { computeComparisonStats, seedFromExperimentId } from './compute.js';
import type {
  ComputedStats,
  NotComputableStats,
  StatsInput,
  StatsResult,
  StatsRun,
  StatsTask,
} from './contracts.js';

function run(code: string): StatsRun {
  const scored = { P: 'passed', F: 'failed', U: 'ungradable', X: 'error' } as const;
  if (code === 'E') {
    return {
      passed: false,
      keyStatus: null,
      executionError: 'timeout',
      durationS: 300,
      tokens: 20_000,
      costUsd: 0.02,
    };
  }
  const keyStatus = scored[code as keyof typeof scored];
  if (!keyStatus) throw new Error(`unknown cell ${code}`);
  return {
    passed: keyStatus === 'passed',
    keyStatus,
    executionError: null,
    durationS: 40,
    tokens: 12_000,
    costUsd: 0.01,
  };
}

const task = (taskKey: string, baseline: string, candidate: string): StatsTask => ({
  taskKey,
  baseline: baseline.split('').map(run),
  candidate: candidate.split('').map(run),
});

/** Tasks as [baseline cells, candidate cells]; repetitions from the longest row. */
export function input(rows: [string, string][], patch: Partial<StatsInput> = {}): StatsInput {
  const tasks = rows.map(([b, c], i) => task(`task_${i + 1}`, b, c));
  const runs = tasks.flatMap((t) => [...t.baseline, ...t.candidate]);
  return {
    tasks,
    repetitions: Math.max(...rows.flatMap(([b, c]) => [b.length, c.length])),
    provisional: false,
    labels: { baseline: 'baseline', candidate: 'with-skill' },
    progress: {
      scored: runs.filter((r) => r.keyStatus !== null).length,
      total: runs.length,
    },
    ...patch,
  };
}

const options = { seed: seedFromExperimentId('exp_cases') };
export const stats = (i: StatsInput): StatsResult => computeComparisonStats(i, options);

export function computed(result: StatsResult): ComputedStats {
  if (!result.computable) throw new Error(`not computable: ${result.reason}`);
  return result;
}
export function refused(result: StatsResult): NotComputableStats {
  if (result.computable) throw new Error('computable');
  return result;
}
