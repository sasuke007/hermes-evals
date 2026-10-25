import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LeaseLostError, type AttemptEventInput } from '../contracts.js';
import { EventBatcher } from './event-batcher.js';

const event = (n: number): AttemptEventInput => ({
  ts: n,
  type: 'text',
  payload: { type: 'text', text: `t${n}` },
});

/** A sink whose writes resolve only when the test says so. */
function slowSink() {
  const writes: Array<{
    events: AttemptEventInput[];
    done: () => void;
    fail: (e: unknown) => void;
  }> = [];
  return {
    writes,
    appendEvents: (events: readonly AttemptEventInput[]) =>
      new Promise<void>((done, fail) => writes.push({ events: [...events], done, fail })),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EventBatcher', () => {
  it('writes a full batch of 50 at once, and the rest after 500 ms', async () => {
    const sink = slowSink();
    const batcher = new EventBatcher(sink);
    for (let i = 1; i <= 57; i++) batcher.push(event(i));
    expect(sink.writes.map((w) => w.events.length)).toEqual([50]);
    sink.writes[0]!.done();
    await vi.advanceTimersByTimeAsync(499);
    expect(sink.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sink.writes.map((w) => w.events.length)).toEqual([50, 7]);
    sink.writes[1]!.done();
    await batcher.close();
    expect(batcher.written).toBe(57);
  });

  it('writes one batch at a time, in arrival order, and queues what arrives meanwhile', async () => {
    const sink = slowSink();
    const batcher = new EventBatcher(sink, { maxBatch: 3, intervalMs: 100 });
    for (let i = 1; i <= 3; i++) batcher.push(event(i));
    for (let i = 4; i <= 10; i++) batcher.push(event(i));
    // The first write is still running: nothing else starts.
    expect(sink.writes).toHaveLength(1);
    sink.writes[0]!.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.writes).toHaveLength(2);
    sink.writes[1]!.done();
    await vi.advanceTimersByTimeAsync(0);
    sink.writes[2]!.done();
    await vi.advanceTimersByTimeAsync(0);
    // One left over waits for the interval, or for close.
    const closing = batcher.close();
    await vi.advanceTimersByTimeAsync(0);
    sink.writes.at(-1)!.done();
    await closing;
    const order = sink.writes.flatMap((w) => w.events.map((e) => e.ts));
    expect(order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(sink.writes.map((w) => w.events.length)).toEqual([3, 3, 3, 1]);
  });

  it('stops at the first failed write, reports it once, and close rethrows it', async () => {
    const sink = slowSink();
    const onFailure = vi.fn();
    const batcher = new EventBatcher(sink, { maxBatch: 2, onFailure });
    batcher.push(event(1));
    batcher.push(event(2));
    const lost = new LeaseLostError('A');
    sink.writes[0]!.fail(lost);
    await vi.advanceTimersByTimeAsync(0);
    expect(onFailure).toHaveBeenCalledWith(lost);
    expect(batcher.failed).toBe(true);
    batcher.push(event(3));
    batcher.push(event(4));
    await expect(batcher.close()).rejects.toBe(lost);
    expect(sink.writes).toHaveLength(1);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('tries a batch that failed for another reason again, at the same place in the order', async () => {
    const sink = slowSink();
    const onFailure = vi.fn();
    const batcher = new EventBatcher(sink, { maxBatch: 2, onFailure, retryDelaysMs: [100] });
    batcher.push(event(1));
    batcher.push(event(2));
    batcher.push(event(3));
    sink.writes[0]!.fail(new Error('Connection terminated unexpectedly'));
    await vi.advanceTimersByTimeAsync(99);
    expect(sink.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    // The same two events again, not the third.
    expect(sink.writes[1]!.events.map((e) => e.ts)).toEqual([1, 2]);
    sink.writes[1]!.done();
    const closing = batcher.close();
    await vi.advanceTimersByTimeAsync(0);
    sink.writes[2]!.done();
    await closing;
    expect(sink.writes.map((w) => w.events.map((e) => e.ts))).toEqual([[1, 2], [1, 2], [3]]);
    expect(batcher.written).toBe(3);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('gives up once writes have failed for failAfterMs without a break', async () => {
    const failing = {
      appendEvents: vi.fn(() => Promise.reject(new Error('the database is down'))),
    };
    const onFailure = vi.fn();
    const batcher = new EventBatcher(failing, {
      maxBatch: 1,
      onFailure,
      failAfterMs: 10_000,
      retryDelaysMs: [1_000],
    });
    batcher.push(event(1));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(onFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(batcher.failed).toBe(true);
    await expect(batcher.close()).rejects.toThrow('the database is down');
    expect(failing.appendEvents.mock.calls.length).toBe(11);
  });

  it('drops events past maxQueued, counts them, and reports the first drop once', async () => {
    const sink = slowSink();
    const onOverflow = vi.fn();
    const batcher = new EventBatcher(sink, { maxBatch: 2, maxQueued: 4, onOverflow });
    for (let i = 1; i <= 9; i++) batcher.push(event(i));
    // The first write took 2 events and is still running; they stay queued until it commits.
    expect(batcher.pending).toBe(4);
    expect(batcher.dropped).toBe(5);
    expect(onOverflow).toHaveBeenCalledTimes(1);
    expect(onOverflow).toHaveBeenCalledWith(4);
    sink.writes[0]!.done();
    await vi.advanceTimersByTimeAsync(0);
    sink.writes[1]!.done();
    await batcher.close();
    expect(sink.writes.flatMap((w) => w.events.map((e) => e.ts))).toEqual([1, 2, 3, 4]);
  });

  it('drains a long backlog in order, in larger statements', async () => {
    const written: number[] = [];
    const sizes: number[] = [];
    const sink = {
      appendEvents: async (events: readonly AttemptEventInput[]) => {
        sizes.push(events.length);
        written.push(...events.map((e) => e.ts));
      },
    };
    const batcher = new EventBatcher(sink);
    for (let i = 1; i <= 20_000; i++) batcher.push(event(i));
    await batcher.close();
    expect(written).toEqual(Array.from({ length: 20_000 }, (_, i) => i + 1));
    expect(Math.max(...sizes)).toBe(500);
    expect(sizes.length).toBeLessThan(100);
  });

  it('close with nothing queued writes nothing', async () => {
    const sink = slowSink();
    await new EventBatcher(sink).close();
    expect(sink.writes).toEqual([]);
  });
});
