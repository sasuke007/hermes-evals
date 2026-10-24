/**
 * The model price table, config/prices.yaml (PRICES_FILE), as the
 * configuration form reads it: which models have a known price. The file is
 * optional; without it no model has a price and costs show as "—".
 *
 * Shape: a YAML map of model id to price, the `models` of PriceTable in
 * @hermes-evals/shared, optionally under a top-level `models:` key:
 *
 *   openai/gpt-6.1-sol:
 *     input_per_1m: 0.6
 *     output_per_1m: 2.4
 *     checked_at: '2026-10-20'
 */
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { ModelPriceSchema } from '@hermes-evals/shared';

export type ModelPrice = z.infer<typeof ModelPriceSchema>;

const PriceModelsSchema = z.record(z.string().min(1), ModelPriceSchema);
const WrappedPriceModelsSchema = z.strictObject({ models: PriceModelsSchema });

/** What reading the price file found. `problem` explains a file that exists but cannot be used. */
export interface PriceModels {
  /** Model id to price, in file order. */
  models: Map<string, ModelPrice>;
  problem: string | null;
}

/** Parses the text of a price file. Throws with a readable message when it is not one. */
export function parsePriceFile(text: string): Map<string, ModelPrice> {
  const doc: unknown = parse(text) ?? {};
  // A bare map whose one model is literally called `models` fails this, because
  // its value is a price, not a map of prices; it then parses as a bare map.
  const wrapped = WrappedPriceModelsSchema.safeParse(doc);
  if (wrapped.success) return new Map(Object.entries(wrapped.data.models));
  const bare = PriceModelsSchema.safeParse(doc);
  if (bare.success) return new Map(Object.entries(bare.data));
  const first = bare.error.issues[0];
  const where = first && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
  throw new Error(`not a price table${where}: ${first?.message ?? 'invalid'}`);
}

/**
 * Reads the price file. A missing file is normal (no prices); a file that
 * cannot be read or parsed is reported in `problem` so the caller can log
 * it, and also yields no prices rather than failing the form.
 */
export async function readPriceModels(path: string): Promise<PriceModels> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { models: new Map(), problem: null };
    return { models: new Map(), problem: `cannot read ${path}: ${(err as Error).message}` };
  }
  try {
    return { models: parsePriceFile(text), problem: null };
  } catch (err) {
    return { models: new Map(), problem: `${path}: ${(err as Error).message}` };
  }
}
