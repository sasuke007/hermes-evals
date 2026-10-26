/**
 * How the configuration pages write their values (ConfigList, ConfigForm, ConfigDetail
 * boards): lists of names, hash tags, model prices, and the pass rate and verdict of a
 * configuration in each experiment that used it. Pure functions, shared by the list, the form
 * and the detail. Counts, sizes and hashes come from lib/format.ts.
 */
import type { NotComputableReason, SkillLoadingMode } from '@hermes-evals/shared';
import type {
  ConfigurationUsage,
  McpServerRef,
  ModelOption,
  SkillRef,
} from '@/api/types/configurations';
import { formatRate, formatSigned, plural } from '@/lib/format';

/**
 * Experiment names in a sentence. Names carry commas ("Skill vs no skill, invoices-v1"), so
 * three or more are separated by semicolons: "A; B; and C" (ConfigForm's version banner).
 */
export function joinSeries(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join('; ')}; and ${items[items.length - 1]}`;
}

/**
 * The configuration list's name filter (Phase 5 #18): every word of the query appears in the
 * name, ignoring case, so "skill mcp" finds "with-skill-and-mcp". An empty query keeps all.
 */
export function matchesName(name: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = name.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/**
 * The toolsets a run gets on top of the stored ones (Phase 6 #1, Phase 6b #12; the worker's
 * plannedToolsets): `memory` when memory is on, since the memory tool is the only way to save
 * to it, and `skills` when skills load on demand, since its tools are how the agent finds
 * them. Each only when the stored list lacks it; the configuration hash is unchanged.
 */
export function launchToolsets(v: {
  toolsets: readonly string[];
  memoryEnabled: boolean;
  skillLoading: SkillLoadingMode;
}): ('memory' | 'skills')[] {
  const added: ('memory' | 'skills')[] = [];
  if (v.memoryEnabled && !v.toolsets.includes('memory')) added.push('memory');
  if (v.skillLoading === 'on_demand' && !v.toolsets.includes('skills')) added.push('skills');
  return added;
}

/**
 * "+ memory and skills at launch: memory is on and skills load on demand", or without the
 * reason ("+ memory at launch") where the Memory and Skill loading rows stand beside it (the
 * diff table); null when nothing is added.
 */
export function launchToolsetsNote(
  added: readonly ('memory' | 'skills')[],
  options: { why?: boolean } = {},
): string | null {
  if (added.length === 0) return null;
  const what = `+ ${added.join(' and ')} at launch`;
  if (options.why === false) return what;
  const why = added.map((t) => (t === 'memory' ? 'memory is on' : 'skills load on demand'));
  return `${what}: ${why.join(' and ')}`;
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

/**
 * Why there is no interval, as the Used in table's caption says it: "No interval (1 rep)",
 * "No interval (2 tasks)", the Experiment list's words (Phase 5 question 1).
 */
export function noIntervalText(reason: NotComputableReason | null, taskCount: number): string {
  switch (reason) {
    case 'single_repetition':
      return 'No interval (1 rep)';
    case 'too_few_tasks':
      return `No interval (${plural(taskCount, 'task')})`;
    case 'nothing_scored':
      return 'No interval (nothing scored)';
    case 'not_enough_runs':
      return 'No interval (too few runs)';
    default:
      return 'No interval';
  }
}

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
  /**
   * "vs baseline 0.633", "Δ +0.056", "Provisional · Δ +0.071", "No interval (1 rep)"; null
   * shows the en dash.
   */
  caption: string | null;
}

/** The parts that are there, in one caption: "Δ +0.217 · vs baseline 0.633". */
const caption = (...parts: (string | null)[]): string | null =>
  parts.filter((p): p is string => p !== null).join(' · ') || null;

/**
 * The Verdict column: the candidate's verdict against the baseline, none for the baseline.
 * The candidate's Δ follows whenever there is one (Phase 5 question 1): the verdict entry's
 * once completed (ConfigDetail's "inconclusive Δ +0.056"), the provisional one while running.
 */
export function usageVerdict(u: ConfigurationUsage): UsageVerdict {
  const delta = u.delta === null ? null : `Δ ${formatSigned(u.delta)}`;
  switch (u.verdict) {
    case null:
      return { chip: null, caption: null };
    case 'provisional':
      return { chip: null, caption: caption('Provisional', delta) };
    case 'not_computable':
      return { chip: null, caption: caption(noIntervalText(u.verdictReason, u.taskCount), delta) };
    default:
      return {
        chip: u.verdict,
        caption: caption(
          delta,
          u.baselinePassRate === null ? null : `vs baseline ${formatRate(u.baselinePassRate, 3)}`,
        ),
      };
  }
}
