import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { z } from 'zod';
import { SSE_HIDDEN_CLOSE_MS, useSse } from '@/composables/useSse';
import { FakeEventSource, fakeFactory } from './fakeEventSource';

const PingSchema = z.object({ type: z.literal('ping'), n: z.number() });
type Ping = z.infer<typeof PingSchema>;

let scope = effectScope();

function open(path: string | null = '/experiments/e1/events', extra = {}) {
  const events: Ping[] = [];
  const onReconnect = vi.fn<() => void>();
  const onInvalid = vi.fn<(error: unknown, raw: string) => void>();
  const sse = scope.run(() =>
    useSse(path, PingSchema, {
      events: ['ping'],
      eventSource: fakeFactory,
      onEvent: (e) => events.push(e),
      onReconnect,
      onInvalid,
      ...extra,
    }),
  )!;
  return { sse, events, onReconnect, onInvalid };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.reset();
  scope = effectScope();
});
afterEach(() => {
  scope.stop();
  vi.useRealTimers();
});

describe('useSse', () => {
  it('connects to /api + path and goes live on open', () => {
    const { sse } = open();
    expect(FakeEventSource.last.url).toBe('/api/experiments/e1/events');
    expect(sse.state.value).toBe('connecting');
    expect(sse.indicator.value).toBe('live');
    FakeEventSource.last.open();
    expect(sse.state.value).toBe('live');
    expect(sse.attempt.value).toBe(0);
  });

  it('passes on named events that match the schema, and drops the rest', () => {
    const { sse, events, onInvalid } = open();
    const es = FakeEventSource.last;
    es.open();
    es.emit('ping', { type: 'ping', n: 1 });
    es.emit('ping', { type: 'ping', n: 'two' });
    es.emit('ping', 'not json');
    es.emit('other', { type: 'ping', n: 3 });
    expect(events).toEqual([{ type: 'ping', n: 1 }]);
    expect(sse.data.value).toEqual({ type: 'ping', n: 1 });
    expect(sse.lastEventAt.value).not.toBeNull();
    expect(sse.invalidEvents.value).toBe(2);
    expect(onInvalid).toHaveBeenCalledTimes(2);
  });

  it('reconnects after 1, 2, 5, then 10 s, counting attempts', async () => {
    const { sse } = open();
    FakeEventSource.last.open();
    const delays = [1_000, 2_000, 5_000, 10_000, 10_000];
    for (const [i, delay] of delays.entries()) {
      FakeEventSource.last.fail();
      expect(FakeEventSource.last.closed).toBe(true);
      expect(sse.attempt.value).toBe(i + 1);
      const before = FakeEventSource.all.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(FakeEventSource.all.length).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeEventSource.all.length).toBe(before + 1);
    }
  });

  it('reads reconnecting, then offline after 30 s without a connection, and keeps trying', async () => {
    const { sse } = open();
    FakeEventSource.last.open();
    FakeEventSource.last.fail();
    expect(sse.state.value).toBe('reconnecting');
    expect(sse.indicator.value).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    FakeEventSource.last.fail();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(sse.state.value).toBe('offline');
    expect(sse.indicator.value).toBe('offline');
    // The try in flight fails too: it tries again within 10 s and still reads offline.
    FakeEventSource.last.fail();
    expect(sse.state.value).toBe('offline');
    const before = FakeEventSource.all.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeEventSource.all.length).toBe(before + 1);
  });

  it('counts a second drop after a recovery from the new drop, not the first', async () => {
    const { sse } = open();
    FakeEventSource.last.open();
    FakeEventSource.last.fail();
    await vi.advanceTimersByTimeAsync(1_000);
    FakeEventSource.last.open();
    expect(sse.state.value).toBe('live');
    await vi.advanceTimersByTimeAsync(120_000);
    FakeEventSource.last.fail();
    expect(sse.state.value).toBe('reconnecting');
    expect(sse.attempt.value).toBe(1);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(sse.state.value).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sse.state.value).toBe('offline');
  });

  it('runs onReconnect when the stream is back, and only then', async () => {
    const { sse, onReconnect } = open();
    FakeEventSource.last.open();
    expect(onReconnect).not.toHaveBeenCalled();
    FakeEventSource.last.fail();
    await vi.advanceTimersByTimeAsync(1_000);
    FakeEventSource.last.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(sse.state.value).toBe('live');
    expect(sse.attempt.value).toBe(0);
  });

  it('retry() tries at once instead of waiting', async () => {
    const { sse } = open();
    FakeEventSource.last.fail();
    const before = FakeEventSource.all.length;
    sse.retry();
    expect(FakeEventSource.all.length).toBe(before + 1);
    // The backoff timer was cleared: nothing more opens at 1 s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeEventSource.all.length).toBe(before + 1);
  });

  it('stays closed for a null path, and follows a path that changes', async () => {
    const path = ref<string | null>(null);
    const { sse } = open(null);
    expect(FakeEventSource.all).toHaveLength(0);
    expect(sse.state.value).toBe('idle');
    scope.stop();
    scope = effectScope();
    const live = scope.run(() =>
      useSse(path, PingSchema, { events: ['ping'], eventSource: fakeFactory }),
    )!;
    path.value = '/system/events';
    await nextTick();
    expect(FakeEventSource.last.url).toBe('/api/system/events');
    const first = FakeEventSource.last;
    path.value = '/experiments/e2/events';
    await nextTick();
    expect(first.closed).toBe(true);
    expect(FakeEventSource.last.url).toBe('/api/experiments/e2/events');
    expect(live.state.value).toBe('connecting');
  });

  it('opens a path once when start() follows the path change (an experiment page opening)', async () => {
    const path = ref<string | null>(null);
    const opened = vi.fn<() => void>();
    const live = scope.run(() =>
      useSse(path, PingSchema, {
        events: ['ping'],
        eventSource: fakeFactory,
        immediate: false,
        onReconnect: opened,
      }),
    )!;
    path.value = '/experiments/a/events';
    live.start();
    await nextTick();
    expect(FakeEventSource.all.map((es) => es.url)).toEqual(['/api/experiments/a/events']);
    expect(FakeEventSource.last.closed).toBe(false);
    FakeEventSource.last.open();
    // Another experiment: stop, a new path, start. Still one stream, and no reconnect.
    live.stop();
    path.value = '/experiments/b/events';
    live.start();
    await nextTick();
    expect(FakeEventSource.all.map((es) => es.url)).toEqual([
      '/api/experiments/a/events',
      '/api/experiments/b/events',
    ]);
    expect(FakeEventSource.last.closed).toBe(false);
    FakeEventSource.last.open();
    expect(opened).not.toHaveBeenCalled();
    expect(live.state.value).toBe('live');
  });

  it('ignores events from a stream that a path change replaced', async () => {
    const path = ref<string | null>('/experiments/a/events');
    const events: Ping[] = [];
    scope.run(() =>
      useSse(path, PingSchema, {
        events: ['ping'],
        eventSource: fakeFactory,
        onEvent: (e) => events.push(e),
      }),
    );
    const first = FakeEventSource.last;
    first.open();
    path.value = '/experiments/b/events';
    await nextTick();
    first.emit('ping', { type: 'ping', n: 1 });
    FakeEventSource.last.emit('ping', { type: 'ping', n: 2 });
    expect(events).toEqual([{ type: 'ping', n: 2 }]);
  });

  it('waits for start() when immediate is false, and closes on stop() and scope disposal', () => {
    const { sse } = open('/system/events', { immediate: false });
    expect(FakeEventSource.all).toHaveLength(0);
    sse.start();
    expect(FakeEventSource.all).toHaveLength(1);
    sse.stop();
    expect(FakeEventSource.last.closed).toBe(true);
    expect(sse.state.value).toBe('idle');
    sse.start();
    const es = FakeEventSource.last;
    scope.stop();
    expect(es.closed).toBe(true);
  });

  it('does not reconnect after stop()', async () => {
    const { sse } = open();
    FakeEventSource.last.fail();
    sse.stop();
    const before = FakeEventSource.all.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeEventSource.all.length).toBe(before);
  });

  describe('when nobody can see the page', () => {
    let visibility: DocumentVisibilityState = 'visible';
    beforeEach(() => {
      visibility = 'visible';
      vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    });
    afterEach(() => vi.restoreAllMocks());
    const setVisibility = (next: DocumentVisibilityState) => {
      visibility = next;
      document.dispatchEvent(new Event('visibilitychange'));
    };

    it('lets go on pagehide (the back/forward cache) and reopens on pageshow, refetching', () => {
      const { sse, onReconnect } = open();
      const first = FakeEventSource.last;
      first.open();
      window.dispatchEvent(new Event('pagehide'));
      expect(first.closed).toBe(true);
      expect(sse.state.value).toBe('idle');
      window.dispatchEvent(new Event('pageshow'));
      expect(FakeEventSource.all).toHaveLength(2);
      FakeEventSource.last.open();
      expect(sse.state.value).toBe('live');
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it('closes a background tab’s stream after a while, and opens it when the tab shows', async () => {
      const { sse, onReconnect } = open();
      const first = FakeEventSource.last;
      first.open();
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(SSE_HIDDEN_CLOSE_MS - 1);
      expect(first.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(first.closed).toBe(true);
      // No reconnect tries while hidden.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeEventSource.all).toHaveLength(1);
      setVisibility('visible');
      expect(FakeEventSource.all).toHaveLength(2);
      FakeEventSource.last.open();
      expect(sse.state.value).toBe('live');
      expect(onReconnect).toHaveBeenCalledTimes(1);
    });

    it('keeps the stream when the tab shows again before the grace period ends', async () => {
      open();
      const first = FakeEventSource.last;
      first.open();
      setVisibility('hidden');
      await vi.advanceTimersByTimeAsync(SSE_HIDDEN_CLOSE_MS / 2);
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(SSE_HIDDEN_CLOSE_MS);
      expect(first.closed).toBe(false);
      expect(FakeEventSource.all).toHaveLength(1);
    });

    it('stays open when suspendWhenHidden is false', () => {
      open('/system/events', { suspendWhenHidden: false });
      const first = FakeEventSource.last;
      window.dispatchEvent(new Event('pagehide'));
      expect(first.closed).toBe(false);
    });
  });
});
