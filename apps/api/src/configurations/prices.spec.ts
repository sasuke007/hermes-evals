import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePriceFile, readPriceModels } from './prices.js';

const PRICE = `input_per_1m: 0.6
    output_per_1m: 2.4
    checked_at: '2026-10-20'`;

describe('parsePriceFile', () => {
  it('reads a bare map of model id to price, in file order', () => {
    const models = parsePriceFile(
      `openai/gpt-6.1-sol:\n    ${PRICE}\nanthropic/x:\n    ${PRICE}\n`,
    );
    expect([...models.keys()]).toEqual(['openai/gpt-6.1-sol', 'anthropic/x']);
    expect(models.get('openai/gpt-6.1-sol')).toEqual({
      input_per_1m: 0.6,
      output_per_1m: 2.4,
      checked_at: '2026-10-20',
    });
  });

  it('reads the same map under a models key', () => {
    const models = parsePriceFile(`models:\n  openai/gpt-6.1-sol:\n    ${PRICE}\n`);
    expect([...models.keys()]).toEqual(['openai/gpt-6.1-sol']);
  });

  it('treats a bare model named models as a model', () => {
    const models = parsePriceFile(`models:\n    ${PRICE}\n`);
    expect([...models.keys()]).toEqual(['models']);
  });

  it('accepts an empty file as no prices', () => {
    expect(parsePriceFile('').size).toBe(0);
  });

  it('refuses a malformed price with the path of the problem', () => {
    expect(() => parsePriceFile('openai/gpt:\n  input_per_1m: -1\n')).toThrow(/openai\/gpt/);
    expect(() => parsePriceFile('- a\n- b\n')).toThrow(/not a price table/);
  });
});

describe('readPriceModels', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hermes-evals-prices-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('treats a missing file as no prices and no problem', async () => {
    expect(await readPriceModels(join(dir, 'prices.yaml'))).toEqual({
      models: new Map(),
      problem: null,
    });
  });

  it('reports a file it cannot use, with no prices', async () => {
    const path = join(dir, 'prices.yaml');
    await writeFile(path, 'openai/gpt: [1, 2]\n');
    const read = await readPriceModels(path);
    expect(read.models.size).toBe(0);
    expect(read.problem).toMatch(/prices\.yaml: not a price table/);
  });

  it('reads a valid file', async () => {
    const path = join(dir, 'prices.yaml');
    await writeFile(path, `openai/gpt-6.1-sol:\n    ${PRICE}\n`);
    const read = await readPriceModels(path);
    expect(read.problem).toBeNull();
    expect(read.models.get('openai/gpt-6.1-sol')?.output_per_1m).toBe(2.4);
  });
});
