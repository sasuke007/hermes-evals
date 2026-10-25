/**
 * The design's datasets for the statistics tests (plan 10.4), read from the
 * web fixtures rather than copied: apps/web/src/fixtures derives every view
 * of an experiment from one run matrix per experiment, so `Skill vs no
 * skill` (12 tasks × 5 repetitions × 2 configurations), the Flow B smoke
 * test and every scenario variant reach these tests exactly as the web
 * draws them, and a change to the design's data reaches both.
 *
 * The fixtures are TypeScript modules of another package. They are loaded
 * with a dynamic import of a computed file URL, so this package's
 * typecheck does not follow them into the web's path aliases; the
 * interfaces below declare the part of them these tests read, and the
 * comparison fixture is parsed with the shared schema.
 */
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ComparisonViewSchema,
  ExperimentDetailSchema,
  type ComparisonQuery,
  type ComparisonView,
  type ExecutionErrorCategory,
  type ExperimentStatus,
  type RunStatus,
  type ScoreStatus,
  type VerdictSummary,
} from '@hermes-evals/shared';
import type { StatsInput, StatsRun, StatsTask } from './contracts.js';

/** The part of a web RunSeed the tests read. */
export interface DesignRun {
  taskKey: string;
  config: string;
  repetition: number;
  status: RunStatus;
  category: ExecutionErrorCategory | null;
  durationS: number | null;
  tokens: { total: number } | null;
  costUsd: number | null;
}

/** The part of a web ExperimentSeed the tests read. */
export interface DesignSeed {
  key: string;
  id: string;
  status: ExperimentStatus;
  baseline: string;
  candidates: string[];
  repetitions: number;
}

interface ExperimentsModule {
  EXPERIMENT_IDS: Record<string, string>;
  experimentSeeds(active: (name: string) => boolean): DesignSeed[];
  runsOf(seed: DesignSeed): DesignRun[];
  selectedKeyStatus(seed: DesignSeed, run: DesignRun, key: string): ScoreStatus | null;
  experimentDetailFixture(seed: DesignSeed, suiteState: unknown): unknown;
}

interface ComparisonModule {
  comparisonFixture(seed: DesignSeed, query?: ComparisonQuery): unknown;
}

interface ScenariosModule {
  SCENARIOS: { name: string; domain: string }[];
}

interface SuitesModule {
  TASK_KEYS: string[];
  suiteStateFrom(active: (name: string) => boolean): unknown;
}

/** The web's table of the module's intervals (apps/web/src/fixtures/statistics.ts). */
interface StatisticsModule {
  intervalKey(experimentId: string, deltas: readonly number[]): string;
}

const FIXTURES = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../web/src/fixtures');

async function load<T>(file: string): Promise<T> {
  const module: unknown = await import(pathToFileURL(resolve(FIXTURES, file)).href);
  return module as T;
}

export class DesignData {
  private constructor(
    private readonly experiments: ExperimentsModule,
    private readonly comparison: ComparisonModule,
    private readonly suites: SuitesModule,
    private readonly statistics: StatisticsModule,
    /** The names of the scenarios that change experiments. */
    readonly scenarios: string[],
    readonly taskKeys: string[],
  ) {}

  static async load(): Promise<DesignData> {
    const [experiments, comparison, scenarios, suites, statistics] = await Promise.all([
      load<ExperimentsModule>('experiments.ts'),
      load<ComparisonModule>('comparison.ts'),
      load<ScenariosModule>('scenarios.ts'),
      load<SuitesModule>('suites.ts'),
      load<StatisticsModule>('statistics.ts'),
    ]);
    const names = scenarios.SCENARIOS.map((s) => s.name);
    return new DesignData(experiments, comparison, suites, statistics, names, suites.TASK_KEYS);
  }

  /** How the web's interval table names the interval of these per-task differences. */
  intervalKey(experimentId: string, deltas: readonly number[]): string {
    return this.statistics.intervalKey(experimentId, deltas);
  }

  /** The Overview's VerdictCards of an experiment as a scenario shows it, parsed with the shared schema. */
  verdicts(seed: DesignSeed, scenario: string | null = null): VerdictSummary[] {
    const state = this.suites.suiteStateFrom((name) => name === scenario);
    return ExperimentDetailSchema.parse(this.experiments.experimentDetailFixture(seed, state))
      .verdicts;
  }

  /** Every experiment seed as a scenario (null: the default fixtures) shows it. */
  seeds(scenario: string | null = null): DesignSeed[] {
    return this.experiments.experimentSeeds((name) => name === scenario);
  }

  /** One experiment by its fixture key (`skillVsNoSkill`, `mcpSmoke`, …). */
  seed(key: string, scenario: string | null = null): DesignSeed {
    const seed = this.seeds(scenario).find((s) => s.key === key);
    if (!seed) throw new Error(`no fixture experiment ${key} in scenario ${scenario ?? 'default'}`);
    return seed;
  }

  runs(seed: DesignSeed): DesignRun[] {
    return this.experiments.runsOf(seed);
  }

  keyStatus(seed: DesignSeed, run: DesignRun, key: string): ScoreStatus | null {
    return this.experiments.selectedKeyStatus(seed, run, key);
  }

  /** The web's comparison of one candidate (by configuration name), parsed with the shared schema. */
  comparisonView(seed: DesignSeed, candidate: string, key = 'primary'): ComparisonView {
    return ComparisonViewSchema.parse(this.comparison.comparisonFixture(seed, { candidate, key }));
  }

  /**
   * The StatsInput the comparison would build for `candidate` under `key`,
   * by the counting rules of plan 10.1: scored and execution_error runs
   * count, everything else (cancelled included) is left out.
   */
  statsInput(seed: DesignSeed, candidate = seed.candidates[0]!, key = 'primary'): StatsInput {
    const runs = this.runs(seed);
    const counted = (task: string, config: string): StatsRun[] =>
      runs
        .filter((r) => r.taskKey === task && r.config === config)
        .filter((r) => r.status === 'scored' || r.status === 'execution_error')
        .map((r) => {
          const keyStatus = r.status === 'scored' ? this.keyStatus(seed, r, key) : null;
          return {
            passed: keyStatus === 'passed',
            keyStatus,
            executionError: r.status === 'execution_error' ? (r.category ?? 'other') : null,
            durationS: r.durationS,
            tokens: r.tokens?.total ?? null,
          };
        });
    // The two configurations' runs only, as the comparison counts them.
    const pair = runs.filter((r) => r.config === seed.baseline || r.config === candidate);
    const tasks: StatsTask[] = this.taskKeys.map((taskKey) => ({
      taskKey,
      baseline: counted(taskKey, seed.baseline),
      candidate: counted(taskKey, candidate),
    }));
    // Every run of the arm that has a cost, cancelled ones included, as the Overview prices it.
    const spent = (config: string): number | null => {
      const costs = runs.flatMap((r) =>
        r.config === config && r.costUsd !== null ? [r.costUsd] : [],
      );
      return costs.length === 0 ? null : costs.reduce((sum, c) => sum + c, 0);
    };
    return {
      tasks,
      repetitions: seed.repetitions,
      provisional:
        seed.status === 'running' || seed.status === 'paused' || seed.status === 'failed',
      labels: { baseline: seed.baseline, candidate },
      progress: {
        scored: pair.filter((r) => r.status === 'scored').length,
        total: pair.length,
      },
      costUsd: { baseline: spent(seed.baseline), candidate: spent(candidate) },
    };
  }
}
