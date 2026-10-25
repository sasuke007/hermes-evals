/**
 * Page state that lives in the query string (U4, plan 12.1): filters, sort, the comparison's
 * candidate and key. A reload, a shared link or Back restores the view. Each field is a
 * writable ref; writing replaces the query (no history entry per keystroke), writes in the
 * same tick are merged into one navigation, and a value equal to its default leaves the URL.
 *
 *   const url = useUrlState({
 *     status: urlEnum(['all', 'running', 'paused', 'completed', 'failed'], 'all'),
 *     sort: urlSort({ key: 'launched', dir: 'desc' }),
 *     execError: urlBool(false),
 *     candidate: urlOptional(),
 *   });
 *   url.status.value = 'running';          // ?status=running
 *   url.sort.value = { key: 'task', dir: 'asc' };   // ?sort=task ("-task" is descending)
 *
 * Codecs: urlString, urlOptional, urlEnum, urlNumber, urlBool, urlList, urlSort.
 */
import { computed, shallowRef, type WritableComputedRef } from 'vue';
import { useRoute, useRouter, type LocationQuery, type LocationQueryValue } from 'vue-router';
import type { DataTableSort } from '@/components/ui/types';

/** How one field reads from and writes to its query parameter. */
export interface UrlParam<T> {
  parse(raw: string | undefined): T;
  /** undefined drops the parameter (the value is the default). */
  serialize(value: T): string | undefined;
}

type ValueOf<P> = P extends UrlParam<infer T> ? T : never;
export type UrlState<S extends Record<string, UrlParam<unknown>>> = {
  [K in keyof S]: WritableComputedRef<ValueOf<S[K]>>;
};

export interface UrlStateOptions {
  /** replace (default) keeps one history entry per page; push adds one per change. */
  history?: 'replace' | 'push';
}

function first(value: LocationQueryValue | LocationQueryValue[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === null || v === undefined ? undefined : v;
}

export function useUrlState<S extends Record<string, UrlParam<unknown>>>(
  params: S,
  options: UrlStateOptions = {},
): UrlState<S> & { reset(): void } {
  const route = useRoute();
  const router = useRouter();
  /** Writes not yet in route.query: read through them so a write is visible at once. */
  const pending = shallowRef<Record<string, string | undefined>>({});
  let scheduled = false;

  function raw(key: string): string | undefined {
    if (key in pending.value) return pending.value[key];
    return first(route.query[key]);
  }

  async function flush(): Promise<void> {
    scheduled = false;
    const writes = pending.value;
    const query: LocationQuery = { ...route.query };
    for (const [key, value] of Object.entries(writes)) {
      if (value === undefined) delete query[key];
      else query[key] = value;
    }
    const same =
      Object.keys(query).length === Object.keys(route.query).length &&
      Object.entries(query).every(([k, v]) => first(route.query[k]) === first(v));
    try {
      if (!same) {
        const to = { path: route.path, query, hash: route.hash };
        await (options.history === 'push' ? router.push(to) : router.replace(to));
      }
    } finally {
      // Drop what landed; keep anything written while the navigation ran.
      const rest = { ...pending.value };
      for (const [key, value] of Object.entries(writes)) {
        if (rest[key] === value) delete rest[key];
      }
      pending.value = rest;
    }
  }

  function write(key: string, value: string | undefined): void {
    pending.value = { ...pending.value, [key]: value };
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => void flush());
    }
  }

  const state = {} as Record<string, WritableComputedRef<unknown>>;
  for (const [key, param] of Object.entries(params)) {
    state[key] = computed({
      get: () => param.parse(raw(key)),
      set: (value) => write(key, param.serialize(value)),
    });
  }

  /** Every field back to its default: their parameters leave the URL. */
  function reset(): void {
    for (const key of Object.keys(params)) write(key, undefined);
  }

  return Object.assign(state as unknown as UrlState<S>, { reset });
}

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

/** Free text; the default is not written. */
export function urlString(fallback = ''): UrlParam<string> {
  return {
    parse: (raw) => raw ?? fallback,
    serialize: (value) => (value === fallback ? undefined : value),
  };
}

/** A value that may be absent: the comparison's candidate, a run id. */
export function urlOptional(): UrlParam<string | null> {
  return {
    parse: (raw) => (raw === undefined || raw === '' ? null : raw),
    serialize: (value) => (value === null || value === '' ? undefined : value),
  };
}

/** One of a fixed list; anything else reads as the default. */
export function urlEnum<T extends string>(values: readonly T[], fallback: T): UrlParam<T> {
  return {
    parse: (raw) =>
      raw !== undefined && (values as readonly string[]).includes(raw) ? (raw as T) : fallback,
    serialize: (value) => (value === fallback ? undefined : value),
  };
}

/** A number, clamped; not a number reads as the default. */
export function urlNumber(
  fallback: number,
  bounds: { min?: number; max?: number; integer?: boolean } = {},
): UrlParam<number> {
  const fit = (n: number): number => {
    let v = bounds.integer ? Math.round(n) : n;
    if (bounds.min !== undefined) v = Math.max(bounds.min, v);
    if (bounds.max !== undefined) v = Math.min(bounds.max, v);
    return v;
  };
  return {
    parse: (raw) => {
      const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
      return Number.isFinite(n) ? fit(n) : fallback;
    },
    serialize: (value) => (value === fallback ? undefined : String(fit(value))),
  };
}

/** 1 or 0 in the URL (true, false and yes, no read too). */
export function urlBool(fallback = false): UrlParam<boolean> {
  return {
    parse: (raw) => {
      if (raw === undefined) return fallback;
      const v = raw.toLowerCase();
      if (v === '1' || v === 'true' || v === 'yes') return true;
      if (v === '0' || v === 'false' || v === 'no') return false;
      return fallback;
    },
    serialize: (value) => (value === fallback ? undefined : value ? '1' : '0'),
  };
}

/** A comma-separated list: ?configs=baseline,with-skill. */
export function urlList(fallback: readonly string[] = []): UrlParam<string[]> {
  const same = (a: readonly string[], b: readonly string[]): boolean =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  return {
    parse: (raw) =>
      raw === undefined
        ? [...fallback]
        : raw
            .split(',')
            .map((v) => v.trim())
            .filter((v) => v !== ''),
    serialize: (value) => (same(value, fallback) ? undefined : value.join(',')),
  };
}

/**
 * DataTable's sort: ?sort=duration is ascending, ?sort=-duration descending, ?sort= none
 * (where the default sorts). `keys` limits it to sortable columns; anything else reads as the
 * default.
 */
export function urlSort(
  fallback: DataTableSort | null,
  keys?: readonly string[],
): UrlParam<DataTableSort | null> {
  const text = (sort: DataTableSort | null): string | undefined =>
    sort ? `${sort.dir === 'desc' ? '-' : ''}${sort.key}` : undefined;
  return {
    parse: (raw) => {
      if (raw === undefined) return fallback;
      // ?sort= (empty): sorting was turned off where the default sorts.
      if (raw === '') return null;
      const desc = raw.startsWith('-');
      const key = desc ? raw.slice(1) : raw;
      if (!key || (keys && !keys.includes(key))) return fallback;
      return { key, dir: desc ? 'desc' : 'asc' };
    },
    serialize: (value) => (text(value) === text(fallback) ? undefined : (text(value) ?? '')),
  };
}
