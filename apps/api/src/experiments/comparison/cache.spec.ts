/** The comparison's bounded cache: least recently used out first, a read counts as a use. */
import { describe, expect, it } from 'vitest';
import { COMPARISON_CACHE_SIZE } from './comparison.service.js';
import { LruCache } from './cache.js';

describe('LruCache', () => {
  it('evicts the least recently used entry past its capacity', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('replaces a value in place and makes it the most recent', () => {
    const cache = new LruCache<string, number>(2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('a', 10);
    cache.set('c', 3);
    expect(cache.get('a')).toBe(10);
    expect(cache.get('b')).toBeUndefined();
  });

  it('holds about 200 answers, never more', () => {
    expect(COMPARISON_CACHE_SIZE).toBe(200);
    const cache = new LruCache<number, number>(COMPARISON_CACHE_SIZE);
    for (let i = 0; i < 1000; i++) cache.set(i, i);
    expect(cache.size).toBe(200);
    expect(cache.get(799)).toBeUndefined();
    expect(cache.get(800)).toBe(800);
  });

  it('refuses a capacity that is not a positive integer', () => {
    expect(() => new LruCache(0)).toThrow(RangeError);
    expect(() => new LruCache(1.5)).toThrow(RangeError);
  });
});
