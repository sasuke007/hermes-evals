/**
 * Money (plan 7.2, 7.3, E12). An experiment freezes a snapshot of the price
 * table when it launches (experiments.price_table), and every attempt's cost
 * is its tokens times that snapshot, so a later edit of config/prices.yaml
 * never changes a past experiment's spend. A model the snapshot does not
 * price has no cost: null, which the spend guard and the UI count as
 * unpriced, never as zero.
 *
 * The file format is the one the configuration form already reads
 * (configurations/prices.ts parsePriceFile): a map of model id to price,
 * optionally under `models:`.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PriceTableSchema, type PriceTable, type Tokens } from '@hermes-evals/shared';
import { parsePriceFile, type ModelPrice } from '../configurations/prices.js';
import type { EgressUsage } from '../sandbox/egress-client.js';

/** The price file exists but cannot be read or is not a price table. */
export class PriceTableError extends Error {
  override readonly name = 'PriceTableError';
}

/**
 * Snapshots the price file for a launch: its sha256 (of the bytes as read),
 * the time it was read, and its models. A missing file is a table with no
 * models (and the hash of empty content), so every cost is null. A file that
 * exists but cannot be read or parsed throws PriceTableError with a readable
 * message: freezing an empty table because of a typo would leave the whole
 * experiment unpriced for good.
 */
export async function loadPriceTable(path: string, now: Date = new Date()): Promise<PriceTable> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new PriceTableError(`cannot read the price table ${path}: ${(err as Error).message}`);
    }
    bytes = Buffer.alloc(0);
  }
  let models: Map<string, ModelPrice>;
  try {
    models = parsePriceFile(bytes.toString('utf8'));
  } catch (err) {
    throw new PriceTableError(`${path}: ${(err as Error).message}`);
  }
  return PriceTableSchema.parse({
    sha256: createHash('sha256').update(bytes).digest('hex'),
    loaded_at: now.toISOString(),
    models: Object.fromEntries(models),
  });
}

/** The table's price for `model`, or null. Own keys only, so `constructor` is never a model. */
export function modelPrice(table: PriceTable, model: string): ModelPrice | null {
  return Object.hasOwn(table.models, model) ? (table.models[model] ?? null) : null;
}

const PER_MILLION = 1_000_000;
/** attempts.cost_usd is numeric(12,6): round the same way so the stored value equals this one. */
const round6 = (usd: number): number => Math.round(usd * PER_MILLION) / PER_MILLION;

/**
 * What an attempt's tokens cost under the frozen table, in USD, or null when
 * the model has no price or the tokens are unknown.
 *
 * Hermes's `input` includes the cached prompt tokens (resultTokens in
 * stream-json.ts), so the uncached part is input − cache_read − cache_write,
 * priced at input_per_1m. Cache reads and writes are priced at their own rate
 * when the table has one, else at the input rate: an upper bound rather than
 * a guess.
 */
/** The tokens an attempt is billed for, and whose count they are. */
export interface BilledTokens {
  tokens: Tokens | null;
  /** `result`: Hermes's own counts; `egress`: what the model gateway metered; null: neither. */
  source: 'result' | 'egress' | null;
}

/**
 * Egress's count as Tokens. Egress cannot tell cached prompt tokens apart,
 * so every prompt token is priced at the input rate: an upper bound.
 */
export const meteredTokens = (usage: EgressUsage): Tokens => ({
  input: usage.promptTokens,
  output: usage.completionTokens,
  total: usage.promptTokens + usage.completionTokens,
  cache_read: 0,
  cache_write: 0,
});

/**
 * What an attempt's spend is computed from (E12: unknown is never zero).
 * Hermes's `result` tokens are the record when they cover what egress
 * metered: they split out cache reads, and on the gateway path they equal
 * egress's counts (spike I4). Egress's own count, which nothing in the trial
 * can change, is used instead when there is no result (a deadline, an OOM or
 * output kill, a cancel, an engine failure) or when the result claims fewer
 * input or output tokens than egress saw: the `result` line comes from the
 * container's stdout, which the agent can write to as well. A plain max of
 * the two costs is not taken: honest cache-discounted result pricing would
 * always lose to egress's full-rate figure. Egress having counted no model
 * call is a measured zero.
 */
export function billableTokens(result: Tokens | null, usage: EgressUsage | null): BilledTokens {
  if (usage === null) return { tokens: result, source: result === null ? null : 'result' };
  const metered = meteredTokens(usage);
  if (result === null) return { tokens: metered, source: 'egress' };
  const short = result.input < metered.input || result.output < metered.output;
  return short ? { tokens: metered, source: 'egress' } : { tokens: result, source: 'result' };
}

export function attemptCost(
  table: PriceTable,
  model: string,
  tokens: Tokens | null,
): number | null {
  const price = modelPrice(table, model);
  if (price === null || tokens === null) return null;
  const uncached = Math.max(0, tokens.input - tokens.cache_read - tokens.cache_write);
  const cacheRead = price.cache_read_per_1m ?? price.input_per_1m;
  const cacheWrite = price.cache_write_per_1m ?? price.input_per_1m;
  const usd =
    (uncached * price.input_per_1m +
      tokens.cache_read * cacheRead +
      tokens.cache_write * cacheWrite +
      tokens.output * price.output_per_1m) /
    PER_MILLION;
  return round6(usd);
}
