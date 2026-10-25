/**
 * One server-sent events connection, written by hand on the raw response
 * rather than through Nest's @Sse: the streams here need a 404 or 503 before
 * the stream opens, a keepalive comment while nothing happens, and to drop a
 * client that stops reading.
 *
 * Wire format (shared contracts/events.ts): one message per event,
 * `event: <type>` and `data: <the whole event as JSON>`, then a blank line.
 * Comment lines (`: ...`) keep proxies and the browser from timing the
 * connection out; EventSource ignores them.
 *
 * A client that stops reading is dropped: past MAX_BUFFERED_BYTES unsent,
 * the response is destroyed, which destroys its socket and frees what it
 * buffered. Ending it would not: end() on a backed-up stream waits for the
 * peer to read, so the socket and its buffer would outlive the hub's count,
 * and a client that kept doing it would get round the subscriber cap. A
 * graceful close (the experiment is gone, the module stops) still ends it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** A comment line goes out this often, so idle connections stay open through proxies. */
export const KEEPALIVE_MS = 15_000;

/**
 * Unsent bytes a connection may hold. A client that stops reading is closed
 * past this; when it reconnects it refetches, so nothing is lost.
 */
export const MAX_BUFFERED_BYTES = 1024 * 1024;

/** What a hub writes to: one subscriber's connection. */
export interface SseSink {
  /** Writes one message. `json` is the whole event, already validated and serialised. */
  send(type: string, json: string): void;
  /** Ends the connection (idempotent). */
  close(): void;
  readonly closed: boolean;
}

export class SseConnection implements SseSink {
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private onClose: (() => void) | null = null;
  #closed = false;

  private constructor(private readonly res: ServerResponse) {}

  /**
   * Answers 200 with the event-stream headers and starts the keepalive.
   * `X-Accel-Buffering: no` stops nginx (the web container) from buffering
   * the stream. The connection closes itself when the client goes away.
   */
  static open(req: IncomingMessage, res: ServerResponse): SseConnection {
    const connection = new SseConnection(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    // An immediate first line, so the client's `open` fires before the first event.
    res.write(': open\n\n');
    connection.keepalive = setInterval(() => connection.comment('keepalive'), KEEPALIVE_MS);
    const end = () => connection.close();
    req.once('close', end);
    res.once('close', end);
    res.once('error', end);
    return connection;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Runs `fn` once when the connection closes, whoever closes it. */
  whenClosed(fn: () => void): void {
    if (this.#closed) fn();
    else this.onClose = fn;
  }

  send(type: string, json: string): void {
    this.write(`event: ${type}\ndata: ${json}\n\n`);
  }

  comment(text: string): void {
    this.write(`: ${text}\n\n`);
  }

  /** Ends the connection; `drop` destroys it at once instead (a client that stopped reading). */
  close(options: { drop?: boolean } = {}): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.keepalive !== null) clearInterval(this.keepalive);
    this.keepalive = null;
    if (options.drop) this.res.destroy();
    else if (!this.res.writableEnded) this.res.end();
    const fn = this.onClose;
    this.onClose = null;
    fn?.();
  }

  private write(chunk: string): void {
    if (this.#closed) return;
    if (this.res.writableLength > MAX_BUFFERED_BYTES) {
      this.close({ drop: true });
      return;
    }
    this.res.write(chunk);
  }
}
