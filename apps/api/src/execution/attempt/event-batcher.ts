/**
 * Writes an attempt's streamed events to the sink (plan 8.3): in the order
 * they arrived, in batches of up to 50, and at least every 500 ms while any
 * wait, one write at a time so the sink numbers them in that order. A
 * backlog drains in statements of up to 500, so a burst does not keep
 * events waiting behind 50-row inserts. Nothing is dropped while the sink
 * accepts writes and the queue has room: events that arrive during a write
 * queue for the next one, and close() writes whatever is left.
 *
 * A write that fails with anything but a lost lease is tried again, the
 * same batch at the same seq numbers, with backoff. That is safe: the sink
 * advances its counter only after a commit, and a batch whose commit reply
 * was lost is recognised by its primary key (FencedAttemptSink). So a
 * database blip of a few seconds loses nothing and stops no trial. Batching
 * ends, reported once through `onFailure` (the runner then stops the trial)
 * and rethrown by close(), on a LeaseLostError (another owner decides what
 * happens to the attempt) or once writes have failed for `failAfterMs`
 * without a break, short of the lease running out.
 *
 * The queue is bounded. Past `maxQueued` events push() drops the event,
 * counts it in `dropped`, and reports the first drop through `onOverflow`,
 * so the runner stops the trial rather than let the worker's memory grow.
 * The runner's stdout line cap keeps a working trial far below it.
 */
import { LeaseLostError, type AttemptEventInput, type AttemptSink } from '../contracts.js';

export interface EventBatcherOptions {
  /** Events per write; a full batch is written at once. Default 50. */
  maxBatch?: number;
  /** Longest an event waits before a write starts. Default 500 ms. */
  intervalMs?: number;
  /** Called once with the error that ended batching. */
  onFailure?: (err: unknown) => void;
  /** Events the queue holds at most; more are dropped. Default 25,000. */
  maxQueued?: number;
  /** Called once, with the queue length, when the first event is dropped. */
  onOverflow?: (queued: number) => void;
  /** How long writes may keep failing before batching gives up. Default 45 s. */
  failAfterMs?: number;
  /** Waits between tries of a failed write; the last one repeats. */
  retryDelaysMs?: readonly number[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Batch size for a backlog and for close(), so a long queue takes few statements. */
const BACKLOG_BATCH = 500;
/** The consumed head of the queue is cut off once it is this long and at least half of it. */
const COMPACT_AFTER = 4096;
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000];
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class EventBatcher {
  /** Events from `head` on are still to be written; the rest were written. */
  private queue: AttemptEventInput[] = [];
  private head = 0;
  private readonly maxBatch: number;
  private readonly intervalMs: number;
  private readonly maxQueued: number;
  private readonly failAfterMs: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private timer: NodeJS.Timeout | undefined;
  private writing: Promise<void> | null = null;
  private failure: { error: unknown } | null = null;
  private closed = false;
  /** Events the sink accepted. */
  written = 0;
  /** Events dropped because the queue was full. */
  dropped = 0;
  /** Called once with the error that ended batching; may be set after construction. */
  onFailure: ((err: unknown) => void) | undefined;
  /** Called once when the first event is dropped; may be set after construction. */
  onOverflow: ((queued: number) => void) | undefined;

  constructor(
    private readonly sink: Pick<AttemptSink, 'appendEvents'>,
    options: EventBatcherOptions = {},
  ) {
    this.maxBatch = options.maxBatch ?? 50;
    this.intervalMs = options.intervalMs ?? 500;
    this.maxQueued = options.maxQueued ?? 25_000;
    this.failAfterMs = options.failAfterMs ?? 45_000;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.onFailure = options.onFailure;
    this.onOverflow = options.onOverflow;
  }

  get failed(): boolean {
    return this.failure !== null;
  }

  /** Events queued and not yet written. */
  get pending(): number {
    return this.queue.length - this.head;
  }

  push(event: AttemptEventInput): void {
    if (this.failure) return;
    if (this.pending >= this.maxQueued) {
      this.dropped += 1;
      if (this.dropped === 1) this.onOverflow?.(this.pending);
      return;
    }
    this.queue.push(event);
    if (this.closed) return;
    if (this.pending >= this.maxBatch) this.kick();
    else this.timer ??= setTimeout(() => this.kick(true), this.intervalMs);
  }

  /** Writes everything still queued and stops. Throws the error that ended batching, if any. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.writing;
    while (!this.failure && this.pending > 0) await this.writeNext(BACKLOG_BATCH);
    if (this.failure) throw this.failure.error;
  }

  /** Starts writing unless a write is running; `due` when the interval passed (write even a short batch). */
  private kick(due = false): void {
    if (due) this.timer = undefined;
    if (this.writing || this.failure || this.closed) return;
    this.writing = this.drain(due).finally(() => {
      this.writing = null;
      // Events that arrived during the last write wait for the interval, or a full batch.
      if (!this.failure && !this.closed && this.pending > 0) {
        if (this.pending >= this.maxBatch) this.kick();
        else this.timer ??= setTimeout(() => this.kick(true), this.intervalMs);
      }
    });
  }

  private async drain(due: boolean): Promise<void> {
    let all = due;
    while (!this.failure && (this.pending >= this.maxBatch || (all && this.pending > 0))) {
      await this.writeNext(this.pending >= BACKLOG_BATCH ? BACKLOG_BATCH : this.maxBatch);
      all = false;
    }
  }

  /**
   * Writes the next `size` events, trying the same batch again after a
   * transient failure; returns once it is written or batching has failed.
   */
  private async writeNext(size: number): Promise<void> {
    const batch = this.queue.slice(this.head, this.head + size);
    let failingSince: number | null = null;
    for (let tries = 0; ; tries += 1) {
      try {
        await this.sink.appendEvents(batch);
        this.head += batch.length;
        this.written += batch.length;
        this.compact();
        return;
      } catch (error) {
        failingSince ??= this.now();
        if (error instanceof LeaseLostError || this.now() - failingSince >= this.failAfterMs) {
          this.fail(error);
          return;
        }
        const delays = this.retryDelaysMs;
        await this.sleep(delays[Math.min(tries, delays.length - 1)] ?? 1_000);
      }
    }
  }

  /** Drops the written head once it is long, so draining stays linear in what is written. */
  private compact(): void {
    if (this.head >= COMPACT_AFTER && this.head * 2 >= this.queue.length) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }
  }

  private fail(error: unknown): void {
    this.failure = { error };
    this.queue = [];
    this.head = 0;
    clearTimeout(this.timer);
    this.onFailure?.(error);
  }
}
