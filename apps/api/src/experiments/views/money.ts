/**
 * Spend, and the estimate of what the rest will cost (plan 7.2 and 7.3, E12). Every
 * cost is the attempt's tokens times the experiment's frozen price table,
 * computed once when the attempt finished (attempts.cost_usd).
 *
 * The tokens priced are Hermes's result, or what egress metered when there
 * was no result (execution/pricing.ts billableTokens), so an attempt stopped
 * at its deadline, killed or cancelled still has a cost.
 *
 * An attempt's cost is unknown, counted in `unpricedAttempts` and never
 * added as zero, when it has finished and either its configuration's model
 * has no price in that frozen table, or its trial ran (a container was
 * recorded) but no usage was measured: the worker died with it, or egress
 * lost its registration. An attempt that never reached a container spent
 * nothing, and one whose model calls egress counted at zero cost 0.
 */
import type {
  ExperimentEstimate,
  ExperimentSpend,
  ExperimentStatus,
  PriceTable,
} from '@hermes-evals/shared';
import { modelPrice } from '../../execution/pricing.js';
import type { ArmMoney, RunFacts } from './facts.js';
import { isLive, round6 } from './numbers.js';

/** Model by configuration version id, as the arms reference them. */
export type ModelsByVersion = ReadonlyMap<string, string>;

export const isPriced = (table: PriceTable, model: string | undefined): boolean =>
  model !== undefined && modelPrice(table, model) !== null;

/** Finished attempts whose cost is unknown: an unpriced model's, or a priced one's never measured. */
export function unpricedAttempts(
  table: PriceTable,
  models: ModelsByVersion,
  arms: readonly ArmMoney[],
): number {
  return arms.reduce(
    (n, arm) =>
      n +
      (isPriced(table, models.get(arm.configurationVersionId))
        ? arm.unmeasuredAttempts
        : arm.finishedAttempts),
    0,
  );
}

/** Priced spend over the given arms. */
export const spentUsd = (arms: readonly ArmMoney[]): number =>
  round6(arms.reduce((sum, arm) => sum + arm.costUsd, 0));

/**
 * The cost of one or more arms as the list and the aggregates show it: the
 * priced spend, or null when nothing is priced and something is unknown (a
 * model with no price has an unknown cost even before its first attempt,
 * and so does an attempt whose usage was never measured).
 */
export function knownCost(
  table: PriceTable,
  models: ModelsByVersion,
  versionIds: readonly string[],
  arms: readonly ArmMoney[],
): number | null {
  const mine = arms.filter((a) => versionIds.includes(a.configurationVersionId));
  if (mine.some((a) => a.pricedAttempts > 0)) return spentUsd(mine);
  const unknown =
    versionIds.some((id) => !isPriced(table, models.get(id))) ||
    mine.some((a) => a.unmeasuredAttempts > 0);
  return unknown ? null : 0;
}

export interface SpendInput {
  status: ExperimentStatus;
  ceilingUsd: number | null;
  priceTable: PriceTable;
  /** What the New experiment form showed at launch, when the launch stored it. */
  estimate: ExperimentEstimate | null;
  models: ModelsByVersion;
  arms: readonly ArmMoney[];
  runs: readonly RunFacts[];
}

/**
 * Cost of one more run of a configuration: the mean of its priced attempts
 * so far, else the launch estimate's mean per run. Null when its model is
 * unpriced or there is no basis.
 */
function perRunCost(input: SpendInput, versionId: string): number | null {
  if (!isPriced(input.priceTable, input.models.get(versionId))) return null;
  const arm = input.arms.find((a) => a.configurationVersionId === versionId);
  if (arm && arm.pricedAttempts > 0) return arm.costUsd / arm.pricedAttempts;
  const e = input.estimate;
  if (e && e.cost_usd !== null && e.runs > 0) return e.cost_usd / e.runs;
  return null;
}

/**
 * The cost of the runs that still need a worker (queued or running; a
 * running attempt has not recorded its cost yet). Null once the experiment
 * has finished, or when one of those runs' configurations has no basis.
 */
export function remainingCostUsd(input: SpendInput): number | null {
  if (!isLive(input.status)) return null;
  const waiting = new Map<string, number>();
  for (const run of input.runs) {
    if (run.status !== 'queued' && run.status !== 'running') continue;
    waiting.set(run.configurationVersionId, (waiting.get(run.configurationVersionId) ?? 0) + 1);
  }
  let total = 0;
  for (const [versionId, n] of waiting) {
    const each = perRunCost(input, versionId);
    if (each === null) return null;
    total += n * each;
  }
  return round6(total);
}

export function spendView(input: SpendInput): ExperimentSpend {
  const spent = spentUsd(input.arms);
  const remaining = remainingCostUsd(input);
  return {
    spentUsd: spent,
    ceilingUsd: input.ceilingUsd,
    projectedTotalUsd: remaining === null ? null : round6(spent + remaining),
    remainingEstimateUsd: remaining,
    unpricedAttempts: unpricedAttempts(input.priceTable, input.models, input.arms),
  };
}
