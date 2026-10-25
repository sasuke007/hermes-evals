/**
 * The experiment stream's shared pollers, on fake timers with a scripted
 * LiveSource: one poller per experiment whatever the subscriber count, a
 * full read only when the version moved, initial events for late joiners,
 * no polling once the last subscriber leaves, the subscriber cap, invalid
 * events dropped and failed polls retried.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import {
  ExperimentEventSchema,
  type ExperimentEvent,
  type ExperimentSpend,
} from '@hermes-evals/shared';
import type { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyCounts } from '../views/numbers.js';
import type { LiveRun, LiveState } from './experiment-diff.js';
import { ExperimentEventsHub, type ExperimentEventsOptions } from './experiment-events.hub.js';
import type { LiveSource } from './live-source.js';
import type { SseSink } from './sse-connection.js';

const SPEND: ExperimentSpend = {
  spentUsd: 0,
  ceilingUsd: null,
  projectedTotalUsd: null,
  remainingEstimateUsd: null,
  unpricedAttempts: 0,
};

function liveState(runs: LiveRun[], patch: Partial<LiveState> = {}): LiveState {
  const counts = emptyCounts();
  for (const run of runs) counts[run.status] += 1;
  return {
    status: 'running',
    pauseReason: null,
    failure: null,
    counts,
    doneRuns: counts.scored,
    spend: SPEND,
    runs: new Map(runs.map((r) => [r.id, r])),
    ...patch,
  };
}

const run = (id: string, status: LiveRun['status'] = 'queued'): LiveRun => ({
  id,
  status,
  attempt: status === 'queued' ? 0 : 1,
  primaryScore: null,
  finishedAt: null,
  feed: null,
});

/** A LiveSource whose answers each test sets, counting its reads. */
class ScriptedSource implements LiveSource {
  readonly versions = new Map<string, string | Error | null>();
  readonly states = new Map<string, LiveState>();
  readonly forgotten: string[] = [];
  versionReads = 0;
  stateReads = 0;

  version(id: string): Promise<string | null> {
    this.versionReads += 1;
    const v = this.versions.get(id) ?? null;
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  }

  state(id: string): Promise<LiveState> {
    this.stateReads += 1;
    const s = this.states.get(id);
    return s ? Promise.resolve(s) : Promise.reject(new Error(`no state for ${id}`));
  }

  forget(id: string): void {
    this.forgotten.push(id);
  }
}

/** A subscriber that keeps every message, parsed. */
class RecordingSink implements SseSink {
  readonly events: ExperimentEvent[] = [];
  closed = false;

  send(type: string, json: string): void {
    const event = ExperimentEventSchema.parse(JSON.parse(json));
    expect(event.type).toBe(type);
    this.events.push(event);
  }

  close(): void {
    this.closed = true;
  }

  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

const logger = () => ({ setContext: vi.fn(), warn: vi.fn(), error: vi.fn() });

let source: ScriptedSource;
let log: ReturnType<typeof logger>;

function hub(options: Partial<ExperimentEventsOptions> = {}): ExperimentEventsHub {
  return new ExperimentEventsHub(source, log as unknown as PinoLogger, options);
}

beforeEach(() => {
  vi.useFakeTimers();
  source = new ScriptedSource();
  log = logger();
  source.versions.set('e1', 'v1');
  source.states.set('e1', liveState([run('r1'), run('r2')]));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ExperimentEventsHub', () => {
  it('shares one poller between the subscribers of an experiment', async () => {
    const h = hub();
    const a = new RecordingSink();
    const b = new RecordingSink();
    h.subscribe('e1', a);
    h.subscribe('e1', b);
    expect(h.watched).toBe(1);
    expect(h.subscribers).toBe(2);

    await vi.advanceTimersByTimeAsync(0);
    expect(source.stateReads).toBe(1);
    expect(a.types()).toEqual(['experiment', 'counts']);
    expect(b.types()).toEqual(['experiment', 'counts']);

    // Idle: one cheap version read per second, no full read.
    await vi.advanceTimersByTimeAsync(3000);
    expect(source.versionReads).toBe(4);
    expect(source.stateReads).toBe(1);
    expect(a.events).toHaveLength(2);
  });

  it('reads the full state only when the version moved, and sends the difference', async () => {
    const h = hub();
    const sink = new RecordingSink();
    h.subscribe('e1', sink);
    await vi.advanceTimersByTimeAsync(0);

    source.states.set('e1', liveState([run('r1', 'running'), run('r2')]));
    await vi.advanceTimersByTimeAsync(1000);
    // The state changed but the version did not: nothing read, nothing sent.
    expect(source.stateReads).toBe(1);
    expect(sink.events).toHaveLength(2);

    source.versions.set('e1', 'v2');
    await vi.advanceTimersByTimeAsync(1000);
    expect(source.stateReads).toBe(2);
    expect(sink.types()).toEqual(['experiment', 'counts', 'run', 'counts']);
    expect(sink.events[2]).toMatchObject({
      type: 'run',
      runId: 'r1',
      status: 'running',
      attempt: 1,
    });
  });

  it('gives a later subscriber the current state at once', async () => {
    const h = hub();
    const first = new RecordingSink();
    h.subscribe('e1', first);
    await vi.advanceTimersByTimeAsync(0);

    const late = new RecordingSink();
    h.subscribe('e1', late);
    expect(late.types()).toEqual(['experiment', 'counts']);
    expect(source.stateReads).toBe(1);
  });

  it('polls separately per experiment', async () => {
    source.versions.set('e2', 'w1');
    source.states.set(
      'e2',
      liveState([run('x1', 'running')], { status: 'paused', pauseReason: 'user' }),
    );
    const h = hub();
    const a = new RecordingSink();
    const b = new RecordingSink();
    h.subscribe('e1', a);
    h.subscribe('e2', b);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.watched).toBe(2);
    expect(a.events[0]).toMatchObject({ type: 'experiment', status: 'running' });
    expect(b.events[0]).toMatchObject({
      type: 'experiment',
      status: 'paused',
      pauseReason: 'user',
    });
  });

  it('stops polling when the last subscriber leaves', async () => {
    const h = hub();
    const a = new RecordingSink();
    const b = new RecordingSink();
    const leaveA = h.subscribe('e1', a);
    const leaveB = h.subscribe('e1', b);
    await vi.advanceTimersByTimeAsync(1000);

    leaveA();
    leaveA();
    expect(h.subscribers).toBe(1);
    expect(h.watched).toBe(1);
    leaveB();
    expect(h.watched).toBe(0);
    expect(source.forgotten).toEqual(['e1']);

    const reads = source.versionReads;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.versionReads).toBe(reads);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts a fresh poller for a subscriber that comes back', async () => {
    const h = hub();
    h.subscribe('e1', new RecordingSink())();
    const again = new RecordingSink();
    h.subscribe('e1', again);
    await vi.advanceTimersByTimeAsync(0);
    expect(again.types()).toEqual(['experiment', 'counts']);
  });

  it('answers 503 past the subscriber cap', async () => {
    const h = hub({ maxSubscribers: 2 });
    h.admit();
    const leave = h.subscribe('e1', new RecordingSink());
    h.admit();
    h.subscribe('e1', new RecordingSink());
    const refused = (() => {
      try {
        h.admit();
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(refused).toBeInstanceOf(ServiceUnavailableException);
    expect((refused as ServiceUnavailableException).getStatus()).toBe(503);
    expect((refused as ServiceUnavailableException).getResponse()).toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('Too many live connections (2)'),
    });
    leave();
    expect(() => h.admit()).not.toThrow();
  });

  it('drops an event that does not parse, and still sends the rest', async () => {
    // Paused without a reason breaks the experiment event's rule.
    source.states.set('e1', liveState([run('r1')], { status: 'paused', pauseReason: null }));
    const h = hub();
    const sink = new RecordingSink();
    h.subscribe('e1', sink);
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.types()).toEqual(['counts']);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'experiment' }),
      'dropped an invalid experiment event',
    );
  });

  it('keeps the stream open through a failed poll and tries again', async () => {
    source.versions.set('e1', new Error('connection refused'));
    const h = hub();
    const sink = new RecordingSink();
    h.subscribe('e1', sink);
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(sink.events).toEqual([]);
    expect(sink.closed).toBe(false);

    source.versions.set('e1', 'v1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(sink.types()).toEqual(['experiment', 'counts']);
  });

  it('never overlaps two reads of one experiment', async () => {
    let release: (v: string) => void = () => {};
    const slow = vi.spyOn(source, 'version').mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const h = hub();
    h.subscribe('e1', new RecordingSink());
    await vi.advanceTimersByTimeAsync(5000);
    expect(slow).toHaveBeenCalledTimes(1);
    slow.mockRestore();
    release('v1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(source.versionReads).toBe(1);
  });

  it('ends the streams of an experiment whose row vanished', async () => {
    source.versions.set('e1', null);
    const h = hub();
    const sink = new RecordingSink();
    h.subscribe('e1', sink);
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.closed).toBe(true);
  });

  it('closes every stream and stops every poller on shutdown', async () => {
    const h = hub();
    const sink = new RecordingSink();
    h.subscribe('e1', sink);
    await vi.advanceTimersByTimeAsync(0);
    h.onModuleDestroy();
    expect(sink.closed).toBe(true);
    expect(h.watched).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('knows whether an experiment exists', async () => {
    const h = hub();
    await expect(h.exists('e1')).resolves.toBe(true);
    await expect(h.exists('nope')).resolves.toBe(false);
  });
});
