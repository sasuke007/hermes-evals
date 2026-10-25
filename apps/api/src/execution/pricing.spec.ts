import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PriceTableSchema, type PriceTable, type Tokens } from '@hermes-evals/shared';
import { attemptCost, loadPriceTable, modelPrice, PriceTableError } from './pricing.js';

const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const NOW = new Date('2026-10-24T12:00:00.000Z');

describe('loadPriceTable', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hermes-evals-price-table-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('snapshots the file: its hash, when it was read, and its models', async () => {
    const path = join(dir, 'prices.yaml');
    const text = `models:\n  m/one:\n    input_per_1m: 1.25\n    output_per_1m: 10\n    cache_read_per_1m: 0.125\n    checked_at: '2026-10-20'\n`;
    await writeFile(path, text);
    const table = await loadPriceTable(path, NOW);
    expect(PriceTableSchema.parse(table)).toEqual({
      sha256: sha(text),
      loaded_at: '2026-10-24T12:00:00.000Z',
      models: {
        'm/one': {
          input_per_1m: 1.25,
          output_per_1m: 10,
          cache_read_per_1m: 0.125,
          checked_at: '2026-10-20',
        },
      },
    });
  });

  it('treats a missing file as a table with no models', async () => {
    const table = await loadPriceTable(join(dir, 'absent.yaml'), NOW);
    expect(table).toEqual({ sha256: sha(''), loaded_at: NOW.toISOString(), models: {} });
  });

  it('refuses a file that is not a price table, rather than freezing no prices', async () => {
    const path = join(dir, 'prices.yaml');
    await writeFile(path, 'm/one:\n  input_per_1m: -1\n');
    await expect(loadPriceTable(path, NOW)).rejects.toBeInstanceOf(PriceTableError);
    await expect(loadPriceTable(dir, NOW)).rejects.toThrow(/cannot read the price table/);
  });

  it('reads the shipped config/prices.yaml, which prices the mock model at zero', async () => {
    const path = join(import.meta.dirname, '../../../../config/prices.yaml');
    const table = await loadPriceTable(path, NOW);
    expect(table.sha256).toBe(sha(await readFile(path)));
    expect(table.models['mock/scripted']).toMatchObject({ input_per_1m: 0, output_per_1m: 0 });
    for (const price of Object.values(table.models)) {
      expect(price.checked_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

const TABLE: PriceTable = {
  sha256: sha('table'),
  loaded_at: NOW.toISOString(),
  models: {
    'm/plain': { input_per_1m: 2, output_per_1m: 8, checked_at: '2026-10-20' },
    'm/cached': {
      input_per_1m: 2,
      output_per_1m: 8,
      cache_read_per_1m: 0.5,
      cache_write_per_1m: 2.5,
      checked_at: '2026-10-20',
    },
    'm/cheap': { input_per_1m: 0.3, output_per_1m: 0.3, checked_at: '2026-10-20' },
    'mock/scripted': { input_per_1m: 0, output_per_1m: 0, checked_at: '2026-10-24' },
  },
};

const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0): Tokens => ({
  input,
  output,
  total: input + output,
  cache_read: cacheRead,
  cache_write: cacheWrite,
});

describe('attemptCost', () => {
  it('prices input and output per million tokens', () => {
    // 1,000,000 in at $2 + 250,000 out at $8 = $4
    expect(attemptCost(TABLE, 'm/plain', tokens(1_000_000, 250_000))).toBe(4);
    expect(attemptCost(TABLE, 'mock/scripted', tokens(3300, 63))).toBe(0);
  });

  it('prices cached tokens, which Hermes counts inside input, at their own rate', () => {
    // The recorded run: 3,300 prompt tokens of which 1,200 were cache reads.
    // 2,100 × 2 + 1,200 × 0.5 + 63 × 8 = 4,200 + 600 + 504 = 5,304 per million
    expect(attemptCost(TABLE, 'm/cached', tokens(3300, 63, 1200))).toBe(0.005304);
    // 1,000 uncached × 2 + 500 written × 2.5 = 3,250 per million
    expect(attemptCost(TABLE, 'm/cached', tokens(1500, 0, 0, 500))).toBe(0.00325);
  });

  it('prices cached tokens at the input rate when the table has no cache rate', () => {
    expect(attemptCost(TABLE, 'm/plain', tokens(3300, 63, 1200))).toBe(
      attemptCost(TABLE, 'm/plain', tokens(3300, 63)),
    );
  });

  it('never lets cache counts push the uncached part below zero', () => {
    expect(attemptCost(TABLE, 'm/cached', tokens(100, 0, 400))).toBe(0.0002);
  });

  it('rounds to the six decimals cost_usd stores', () => {
    expect(attemptCost(TABLE, 'm/plain', tokens(1, 0))).toBe(0.000002);
    expect(attemptCost(TABLE, 'm/plain', tokens(0, 1))).toBe(0.000008);
    expect(attemptCost(TABLE, 'm/cached', tokens(4, 0, 4))).toBe(0.000002);
    // $0.0000012 rounds down, $0.0000018 up
    expect(attemptCost(TABLE, 'm/cheap', tokens(4, 0))).toBe(0.000001);
    expect(attemptCost(TABLE, 'm/cheap', tokens(6, 0))).toBe(0.000002);
  });

  it('is null for an unpriced model or unknown tokens, never zero', () => {
    expect(attemptCost(TABLE, 'm/unknown', tokens(100, 10))).toBeNull();
    expect(attemptCost(TABLE, 'constructor', tokens(100, 10))).toBeNull();
    expect(attemptCost(TABLE, 'm/plain', null)).toBeNull();
    expect(modelPrice(TABLE, 'toString')).toBeNull();
  });
});
