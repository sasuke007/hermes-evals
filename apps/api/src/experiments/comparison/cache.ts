/**
 * A small least-recently-used cache, bounded by entry count. The comparison
 * keeps its answers here keyed by everything they depend on (plan 10.3), so
 * an entry is never stale: when the results move, the key moves, and the
 * old entry ages out. A Map keeps insertion order, so the first key is the
 * least recently used one.
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`cache capacity must be a positive integer, got ${capacity}`);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  /** The value, now the most recently used; undefined when absent. */
  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  /** Stores the value as the most recently used, evicting the least recently used past capacity. */
  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
