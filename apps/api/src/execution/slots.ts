/**
 * Trial slots (E9, plan 8.2): the internal networks a trial has to itself.
 * Two trials on one slot network could reach each other, so a slot holds one
 * live trial at a time.
 *
 * One worker per Docker daemon is the supported setup, and that worker hands
 * its TRIAL_SLOTS out in-process. Before a slot is handed out the pool also
 * asks the engine (through docker-guard) whether any live trial container
 * sits on that network: one left by an earlier process of this worker that
 * recovery has not stopped yet, or one of another worker sharing the daemon
 * with an overlapping slot list (a misconfiguration; such workers need
 * disjoint TRIAL_SLOTS). A slot that is busy in the engine is skipped, not
 * waited for.
 *
 * Containers with network `none` (MCP tests, the toolset listing) take no
 * slot. A container counts as live from `created` on, because a created
 * container joins its network the moment it starts.
 */
import type { ContainerSummary } from '../sandbox/engine-client.js';

/**
 * How many execute-run jobs the worker takes at once: WORKER_CONCURRENCY, at
 * most one per trial slot. Each trial needs a slot to itself, so a job taken
 * beyond the slots could only be deferred, again and again, while it holds
 * the worker's attention. At least 1, so a worker whose slots are all
 * missing still takes (and defers) a job instead of refusing to start. The
 * System page shows the same number for each worker row (system/views.ts).
 */
export function trialConcurrency(concurrency: number, slotCount: number): number {
  return Math.max(1, Math.min(concurrency, slotCount));
}

/** The part of EngineClient the pool needs. */
export interface SlotEngine {
  list(labels: string[]): Promise<ContainerSummary[]>;
}

/** Container states in which a trial no longer uses its network. */
const STOPPED_STATES = new Set(['exited', 'dead']);

/** Whether a listed trial container may still be on its network. */
export const isLiveContainer = (container: ContainerSummary): boolean =>
  !STOPPED_STATES.has(container.State);

export class SlotPool {
  private readonly inUse = new Set<string>();

  constructor(
    private readonly slots: readonly string[],
    private readonly engine: SlotEngine,
  ) {
    if (new Set(slots).size !== slots.length) {
      throw new Error(`TRIAL_SLOTS lists a slot twice: ${slots.join(', ')}`);
    }
  }

  /** How many slots this worker has. */
  get size(): number {
    return this.slots.length;
  }

  /** Slots handed out and not yet released. */
  get busy(): number {
    return this.inUse.size;
  }

  /**
   * A slot no trial of this process holds and the engine shows no live
   * trial container on, now marked in use; null when there is none. Throws
   * when the engine cannot be asked (docker-guard down): no slot can be
   * confirmed free then, and no trial could start anyway.
   */
  async acquire(): Promise<string | null> {
    if (this.inUse.size >= this.slots.length) return null;
    const live = (await this.engine.list(['hermes-evals.role=trial'])).filter(isLiveContainer);
    const occupied = new Set(live.map((container) => container.HostConfig?.NetworkMode));
    // Chosen and marked in one synchronous step after the await, so two
    // concurrent acquires in this process never take the same slot.
    const slot = this.slots.find((s) => !this.inUse.has(s) && !occupied.has(s)) ?? null;
    if (slot) this.inUse.add(slot);
    return slot;
  }

  /** Returns a slot once its trial container has been removed. Releasing a free slot does nothing. */
  release(slot: string): void {
    this.inUse.delete(slot);
  }
}

/**
 * The pool as a slot source for anything else that needs a slot network
 * for a while (an http MCP test, test-mcp-server.ts), so tests and trials
 * never share one. Answers at once: a slot, or a throw when every slot is
 * busy or the engine cannot be asked. Release hands the slot back.
 */
export function slotLeaseSource(
  pool: SlotPool,
): () => Promise<{ slot: string; release: () => void }> {
  return async () => {
    const slot = await pool.acquire();
    if (!slot) {
      throw new Error('every trial slot is running a trial; test again when a run finishes');
    }
    let released = false;
    return {
      slot,
      release: () => {
        if (released) return;
        released = true;
        pool.release(slot);
      },
    };
  };
}
