/**
 * GET /system/events (plan 11, E6): the running summary and worker presence
 * that every page's app shell shows, pushed instead of polled. One shared
 * poller reads SystemService.summary() every 5 s and fans the same event out
 * to every open stream; it starts with the first subscriber and stops with
 * the last, so the API reads nothing while no tab is open. Ticks never
 * overlap: the next is scheduled when one finishes.
 *
 * A new subscriber gets the newest summary at once (at most one period old,
 * its `at` says when it was read), then each tick's. Every event is
 * validated with SystemEventSchema before it is written.
 */
import {
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SystemEventSchema, type SystemSummary } from '@hermes-evals/shared';
import { PinoLogger } from 'nestjs-pino';
import type { SseSink } from '../../experiments/sse/sse-connection.js';
import { SystemService } from '../system.service.js';

export interface SystemEventsOptions {
  /** How often the shared poller reads the summary. */
  pollMs: number;
  /** Open /system/events streams allowed at once; past it, 503. */
  maxSubscribers: number;
}

export const SYSTEM_EVENTS_DEFAULTS: SystemEventsOptions = {
  pollMs: 5000,
  // Every open tab holds one (the app shell's live pill).
  maxSubscribers: 64,
};

/** Injection token for overriding SYSTEM_EVENTS_DEFAULTS (tests). */
export const SYSTEM_EVENTS_OPTIONS = Symbol('SYSTEM_EVENTS_OPTIONS');

/** What the poller reads: SystemService in the app, a fake in tests. */
export type SummarySource = Pick<SystemService, 'summary'>;

@Injectable()
export class SystemEventsHub implements OnModuleDestroy {
  private readonly sinks = new Set<SseSink>();
  private readonly options: SystemEventsOptions;
  /** The newest validated event as JSON, for a subscriber that joins between ticks. */
  private latest: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** A read is in flight. */
  private ticking = false;
  /** Bumped on every start and stop, so a tick that outlived its poller writes nothing. */
  private generation = 0;

  constructor(
    @Inject(SystemService) private readonly source: SummarySource,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
    @Optional() @Inject(SYSTEM_EVENTS_OPTIONS) options?: Partial<SystemEventsOptions>,
  ) {
    this.logger.setContext(SystemEventsHub.name);
    this.options = { ...SYSTEM_EVENTS_DEFAULTS, ...options };
  }

  get subscribers(): number {
    return this.sinks.size;
  }

  /** Whether the shared poller is running. */
  get polling(): boolean {
    return this.timer !== null || this.ticking;
  }

  /** Throws 503 when another stream would pass the cap. Call it right before subscribe. */
  admit(): void {
    if (this.sinks.size >= this.options.maxSubscribers) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        message: `Too many live connections (${this.options.maxSubscribers}). Close another tab of the app and retry.`,
      });
    }
  }

  /**
   * Adds a subscriber. The first one starts the poller, which reads at once;
   * a later one gets the newest summary now. Returns the unsubscribe
   * function; the last one out stops the poller.
   */
  subscribe(sink: SseSink): () => void {
    this.sinks.add(sink);
    if (this.sinks.size === 1) {
      this.generation += 1;
      this.latest = null;
      this.schedule(0, this.generation);
    } else if (this.latest !== null) {
      sink.send('summary', this.latest);
    }
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.sinks.delete(sink);
      if (this.sinks.size === 0) this.stop();
    };
  }

  onModuleDestroy(): void {
    const sinks = [...this.sinks];
    this.sinks.clear();
    this.stop();
    for (const sink of sinks) sink.close();
  }

  private stop(): void {
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.latest = null;
  }

  private schedule(ms: number, generation: number): void {
    this.timer = setTimeout(() => void this.tick(generation), ms);
  }

  private async tick(generation: number): Promise<void> {
    this.timer = null;
    this.ticking = true;
    const started = Date.now();
    try {
      const summary = await this.source.summary();
      if (generation !== this.generation) return;
      this.publish(summary);
    } catch (err) {
      // Postgres away: keep the streams open and try again on the next tick.
      this.logger.warn({ err }, 'system events poll failed');
    } finally {
      this.ticking = false;
      if (generation === this.generation) {
        this.schedule(Math.max(0, this.options.pollMs - (Date.now() - started)), generation);
      }
    }
  }

  private publish(summary: SystemSummary): void {
    const parsed = SystemEventSchema.safeParse({
      type: 'summary',
      at: new Date().toISOString(),
      summary,
    });
    if (!parsed.success) {
      this.logger.error({ issues: parsed.error.issues }, 'dropped an invalid system event');
      return;
    }
    this.latest = JSON.stringify(parsed.data);
    for (const sink of this.sinks) sink.send('summary', this.latest);
  }
}
