/**
 * GET /experiments/:id/events (plan 11, E6): one shared poller per watched
 * experiment, reading Postgres every second, fanning its events out to every
 * subscriber of that experiment. A poller starts with its first subscriber
 * and stops when the last one leaves, so an experiment nobody watches costs
 * nothing. Ticks never overlap: the next is scheduled when one finishes.
 *
 * Every event is validated with ExperimentEventSchema before it is written;
 * one that does not parse is logged and dropped, never sent half-right.
 */
import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ExperimentEventSchema, type ExperimentEvent } from '@hermes-evals/shared';
import { PinoLogger } from 'nestjs-pino';
import type { SseSink } from './sse-connection.js';
import { diffEvents, initialEvents, type LiveState } from './experiment-diff.js';
import { LIVE_SOURCE, type LiveSource } from './live-source.js';

export interface ExperimentEventsOptions {
  /** How often each poller reads Postgres. */
  pollMs: number;
  /** Open experiment streams allowed at once, across experiments; past it, 503. */
  maxSubscribers: number;
}

export const EXPERIMENT_EVENTS_DEFAULTS: ExperimentEventsOptions = {
  pollMs: 1000,
  maxSubscribers: 64,
};

/** Injection token for overriding EXPERIMENT_EVENTS_DEFAULTS (tests). */
export const EXPERIMENT_EVENTS_OPTIONS = Symbol('EXPERIMENT_EVENTS_OPTIONS');

type Log = Pick<PinoLogger, 'warn' | 'error'>;

/** Validates and serialises events once, then writes them to each sink. */
export function writeEvents(
  events: readonly ExperimentEvent[],
  sinks: Iterable<SseSink>,
  log: Log,
): void {
  const messages: [string, string][] = [];
  for (const event of events) {
    const parsed = ExperimentEventSchema.safeParse(event);
    if (!parsed.success) {
      log.error(
        { type: event.type, issues: parsed.error.issues },
        'dropped an invalid experiment event',
      );
      continue;
    }
    messages.push([parsed.data.type, JSON.stringify(parsed.data)]);
  }
  if (messages.length === 0) return;
  for (const sink of sinks) {
    for (const [type, json] of messages) sink.send(type, json);
  }
}

/** The poller of one experiment. */
class ExperimentPoller {
  /** Subscribers that have had their initial events. */
  private readonly primed = new Set<SseSink>();
  /** Subscribers waiting for the first read. */
  private readonly waiting = new Set<SseSink>();
  private version: string | null = null;
  private state: LiveState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly experimentId: string,
    private readonly source: LiveSource,
    private readonly pollMs: number,
    private readonly log: Log,
  ) {}

  get size(): number {
    return this.primed.size + this.waiting.size;
  }

  start(): void {
    this.schedule(0);
  }

  add(sink: SseSink): void {
    if (this.state === null) {
      this.waiting.add(sink);
      return;
    }
    writeEvents(initialEvents(this.state, new Date().toISOString()), [sink], this.log);
    this.primed.add(sink);
  }

  remove(sink: SseSink): void {
    this.primed.delete(sink);
    this.waiting.delete(sink);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Every subscriber, for shutdown. */
  sinks(): SseSink[] {
    return [...this.primed, ...this.waiting];
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    this.timer = null;
    try {
      const version = await this.source.version(this.experimentId);
      if (this.stopped) return;
      if (version === null) {
        // Experiments are never deleted; a vanished row means the database was swapped. End the streams.
        for (const sink of this.sinks()) sink.close();
        return;
      }
      if (this.state === null || version !== this.version) {
        const next = await this.source.state(this.experimentId);
        if (this.stopped) return;
        const at = new Date().toISOString();
        if (this.state !== null)
          writeEvents(diffEvents(this.state, next, at), this.primed, this.log);
        this.state = next;
        this.version = version;
      }
      if (this.waiting.size > 0) {
        const sinks = [...this.waiting];
        this.waiting.clear();
        writeEvents(initialEvents(this.state, new Date().toISOString()), sinks, this.log);
        for (const sink of sinks) this.primed.add(sink);
      }
    } catch (err) {
      // Postgres away or a bad row: keep the streams open and try again on the next tick.
      this.log.warn({ err, experimentId: this.experimentId }, 'experiment events poll failed');
    } finally {
      this.schedule(this.pollMs);
    }
  }
}

@Injectable()
export class ExperimentEventsHub implements OnModuleDestroy {
  private readonly pollers = new Map<string, ExperimentPoller>();
  private readonly options: ExperimentEventsOptions;

  constructor(
    @Inject(LIVE_SOURCE) private readonly source: LiveSource,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Optional() @Inject(EXPERIMENT_EVENTS_OPTIONS) options?: Partial<ExperimentEventsOptions>,
  ) {
    this.logger.setContext(ExperimentEventsHub.name);
    this.options = { ...EXPERIMENT_EVENTS_DEFAULTS, ...options };
  }

  /** Open streams across every experiment. */
  get subscribers(): number {
    let n = 0;
    for (const poller of this.pollers.values()) n += poller.size;
    return n;
  }

  /** Experiments being polled now. */
  get watched(): number {
    return this.pollers.size;
  }

  /** Whether the experiment exists (the controller answers 404 before opening a stream). */
  async exists(experimentId: string): Promise<boolean> {
    return (await this.source.version(experimentId)) !== null;
  }

  /** Throws 503 when another stream would pass the cap. Call it right before subscribe. */
  admit(): void {
    if (this.subscribers >= this.options.maxSubscribers) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: `Too many live connections (${this.options.maxSubscribers}). Close another tab watching an experiment and retry.`,
      });
    }
  }

  /**
   * Adds a subscriber to the experiment's poller, starting it if it is the
   * first. Returns the unsubscribe function; the last one out stops the poller.
   */
  subscribe(experimentId: string, sink: SseSink): () => void {
    let poller = this.pollers.get(experimentId);
    if (!poller) {
      poller = new ExperimentPoller(experimentId, this.source, this.options.pollMs, this.logger);
      this.pollers.set(experimentId, poller);
      poller.start();
    }
    poller.add(sink);
    const owner = poller;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      owner.remove(sink);
      if (owner.size === 0 && this.pollers.get(experimentId) === owner) {
        owner.stop();
        this.pollers.delete(experimentId);
        this.source.forget?.(experimentId);
      }
    };
  }

  onModuleDestroy(): void {
    for (const [id, poller] of this.pollers) {
      poller.stop();
      for (const sink of poller.sinks()) sink.close();
      this.source.forget?.(id);
    }
    this.pollers.clear();
  }
}
