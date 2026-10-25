/**
 * How the configuration pages write their values (ConfigList, ConfigForm, ConfigDetail
 * boards): lists of names, hash tags, model prices, and the pass rate and verdict of a
 * configuration in each experiment that used it. Pure functions, shared by the list, the form
 * and the detail. Counts, sizes and hashes come from lib/format.ts.
 */
import type { NotComputableReason } from '@hermes-evals/shared';
import type {
  ConfigurationUsage,
  McpServerRef,
  ModelOption,
  SkillRef,
} from '@/api/types/configurations';
import { formatRate } from '@/lib/format';

/**
 * Experiment names in a sentence. Names carry commas ("Skill vs no skill, invoices-v1"), so
 * three or more are separated by semicolons: "A; B; and C" (ConfigForm's version banner).
 */
export function joinSeries(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join('; ')}; and ${items[items.length - 1]}`;
}

/** A content hash as a tag: "sha256:9c41e07d". */
export function hashTag(hex: string): string {
  return `sha256:${hex.slice(0, 8)}`;
}

export const skillLabel = (s: Pick<SkillRef, 'name' | 'version'>): string =>
  `${s.name}@${s.version}`;
export const mcpDetail = (m: Pick<McpServerRef, 'version' | 'transport'>): string =>
  `v${m.version} · ${m.transport}`;

/** "$0.60 in / $2.40 out per 1M tokens". */
export function priceLine(price: NonNullable<ModelOption['price']>): string {
  return `$${price.inputPer1M.toFixed(2)} in / $${price.outputPer1M.toFixed(2)} out per 1M tokens`;
}

export interface ModelHelp {
  text: string;
  /** Amber: the model is not in the price table (saving stays allowed). */
  warning: boolean;
}

/** The help line under Model (ConfigForm board, `model` tweak). */
export function modelHelp(model: string, models: readonly ModelOption[]): ModelHelp {
  const id = model.trim();
  if (id === '') return { text: 'Pick a known model or type any model id.', warning: false };
  const price = models.find((m) => m.id === id)?.price;
  if (price) return { text: priceLine(price), warning: false };
  return { text: 'Not in the price table; cost estimates will be unavailable', warning: true };
}

/** Why there is no interval, as the Used in table's caption says it: "No interval (1 rep)". */
export const NO_INTERVAL_REASON: Record<NotComputableReason, string> = {
  single_repetition: '1 rep',
  too_few_tasks: 'fewer than 3 tasks',
  nothing_scored: 'nothing scored',
  not_enough_runs: 'too few runs',
};

export interface UsageRate {
  /** "0.85" while running, "0.850" once completed; null shows the en dash. */
  value: string | null;
  /** Completed: the figure is final, set in semibold. */
  final: boolean;
  /** "13 of 60 scored" while the experiment is not completed. */
  caption: string | null;
}

/**
 * The pass rate of this configuration in one experiment: three decimals once completed, two
 * with the scored count while it is still running, paused or failed (provisional figures).
 */
export function usageRate(u: ConfigurationUsage): UsageRate {
  // Nothing scored yet: there is no rate to show, whatever the API rounds it to.
  const rate = u.scored === 0 ? null : u.passRate;
  if (u.status === 'completed') {
    return { value: rate === null ? null : formatRate(rate, 3), final: true, caption: null };
  }
  const caption =
    u.status === 'failed' && rate === null ? null : `${u.scored} of ${u.total} scored`;
  return { value: rate === null ? null : formatRate(rate, 2), final: false, caption };
}

export interface UsageVerdict {
  /** A verdict chip (better, worse, inconclusive); null draws only the caption. */
  chip: 'better' | 'worse' | 'inconclusive' | null;
  /** "vs baseline 0.633", "Provisional", "No interval (1 rep)"; null shows the en dash. */
  caption: string | null;
}

/** The Verdict column: the candidate's verdict against the baseline; none for the baseline. */
export function usageVerdict(u: ConfigurationUsage): UsageVerdict {
  switch (u.verdict) {
    case null:
      return { chip: null, caption: null };
    case 'provisional':
      return { chip: null, caption: 'Provisional' };
    case 'not_computable':
      return {
        chip: null,
        caption: u.verdictReason
          ? `No interval (${NO_INTERVAL_REASON[u.verdictReason]})`
          : 'No interval',
      };
    default:
      return {
        chip: u.verdict,
        caption:
          u.baselinePassRate === null ? null : `vs baseline ${formatRate(u.baselinePassRate, 3)}`,
      };
  }
}
