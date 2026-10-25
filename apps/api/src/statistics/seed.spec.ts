/** The bootstrap's seed and the selected-key values, without a database. */
import { describe, expect, it } from 'vitest';
import { seedFromExperimentId } from './compute.js';
import { keySelectionOf, keySelectionValue } from './contracts.js';

describe('seedFromExperimentId', () => {
  it('reads the first four bytes of sha256(id), big-endian', () => {
    // sha256('exp_01JBB7SVNS') starts 2ba192df; sha256('') starts e3b0c442.
    expect(seedFromExperimentId('exp_01JBB7SVNS')).toBe(0x2ba192df);
    expect(seedFromExperimentId('exp_01JBCMCPSM')).toBe(0x9199c5e3);
    expect(seedFromExperimentId('')).toBe(0xe3b0c442);
  });

  it('is an unsigned 32-bit integer, the same for the same id and different across ids', () => {
    const ids = ['exp_01JBB7SVNS', 'exp_01JBCMCPSM', 'exp_01JBFMCPVB', 'exp_01JBFSKMCP'];
    const seeds = ids.map(seedFromExperimentId);
    for (const seed of seeds) {
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
    expect(new Set(seeds).size).toBe(ids.length);
    expect(ids.map(seedFromExperimentId)).toEqual(seeds);
  });
});

describe('key selections', () => {
  it('read `primary` and `any_failed` as themselves and anything else as a key name', () => {
    expect(keySelectionOf('primary')).toEqual({ kind: 'primary' });
    expect(keySelectionOf('any_failed')).toEqual({ kind: 'any_failed' });
    expect(keySelectionOf('answer')).toEqual({ kind: 'named', key: 'answer' });
    for (const value of ['primary', 'any_failed', 'answer', 'reads_fixture']) {
      expect(keySelectionValue(keySelectionOf(value))).toBe(value);
    }
  });
});
