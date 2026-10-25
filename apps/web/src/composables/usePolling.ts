/**
 * Calls `fn` every `intervalMs` while `enabled` holds (U3: the experiment list polls
 * GET /experiments every 5 s while anything runs; the inspector polls its events while the
 * run is live). The next call is scheduled when the previous one settles, so calls never
 * overlap. Polling pauses while the tab is hidden and calls at once when it is visible again.
 * A failing call is kept in `error` and polling goes on.
 *
 *   const { pending, error, runNow } = usePolling(() => store.refresh(), 5_000,
 *     () => store.anyRunning);
 */
import {
  getCurrentScope,
  onScopeDispose,
  readonly,
  ref,
  shallowRef,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue';

export interface PollingOptions {
  /** Call once as soon as polling is enabled, then every interval. Default false. */
  immediate?: boolean;
  /** Pause while document.visibilityState is hidden. Default true. */
  pauseWhenHidden?: boolean;
}

export function usePolling(
  fn: () => unknown,
  intervalMs: MaybeRefOrGetter<number>,
  enabled: MaybeRefOrGetter<boolean> = true,
  options: PollingOptions = {},
) {
  const pauseWhenHidden = options.pauseWhenHidden !== false;
  /** A call is in flight. */
  const pending = ref(false);
  /** The last call's failure; cleared by the next success. */
  const error = shallowRef<unknown>(null);
  /** When the last call settled (epoch ms). */
  const lastRunAt = ref<number | null>(null);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const hidden = (): boolean =>
    pauseWhenHidden && typeof document !== 'undefined' && document.visibilityState === 'hidden';
  const active = (): boolean => !disposed && toValue(enabled) && !hidden();

  function clear(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule(): void {
    clear();
    if (!active()) return;
    timer = setTimeout(
      () => {
        timer = null;
        void runNow();
      },
      Math.max(0, toValue(intervalMs)),
    );
  }

  /** Call now (unless a call is in flight), then go on from here. */
  async function runNow(): Promise<void> {
    if (pending.value) return;
    clear();
    pending.value = true;
    try {
      await fn();
      error.value = null;
    } catch (err) {
      error.value = err;
    } finally {
      pending.value = false;
      lastRunAt.value = Date.now();
    }
    schedule();
  }

  function onVisibility(): void {
    if (hidden()) clear();
    else if (active()) void runNow();
  }

  watch(
    () => toValue(enabled),
    (on) => {
      if (!on) clear();
      else if (options.immediate && !hidden()) void runNow();
      else schedule();
    },
    { immediate: true },
  );
  watch(
    () => toValue(intervalMs),
    () => {
      if (timer !== null) schedule();
    },
  );

  if (pauseWhenHidden && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  function stop(): void {
    disposed = true;
    clear();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  }
  if (getCurrentScope()) onScopeDispose(stop);

  return {
    pending: readonly(pending),
    error,
    lastRunAt: readonly(lastRunAt),
    runNow,
    stop,
  };
}
