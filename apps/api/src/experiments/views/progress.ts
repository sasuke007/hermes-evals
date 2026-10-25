/**
 * Run figures of the Overview (UI_FLOWS 14.2): counts, per-configuration
 * progress, the completed aggregates and the "Latest completions" feed.
 *
 * Counting rules, the same as the comparison's (plan 10.1): a run counts
 * toward a pass rate once it is scored or ended in execution_error (which
 * counts as not passed); cancelled runs never count. A run passes when its
 * current evaluation's primary score passed. While running, the provisional
 * rate is passed of scored so far.
 */
import {
  EXECUTION_ERROR_CATEGORIES,
  type ConfigAggregate,
  type ConfigProgress,
  type FeedEntry,
  type PriceTable,
  type RunCounts,
} from '@hermes-evals/shared';
import type { ArmMoney, ConfigFacts, RunFacts } from './facts.js';
import { knownCost, type ModelsByVersion } from './money.js';
import { attemptSeconds, emptyCounts, mean, median, round3 } from './numbers.js';

/** At most this many entries in "Latest completions". */
export const FEED_SIZE = 10;

export function countRuns(runs: readonly RunFacts[]): RunCounts {
  const counts = emptyCounts();
  for (const run of runs) counts[run.status] += 1;
  return counts;
}

const passed = (run: RunFacts): boolean => run.primary?.status === 'passed';

/** Scored runs and execution errors: the runs a pass rate counts. */
const counted = (run: RunFacts): boolean =>
  run.status === 'scored' || run.status === 'execution_error';

/**
 * A run's primary score as a number: the score when the scorer gave one,
 * else 1 for passed and 0 for anything else (an execution error, an error
 * or ungradable key score nothing).
 */
const scoreOf = (run: RunFacts): number =>
  run.primary?.score ?? (run.primary?.status === 'passed' ? 1 : 0);

export function progressOf(config: ConfigFacts, runs: readonly RunFacts[]): ConfigProgress {
  const mine = runs.filter((r) => r.configurationVersionId === config.ref.versionId);
  const counts = countRuns(mine);
  const pass = mine.filter(passed).length;
  return {
    configuration: config.ref,
    total: mine.length,
    counts,
    passed: pass,
    provisionalPassRate: counts.scored === 0 ? null : round3(pass / counts.scored),
  };
}

export interface AggregateInput {
  priceTable: PriceTable;
  models: ModelsByVersion;
  arms: readonly ArmMoney[];
}

export function aggregateOf(
  config: ConfigFacts,
  runs: readonly RunFacts[],
  money: AggregateInput,
): ConfigAggregate {
  const versionId = config.ref.versionId;
  const mine = runs.filter((r) => r.configurationVersionId === versionId);
  const countedRuns = mine.filter(counted);
  // Runs whose current attempt has ended, cancelled ones aside: what duration and tokens describe.
  const ran = mine.filter((r) => r.status !== 'cancelled' && attemptSeconds(r.attempt) !== null);
  const tokens = ran.flatMap((r) => (r.attempt?.tokens ? [r.attempt.tokens.total] : []));
  const errors = mine.filter((r) => r.status === 'execution_error');
  const categories = new Set(errors.map((r) => r.attempt?.errorCategory));
  const meanTokens = mean(tokens);
  return {
    configuration: config.ref,
    runs: mine.length,
    passRate:
      countedRuns.length === 0
        ? null
        : round3(countedRuns.filter(passed).length / countedRuns.length),
    meanScore:
      countedRuns.length === 0
        ? null
        : round3(countedRuns.reduce((sum, r) => sum + scoreOf(r), 0) / countedRuns.length),
    medianDurationS: median(ran.map((r) => attemptSeconds(r.attempt) ?? 0)),
    meanTokens: meanTokens === null ? null : Math.round(meanTokens),
    costUsd: knownCost(money.priceTable, money.models, [versionId], money.arms),
    executionErrors: errors.length,
    executionErrorCategories: EXECUTION_ERROR_CATEGORIES.filter((c) => categories.has(c)),
    ungradable: mine.filter((r) => r.primary?.status === 'ungradable').length,
  };
}

/** The feed entry of a finished run (scored or execution_error), or null for any other run. */
export function feedEntryOf(run: RunFacts, configurationName: string): FeedEntry | null {
  if ((run.status !== 'scored' && run.status !== 'execution_error') || run.finishedAt === null) {
    return null;
  }
  return {
    runId: run.id,
    finishedAt: run.finishedAt.toISOString(),
    taskKey: run.taskKey,
    configuration: configurationName,
    repetition: run.repetition,
    // A scored run always has its primary key (the publish guard requires every key).
    result: run.status === 'execution_error' ? 'execution_error' : (run.primary?.status ?? 'error'),
    durationS: attemptSeconds(run.attempt) ?? 0,
  };
}

/** The newest finished runs, newest first, at most FEED_SIZE. */
export function feedOf(runs: readonly RunFacts[], names: ReadonlyMap<string, string>): FeedEntry[] {
  return runs
    .filter((r) => r.finishedAt !== null)
    .sort(
      (a, b) =>
        b.finishedAt!.getTime() - a.finishedAt!.getTime() ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )
    .flatMap((r) => {
      const entry = feedEntryOf(r, names.get(r.configurationVersionId) ?? '');
      return entry ? [entry] : [];
    })
    .slice(0, FEED_SIZE);
}
