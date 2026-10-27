/**
 * What this API start's samples seed did, for GET /system/setup and the log
 * (Phase 8 G3). Held in memory: the seed runs again at every start, and
 * finds what an earlier one made, so there is nothing to keep across
 * restarts.
 */
import { Injectable } from '@nestjs/common';
import type { SeedItem, SeedReport, SeedState } from '@hermes-evals/shared';

@Injectable()
export class SeedReporter {
  private state: SeedState = 'off';
  private startedAt: Date | null = null;
  private finishedAt: Date | null = null;
  private items: SeedItem[] = [];
  private error: string | null = null;

  /** A new seed: `running`, nothing met yet. */
  start(now = new Date()): void {
    this.state = 'running';
    this.startedAt = now;
    this.finishedAt = null;
    this.items = [];
    this.error = null;
  }

  add(item: SeedItem): void {
    this.items.push(item);
  }

  /** It went through every sample; some items may have failed. */
  finish(now = new Date()): void {
    this.state = 'done';
    this.finishedAt = now;
  }

  /** It stopped before the end, for `error`; the items so far stay. */
  fail(error: string, now = new Date()): void {
    this.state = 'failed';
    this.startedAt ??= now;
    this.finishedAt = now;
    this.error = error;
  }

  report(): SeedReport {
    return {
      state: this.state,
      startedAt: this.startedAt?.toISOString() ?? null,
      finishedAt: this.finishedAt?.toISOString() ?? null,
      items: [...this.items],
      error: this.error,
    };
  }
}
