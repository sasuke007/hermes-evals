/**
 * The design's experiments in a database, for the comparison and verdict
 * tests: the web fixtures (apps/web/src/fixtures) hold one run matrix per
 * experiment, and every view the web draws derives from it. This seeds one
 * of them into Postgres the way the worker would leave it: the suite's
 * tasks with the fixture's verification keys, one configuration version
 * per configuration name, the experiment under the fixture's own id (so the
 * bootstrap's seed is the design's), and every run with its attempt and,
 * when scored, its published evaluation with a score for every key (the
 * primary one with the fixture's tooltip comment).
 *
 * The fixtures are another package's TypeScript modules, loaded with a
 * dynamic import of a computed file URL as statistics/design-data
 * .support-spec.ts loads them; the interfaces below declare the part read.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  ComparisonQuery,
  ExecutionErrorCategory,
  ExperimentStatus,
  RunStatus,
  ScorerType,
  ScoreStatus,
  SelfCheck,
} from '@hermes-evals/shared';
import {
  configurations,
  configurationVersions,
  experiments,
  runs,
  suites,
  suiteSources,
  tasks,
  workers,
} from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { PRICE_TABLE, PRICED_MODEL, REVISION } from '../views/seed.support-spec.js';
import { playRun } from './design-runs.support-spec.js';

/** The part of a web RunSeed the seeding reads. */
export interface DesignRun {
  taskKey: string;
  config: string;
  repetition: number;
  status: RunStatus;
  /** Attempts the run took; the earlier ones ended as its category's execution errors. */
  attempts: number;
  category: ExecutionErrorCategory | null;
  durationS: number | null;
  tokens: { input: number; output: number; total: number } | null;
  costUsd: number | null;
}

/** The part of a web ExperimentSeed the seeding reads. */
export interface DesignSeed {
  key: string;
  id: string;
  name: string;
  status: ExperimentStatus;
  baseline: string;
  candidates: string[];
  repetitions: number;
  stats: Partial<Record<string, { delta: number; lo: number; hi: number }>>;
}

interface DesignVerification {
  key: string;
  type: ScorerType;
  primary?: boolean;
  params: Record<string, unknown>;
}

interface KeyResult {
  key: string;
  type: ScorerType;
  primary: boolean;
  status: ScoreStatus;
  score: number | null;
}

interface ExperimentsModule {
  experimentSeeds(active: (name: string) => boolean): DesignSeed[];
  runsOf(seed: DesignSeed): DesignRun[];
  keyResults(seed: DesignSeed, run: DesignRun): KeyResult[];
}
interface SuitesModule {
  TASK_KEYS: string[];
  taskVerification(key: string): DesignVerification[];
}
interface ComparisonModule {
  comparisonFixture(seed: DesignSeed, query?: ComparisonQuery): unknown;
  runComment(run: DesignRun): string | null;
}

const FIXTURES = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../web/src/fixtures',
);

async function load<T>(file: string): Promise<T> {
  const module: unknown = await import(pathToFileURL(resolve(FIXTURES, file)).href);
  return module as T;
}

const sha = (content: string): string => createHash('sha256').update(content).digest('hex');

const SELF_CHECK: SelfCheck = {
  status: 'passed',
  ran_at: '2026-10-23T09:00:00.000Z',
  duration_ms: 12,
  results: [],
};

/** The design's fixtures, loaded once per test file. */
export class Design {
  private constructor(
    private readonly experiments: ExperimentsModule,
    private readonly suites: SuitesModule,
    private readonly comparison: ComparisonModule,
  ) {}

  static async load(): Promise<Design> {
    const [experimentsModule, suitesModule, comparisonModule] = await Promise.all([
      load<ExperimentsModule>('experiments.ts'),
      load<SuitesModule>('suites.ts'),
      load<ComparisonModule>('comparison.ts'),
    ]);
    return new Design(experimentsModule, suitesModule, comparisonModule);
  }

  get taskKeys(): string[] {
    return this.suites.TASK_KEYS;
  }

  /** One experiment by its fixture key (`skillVsNoSkill`, `mcpSmoke`, …) in a scenario. */
  seed(key: string, scenario: string | null = null): DesignSeed {
    const found = this.experiments
      .experimentSeeds((name) => name === scenario)
      .find((s) => s.key === key);
    if (!found) throw new Error(`no fixture experiment ${key}`);
    return found;
  }

  runs(seed: DesignSeed): DesignRun[] {
    return this.experiments.runsOf(seed);
  }

  /** The web's comparison of one candidate, by configuration name (unparsed). */
  comparisonView(seed: DesignSeed, query: ComparisonQuery): unknown {
    return this.comparison.comparisonFixture(seed, query);
  }

  /** Writes the experiment into `db`: still `running`, whatever the fixture says; reconcile completes it. */
  async insert(db: AppDb, seed: DesignSeed): Promise<DesignWorld> {
    const [suite] = await db
      .insert(suites)
      .values({
        sourcePath: `design-${seed.key}`,
        versionNumber: 1,
        name: `design-${seed.key}`,
        versionLabel: '1',
        contentHash: sha(`suite ${seed.key}`),
        checkHash: sha(`checks ${seed.key}`),
        taskCount: this.taskKeys.length,
        validCount: this.taskKeys.length,
      })
      .returning({ id: suites.id });
    await db.insert(suiteSources).values({
      path: `design-${seed.key}`,
      name: `design-${seed.key}`,
      currentSuiteId: suite!.id,
      lastOutcome: 'created',
    });
    const taskIds = new Map<string, string>();
    for (const [position, key] of this.taskKeys.entries()) {
      const verification = this.suites.taskVerification(key).map((v) => ({
        key: v.key,
        type: v.type,
        primary: v.primary ?? false,
        params: v.params,
      }));
      const [task] = await db
        .insert(tasks)
        .values({
          suiteId: suite!.id,
          key,
          versionNumber: 1,
          introducedInSuiteId: suite!.id,
          position,
          summary: `Task ${key}`,
          prompt: `Solve ${key}.`,
          limits: { max_turns: 20, run_budget_seconds: 300, toolsets_needed: ['file'] },
          reference: 1,
          verification,
          taskYaml: `summary: Task ${key}\n`,
          selfCheck: SELF_CHECK,
          valid: true,
          contentHash: sha(`task ${seed.key} ${key}`),
        })
        .returning({ id: tasks.id });
      taskIds.set(key, task!.id);
    }
    const versionIds = new Map<string, string>();
    for (const name of [seed.baseline, ...seed.candidates]) {
      versionIds.set(
        name,
        await db.transaction(async (tx) => {
          const [configuration] = await tx
            .insert(configurations)
            .values({ name: `${name}-${seed.key.toLowerCase()}` })
            .returning({ id: configurations.id });
          const [version] = await tx
            .insert(configurationVersions)
            .values({
              configurationId: configuration!.id,
              version: 1,
              model: PRICED_MODEL,
              provider: 'nous',
              toolsets: ['file', 'terminal'],
              maxTurns: 20,
              timeBudgetS: 300,
              configHash: sha(`config ${seed.key} ${name}`),
              frozenAt: new Date(),
            })
            .returning({ id: configurationVersions.id });
          return version!.id;
        }),
      );
    }
    const [worker] = await db
      .insert(workers)
      .values({
        hostname: `worker-${seed.key}`,
        concurrency: 2,
        slots: 4,
        hermesVersion: '0.22.4',
        hermesRevision: REVISION,
      })
      .returning({ id: workers.id });
    const version = (name: string) => versionIds.get(name)!;
    await db.insert(experiments).values({
      id: seed.id,
      name: seed.name,
      suiteId: suite!.id,
      taskIds: this.taskKeys.map((k) => taskIds.get(k)!),
      baselineVersionId: version(seed.baseline),
      candidateVersionIds: seed.candidates.map(version),
      repetitions: seed.repetitions,
      concurrency: 2,
      spendCeilingUsd: 50,
      hermesVersion: '0.22.4',
      hermesRevision: REVISION,
      priceTable: PRICE_TABLE,
    });
    const runIds = new Map<string, string>();
    for (const run of this.runs(seed)) {
      const [row] = await db
        .insert(runs)
        .values({
          experimentId: seed.id,
          taskId: taskIds.get(run.taskKey)!,
          configurationVersionId: version(run.config),
          repetition: run.repetition,
        })
        .returning({ id: runs.id });
      runIds.set(runName(run.taskKey, run.config, run.repetition), row!.id);
      // The primary score carries the comment the web's tooltip shows; every
      // other key one of its own, so a cell that showed another key's would differ.
      const comment = this.comparison.runComment(run);
      const keys = this.experiments.keyResults(seed, run).map((k) => ({
        ...k,
        comment: (k.primary ? comment : null) ?? `${k.key} ${k.status}`,
      }));
      await playRun(db, run, row!.id, worker!.id, keys);
    }
    return {
      seed,
      experimentId: seed.id,
      versionIds,
      workerId: worker!.id,
      run: (task, config, repetition) => {
        const id = runIds.get(runName(task, config, repetition));
        if (!id) throw new Error(`no run ${runName(task, config, repetition)}`);
        return id;
      },
    };
  }
}

const runName = (task: string, config: string, repetition: number) =>
  `${task}|${config}|${repetition}`;

/** A design experiment as seeded. */
export interface DesignWorld {
  seed: DesignSeed;
  experimentId: string;
  /** Configuration version id by the fixture's configuration name. */
  versionIds: Map<string, string>;
  workerId: string;
  /** The run id of one cell. */
  run(task: string, config: string, repetition: number): string;
}
