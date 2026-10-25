/**
 * The trial slot pool (E9): slots handed out in-process, never one the
 * engine shows a live trial on, and never the same one twice at once.
 */
import { describe, expect, it } from 'vitest';
import type { ContainerSummary } from '../sandbox/engine-client.js';
import { isLiveContainer, SlotPool, slotLeaseSource, type SlotEngine } from './slots.js';

const SLOTS = ['trial-0', 'trial-1', 'trial-2'];

/** An engine listing the given trial containers. */
const engineWith = (
  containers: Array<{ network: string; state: string }>,
): SlotEngine & { lists: number } => {
  const engine = {
    lists: 0,
    list(labels: string[]): Promise<ContainerSummary[]> {
      engine.lists += 1;
      expect(labels).toEqual(['hermes-evals.role=trial']);
      return Promise.resolve(
        containers.map((c, i) => ({
          Id: `c${i}`,
          Names: [`/c${i}`],
          Labels: { 'hermes-evals.role': 'trial' },
          State: c.state,
          HostConfig: { NetworkMode: c.network },
        })),
      );
    },
  };
  return engine;
};

describe('SlotPool', () => {
  it('hands out each slot once until it is released', async () => {
    const pool = new SlotPool(SLOTS, engineWith([]));
    expect(await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()])).toEqual(SLOTS);
    expect(pool.busy).toBe(3);
    expect(await pool.acquire()).toBeNull();
    pool.release('trial-1');
    pool.release('trial-1');
    expect(await pool.acquire()).toBe('trial-1');
  });

  it('skips a slot the engine shows a live trial on, from created on', async () => {
    const pool = new SlotPool(
      SLOTS,
      engineWith([
        { network: 'trial-0', state: 'running' },
        { network: 'trial-1', state: 'created' },
        { network: 'trial-2', state: 'exited' },
      ]),
    );
    expect(await pool.acquire()).toBe('trial-2');
    expect(await pool.acquire()).toBeNull();
  });

  it('does not ask the engine when every slot is taken in-process', async () => {
    const engine = engineWith([]);
    const pool = new SlotPool(['only'], engine);
    await pool.acquire();
    const before = engine.lists;
    expect(await pool.acquire()).toBeNull();
    expect(engine.lists).toBe(before);
    expect(pool.size).toBe(1);
  });

  it('throws when the engine cannot be asked, and refuses a slot listed twice', async () => {
    const pool = new SlotPool(SLOTS, { list: () => Promise.reject(new Error('guard down')) });
    await expect(pool.acquire()).rejects.toThrow('guard down');
    expect(pool.busy).toBe(0);
    expect(() => new SlotPool(['a', 'a'], engineWith([]))).toThrow(/twice/);
  });

  it('counts only exited and dead containers as off their network', () => {
    const summary = (State: string): ContainerSummary => ({
      Id: 'x',
      Names: [],
      Labels: {},
      State,
    });
    expect(
      ['created', 'running', 'paused', 'restarting', 'removing'].map((s) =>
        isLiveContainer(summary(s)),
      ),
    ).toEqual([true, true, true, true, true]);
    expect(isLiveContainer(summary('exited'))).toBe(false);
    expect(isLiveContainer(summary('dead'))).toBe(false);
  });
});

describe('slotLeaseSource', () => {
  it('lends a slot of the pool, refuses at once when all are busy, and releases once', async () => {
    const pool = new SlotPool(['trial-0'], engineWith([]));
    const lease = slotLeaseSource(pool);
    const first = await lease();
    expect(first.slot).toBe('trial-0');
    expect(pool.busy).toBe(1);
    await expect(lease()).rejects.toThrow(/every trial slot/);
    first.release();
    first.release();
    expect(pool.busy).toBe(0);
    const again = await lease();
    expect(again.slot).toBe('trial-0');
    // A second release of the first lease must not free the slot the new lease holds.
    first.release();
    expect(pool.busy).toBe(1);
  });
});
