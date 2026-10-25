/**
 * One server-sent events stream, validated (UI_FLOWS 19 #9, plan 11): every message is parsed
 * with the shared zod schema of its stream, and the connection says how it is doing.
 *
 *   const live = useSse(`/experiments/${id}/events`, ExperimentEventSchema, {
 *     events: EXPERIMENT_EVENT_TYPES,
 *     onEvent: (event) => store.patch(event),
 *     onReconnect: () => store.refetch(id),
 *   });
 *   <LiveIndicator :state="live.indicator.value" :attempt="live.attempt.value"
 *     :last-event-at="live.lastEventAt.value" @retry="live.retry()" />
 *
 * The path is the API path without the /api prefix, as for apiGet; null (or a getter that
 * returns null) keeps the stream closed, so a page in fixtures mode passes null. The API
 * names every message (`event: <type>`), so `events` lists the names to listen for; the
 * default is the unnamed `message`.
 *
 * States: connecting (a fresh try) → live (open) → reconnecting (dropped; tries again after 1,
 * 2, 5, then every 10 s) → offline (no connection for 30 s; it keeps trying every 10 s, and
 * retry() tries at once) → idle (stopped). A message that fails its schema is dropped and
 * counted, never passed on. When the stream opens again after a drop, onReconnect runs so the
 * page can refetch what it missed: the API does not replay events.
 *
 * A stream holds one of the six connections a browser opens to a host over HTTP/1.1, which
 * every tab of the app shares. So it lets go when nobody can see it: at once when the page is
 * hidden for navigation (`pagehide`, including a page kept in the back/forward cache, which
 * would otherwise keep its stream), and SSE_HIDDEN_CLOSE_MS after its tab goes to the
 * background. It opens again when the page shows, and onReconnect refetches what was missed.
 */
import {
  computed,
  onScopeDispose,
  getCurrentScope,
  readonly,
  ref,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue';
import type { ZodType } from 'zod';
import { API_BASE } from '@/api/client';
import type { LiveState } from '@/components/ui/types';

export type SseState = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'offline';

/** Reconnect delays: 1, 2, 5, then 10 s for every further try. */
export const SSE_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000];
/** Without a connection this long, the stream reads offline. */
export const SSE_OFFLINE_AFTER_MS = 30_000;
/** A background tab closes its stream after this long (see the header). */
export const SSE_HIDDEN_CLOSE_MS = 10_000;

/** The part of EventSource the composable uses, so tests can pass a fake. */
export interface EventSourceLike {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void;
  close(): void;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface UseSseOptions<T> {
  /** The `event:` names to listen for. Default: the unnamed `message` event. */
  events?: readonly string[];
  /** Each event that passed its schema, in order. */
  onEvent?: (event: T) => void;
  /** The stream opened again after a drop: refetch what the events do not carry. */
  onReconnect?: () => void;
  /** An event that failed its schema (it is dropped either way). */
  onInvalid?: (error: unknown, raw: string) => void;
  /** false: connect only on start(). Default true (as soon as the path is set). */
  immediate?: boolean;
  backoffMs?: readonly number[];
  offlineAfterMs?: number;
  /** Let the stream go while the page is hidden (see the header). Default true. */
  suspendWhenHidden?: boolean;
  /** Creates the connection; default `new EventSource(url)`. */
  eventSource?: EventSourceFactory;
}

const defaultFactory: EventSourceFactory = (url) => {
  if (typeof EventSource === 'undefined') throw new Error('EventSource is not available');
  return new EventSource(url) as unknown as EventSourceLike;
};

export function useSse<T>(
  path: MaybeRefOrGetter<string | null>,
  schema: ZodType<T>,
  options: UseSseOptions<T> = {},
) {
  const backoff = options.backoffMs ?? SSE_BACKOFF_MS;
  const offlineAfter = options.offlineAfterMs ?? SSE_OFFLINE_AFTER_MS;
  const factory = options.eventSource ?? defaultFactory;
  const names = options.events && options.events.length > 0 ? options.events : ['message'];

  const state = ref<SseState>('idle');
  /** Reconnect tries since the stream dropped; 0 while live. */
  const attempt = ref(0);
  /** The last event that passed its schema. */
  const data = shallowRef<T | null>(null);
  /** When that event arrived (ISO time). */
  const lastEventAt = ref<string | null>(null);
  /** Events dropped because they failed the schema. */
  const invalidEvents = ref(0);

  let source: EventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let offlineTimer: ReturnType<typeof setTimeout> | null = null;
  let droppedAt: number | null = null;
  let everOpened = false;
  let started = false;
  /**
   * The path the current connection (or its pending retry) belongs to, so a path change that
   * start() already followed does not open the same stream a second time.
   */
  let openedPath: string | null = null;
  /** Closed because nobody can see the page; reopens when it shows. */
  let suspended = false;
  let hiddenTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (offlineTimer !== null) clearTimeout(offlineTimer);
    retryTimer = null;
    offlineTimer = null;
  }

  function closeSource(): void {
    if (!source) return;
    source.onopen = null;
    source.onerror = null;
    source.close();
    source = null;
  }

  function handle(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      invalidEvents.value++;
      options.onInvalid?.(err, raw);
      return;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      invalidEvents.value++;
      options.onInvalid?.(result.error, raw);
      return;
    }
    data.value = result.data;
    lastEventAt.value = new Date().toISOString();
    options.onEvent?.(result.data);
  }

  function open(): void {
    const target = toValue(path);
    closeSource();
    // A stream of another path is a first connection, not a reconnect.
    if (target !== openedPath) everOpened = false;
    openedPath = target;
    if (target === null) {
      state.value = 'idle';
      return;
    }
    if (droppedAt === null) state.value = 'connecting';
    let es: EventSourceLike;
    try {
      es = factory(`${API_BASE}${target}`);
    } catch {
      dropped();
      return;
    }
    source = es;
    es.onopen = () => {
      if (source !== es) return;
      const reconnected = everOpened || droppedAt !== null;
      everOpened = true;
      droppedAt = null;
      attempt.value = 0;
      clearTimers();
      state.value = 'live';
      if (reconnected) options.onReconnect?.();
    };
    es.onerror = () => {
      if (source !== es) return;
      dropped();
    };
    for (const name of names) {
      es.addEventListener(name, (event) => {
        if (source === es) handle(event.data);
      });
    }
  }

  /** The connection failed or dropped: wait out the backoff, then try again. */
  function dropped(): void {
    closeSource();
    if (!started) return;
    const now = Date.now();
    droppedAt ??= now;
    const down = now - droppedAt;
    state.value = down >= offlineAfter ? 'offline' : 'reconnecting';
    if (state.value === 'reconnecting' && offlineTimer === null) {
      offlineTimer = setTimeout(() => {
        offlineTimer = null;
        if (state.value === 'reconnecting') state.value = 'offline';
      }, offlineAfter - down);
    }
    const delay = backoff[Math.min(attempt.value, backoff.length - 1)] ?? 10_000;
    attempt.value++;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, delay);
  }

  function clearHiddenTimer(): void {
    if (hiddenTimer !== null) clearTimeout(hiddenTimer);
    hiddenTimer = null;
  }

  /** Connect (again). Safe to call while connected. */
  function start(): void {
    started = true;
    suspended = false;
    if (source || retryTimer !== null) return;
    open();
  }

  /** Close the stream and stop retrying. */
  function stop(): void {
    started = false;
    suspended = false;
    clearHiddenTimer();
    clearTimers();
    closeSource();
    droppedAt = null;
    attempt.value = 0;
    state.value = 'idle';
  }

  /** Nobody can see the page: close the stream, and remember to open it again. */
  function suspend(): void {
    clearHiddenTimer();
    if (!started || suspended) return;
    suspended = true;
    clearTimers();
    closeSource();
    droppedAt = null;
    attempt.value = 0;
    state.value = 'idle';
  }

  /** The page shows again: reopen; onReconnect then refetches what was missed. */
  function resume(): void {
    clearHiddenTimer();
    if (!suspended) return;
    suspended = false;
    if (started) open();
  }

  /** Offline · Retry: try at once instead of waiting out the backoff. */
  function retry(): void {
    if (!started || suspended) {
      start();
      return;
    }
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    open();
  }

  // A new path (or null) replaces the stream, unless start() has already opened it.
  watch(
    () => toValue(path),
    (next, previous) => {
      if (next === previous || !started || next === openedPath) return;
      clearTimers();
      droppedAt = null;
      attempt.value = 0;
      everOpened = false;
      if (!suspended) open();
    },
  );

  if (options.suspendWhenHidden !== false && typeof window !== 'undefined') {
    const onPageHide = () => suspend();
    const onPageShow = () => resume();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        resume();
      } else if (hiddenTimer === null && started && !suspended) {
        hiddenTimer = setTimeout(suspend, SSE_HIDDEN_CLOSE_MS);
      }
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisibility);
    if (getCurrentScope()) {
      onScopeDispose(() => {
        window.removeEventListener('pagehide', onPageHide);
        window.removeEventListener('pageshow', onPageShow);
        document.removeEventListener('visibilitychange', onVisibility);
      });
    }
  }

  if (options.immediate !== false) start();
  if (getCurrentScope()) onScopeDispose(stop);

  /** The state as LiveIndicator draws it: connecting counts as live. */
  const indicator = computed<LiveState>(() => {
    switch (state.value) {
      case 'reconnecting':
        return 'reconnecting';
      case 'offline':
        return 'offline';
      case 'idle':
        return 'paused';
      default:
        return 'live';
    }
  });

  return {
    state: readonly(state),
    attempt: readonly(attempt),
    data,
    lastEventAt: readonly(lastEventAt),
    invalidEvents: readonly(invalidEvents),
    indicator,
    start,
    stop,
    retry,
  };
}

export type UseSseReturn<T> = ReturnType<typeof useSse<T>>;
