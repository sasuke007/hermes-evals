import { describe, expect, it } from 'vitest';
import {
  MISSING,
  formatAgo,
  formatBytes,
  formatCount,
  formatDateTime,
  formatDateTimeSeconds,
  formatDuration,
  formatRate,
  formatSha256,
  formatSigned,
  formatUsd,
  plural,
  shortHash,
  shortRevision,
} from '@/lib/format';

describe('format', () => {
  it('signs differences with a true minus, and none on zero', () => {
    expect(formatSigned(0.2167)).toBe('+0.217');
    expect(formatSigned(-0.04)).toBe('−0.040');
    expect(formatSigned(0)).toBe('0.000');
    expect(formatSigned(-0.0004)).toBe('0.000');
    expect(formatSigned(0.2, 1)).toBe('+0.2');
    expect(formatSigned(null)).toBe(MISSING);
  });

  it('writes rates with three decimals, or two in the grid', () => {
    expect(formatRate(0.63333)).toBe('0.633');
    expect(formatRate(0.8, 2)).toBe('0.80');
    expect(formatRate(undefined)).toBe('–');
  });

  it('writes durations as 52 s, 4m 12s, 1h 03m', () => {
    expect(formatDuration(52)).toBe('52 s');
    expect(formatDuration(252)).toBe('4m 12s');
    expect(formatDuration(3780)).toBe('1h 03m');
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(null)).toBe(MISSING);
  });

  it('writes money and counts', () => {
    expect(formatUsd(0.98)).toBe('$0.98');
    expect(formatUsd(1.6912)).toBe('$1.69');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(null)).toBe(MISSING);
    expect(formatCount(14200)).toBe('14,200');
    expect(formatCount(Number.NaN)).toBe(MISSING);
  });

  it('shortens revisions and hashes', () => {
    expect(shortRevision('4d04303a1b2c3d4e5f60718293a4b5c6d7e8f901')).toBe('4d04303');
    expect(shortRevision('hermes-agent v0.22.4 @ 4d04303a1b2c3d4e5f60718293a4b5c6d7e8f901')).toBe(
      'hermes-agent v0.22.4 @ 4d04303',
    );
    expect(shortRevision('hermes-agent v0.22.4 @ 4d04303')).toBe('hermes-agent v0.22.4 @ 4d04303');
    expect(shortHash(`sha256:7a6920${'0'.repeat(58)}`)).toBe('7a69200');
  });

  it('writes times', () => {
    const at = new Date(2026, 9, 23, 15, 2, 9);
    expect(formatDateTime(at)).toBe('23 Oct 15:02');
    expect(formatAgo(at, at.getTime() + 12_000)).toBe('12 s ago');
    expect(formatAgo(at, at.getTime() + 120_000)).toBe('2 min ago');
    expect(formatAgo(at, at.getTime() + 3 * 3_600_000)).toBe('3 h ago');
    expect(formatAgo('nonsense')).toBe(MISSING);
  });

  it('counts with the noun, grouped', () => {
    expect([plural(1, 'experiment'), plural(3, 'experiment')]).toEqual([
      '1 experiment',
      '3 experiments',
    ]);
    expect(plural(0, 'configuration')).toBe('0 configurations');
    expect(plural(2000, 'file')).toBe('2,000 files');
    expect(plural(2, 'execution error', 'execution errors')).toBe('2 execution errors');
  });

  it('writes sizes in 1024-byte units as the API does', () => {
    expect(formatBytes(114)).toBe('114 B');
    expect(formatBytes(4_198)).toBe('4.1 KB');
    expect(formatBytes(7782)).toBe('7.6 KB');
    expect(formatBytes(219_136)).toBe('214 KB');
    expect(formatBytes(3_200_000)).toBe('3.1 MB');
    expect(formatBytes(72.4 * 1024 * 1024)).toBe('72.4 MB');
    expect(formatBytes(2 * 1024 ** 3)).toBe('2 GB');
    expect(formatBytes(null)).toBe(MISSING);
  });

  it('writes a sha256 with its head and tail', () => {
    const hash = `51e0a9c3${'0'.repeat(52)}0d17`;
    expect(formatSha256(hash)).toBe('sha256:51e0a9c3…0d17');
    expect(formatSha256(`sha256:${hash}`, 12)).toBe('sha256:51e0a9c30000…0d17');
    expect(formatSha256('sha256:abc')).toBe('sha256:abc');
  });

  it('writes a moment to the second', () => {
    expect(formatDateTimeSeconds(new Date(2026, 9, 23, 15, 41, 7))).toBe('23 Oct 15:41:07');
    expect(formatDateTimeSeconds(null)).toBe(MISSING);
  });
});
