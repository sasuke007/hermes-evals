/**
 * GET /system/events' shared poller, on fake timers with a scripted summary:
 * a read at once for the first subscriber, every 5 s after, the newest
 * summary for a late joiner, no reads once the last subscriber leaves, the
 * cap, and invalid or failed reads that keep the stream open.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { SystemEventSchema, type SystemEvent, type SystemSummary } from '@hermes-evals/shared';
import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SseSink } from '../../experiments/sse/sse-connection.js';
import { SystemEventsHub, type SystemEventsOptions } from './system-events.hub.js';

const summary = (queuedRuns: number): SystemSummary => ({
  running: {
    count: 1,
    scored: 2,
    total: 8,
    experiments: [{ id: 'e1', name: 'MCP vs baseline', scored: 2, total: 8 }],
  },
  workers: [
    {
      id: 'w1',
      status: 'online',
      lastHeartbeatAt: '2026-10-24T10:00:00.000Z',
      concurrency: 2,
      effectiveConcurrency: 2,
      slotsInUse: 1,
      slotsTotal: 4,
      sandboxProven: true,
    },
  ],
  queuedRuns,
});

class RecordingSink implements SseSink {
  readonly events: SystemEvent[] = [];
  closed = false;

  send(type: string, json: string): void {
    const event = SystemEventSchema.parse(JSON.parse(json));
    expect(type).toBe('summary');
    this.events.push(event);
  }

  close(): void {
    this.closed = true;
  }

  queued(): number[] {
    return this.events.map((e) => e.summary.queuedRuns);
  }
}

let next: SystemSummary | Error;
let reads: number;
let log: {
  setContext: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const source = {
  summary: (): Promise<SystemSummary> => {
    reads += 1;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  },
};

const hub = (options: Partial<SystemEventsOptions> = {}) =>
  new SystemEventsHub(source as never, log as unknown as PinoLogger, options);

beforeEach(() => {
  vi.useFakeTimers();
  next = summary(4);
  reads = 0;
  log = { setContext: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SystemEventsHub', () => {
  it('reads at once for the first subscriber, then every 5 s, once for all', async () => {
    const h = hub();
    const a = new RecordingSink();
    const b = new RecordingSink();
    h.subscribe(a);
    h.subscribe(b);
    expect(h.polling).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    expect(a.queued()).toEqual([4]);
    expect(b.queued()).toEqual([4]);
    expect(a.events[0]).toMatchObject({ type: 'summary', summary: summary(4) });

    next = summary(3);
    await vi.advanceTimersByTimeAsync(4999);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(2);
    expect(a.queued()).toEqual([4, 3]);
  });

  it('gives a late subscriber the newest summary at once', async () => {
    const h = hub();
    h.subscribe(new RecordingSink());
    await vi.advanceTimersByTimeAsync(1000);
    const late = new RecordingSink();
    h.subscribe(late);
    expect(late.queued()).toEqual([4]);
    expect(reads).toBe(1);
  });

  it('stops reading when the last subscriber leaves, and starts afresh after', async () => {
    const h = hub();
    const leaveA = h.subscribe(new RecordingSink());
    const leaveB = h.subscribe(new RecordingSink());
    await vi.advanceTimersByTimeAsync(5000);
    expect(reads).toBe(2);
    leaveA();
    expect(h.polling).toBe(true);
    leaveB();
    leaveB();
    expect(h.subscribers).toBe(0);
    expect(h.polling).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(2);

    const again = new RecordingSink();
    h.subscribe(again);
    // No stale summary from the earlier poller: the fresh one reads first.
    expect(again.events).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(again.queued()).toEqual([4]);
  });

  it('writes nothing from a read that outlived its poller', async () => {
    let release: (s: SystemSummary) => void = () => {};
    const slow = vi.spyOn(source, 'summary').mockImplementation(
      () =>
        new Promise<SystemSummary>((resolve) => {
          release = resolve;
        }),
    );
    const h = hub();
    const sink = new RecordingSink();
    const leave = h.subscribe(sink);
    await vi.advanceTimersByTimeAsync(0);
    leave();
    slow.mockRestore();
    release(summary(9));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sink.events).toEqual([]);
    expect(h.polling).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('answers 503 past the cap', () => {
    const h = hub({ maxSubscribers: 1 });
    h.admit();
    const leave = h.subscribe(new RecordingSink());
    expect(() => h.admit()).toThrow(ServiceUnavailableException);
    leave();
    expect(() => h.admit()).not.toThrow();
  });

  it('keeps the streams open through a failed read and an invalid summary', async () => {
    next = new Error('connection refused');
    const h = hub();
    const sink = new RecordingSink();
    h.subscribe(sink);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledTimes(1);

    next = { ...summary(1), queuedRuns: -1 };
    await vi.advanceTimersByTimeAsync(5000);
    expect(log.error).toHaveBeenCalledWith(expect.anything(), 'dropped an invalid system event');
    expect(sink.events).toEqual([]);
    expect(sink.closed).toBe(false);

    next = summary(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sink.queued()).toEqual([2]);
  });

  it('closes every stream on shutdown', async () => {
    const h = hub();
    const sink = new RecordingSink();
    h.subscribe(sink);
    await vi.advanceTimersByTimeAsync(0);
    h.onModuleDestroy();
    expect(sink.closed).toBe(true);
    expect(h.polling).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
