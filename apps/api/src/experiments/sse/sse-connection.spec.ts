/**
 * One SSE connection on a stand-in response: the headers, the wire format,
 * the keepalive comment every 15 s (fake timers), closing when the client
 * goes away, and dropping a client that stopped reading.
 */
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KEEPALIVE_MS, MAX_BUFFERED_BYTES, SseConnection } from './sse-connection.js';

/** The parts of ServerResponse the connection uses. */
class FakeResponse extends EventEmitter {
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  writableLength = 0;
  writableEnded = false;
  flushed = false;

  writeHead(status: number, headers: Record<string, string>): this {
    this.status = status;
    this.headers = headers;
    return this;
  }

  flushHeaders(): void {
    this.flushed = true;
  }

  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }

  destroyed = false;

  end(): this {
    this.writableEnded = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }

  text(): string {
    return this.chunks.join('');
  }
}

let req: EventEmitter;
let res: FakeResponse;

const open = () => SseConnection.open(req as IncomingMessage, res as unknown as ServerResponse);

beforeEach(() => {
  vi.useFakeTimers();
  req = new EventEmitter();
  res = new FakeResponse();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SseConnection', () => {
  it('answers 200 with unbuffered event-stream headers and a first comment', () => {
    open();
    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    expect(res.flushed).toBe(true);
    expect(res.text()).toBe(': open\n\n');
  });

  it('writes each event as its type and its JSON', () => {
    const c = open();
    c.send('counts', '{"type":"counts"}');
    expect(res.chunks.at(-1)).toBe('event: counts\ndata: {"type":"counts"}\n\n');
  });

  it('sends a keepalive comment every 15 s and stops when closed', () => {
    const c = open();
    vi.advanceTimersByTime(KEEPALIVE_MS - 1);
    expect(res.chunks).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(res.chunks.at(-1)).toBe(': keepalive\n\n');
    vi.advanceTimersByTime(KEEPALIVE_MS);
    expect(res.chunks.filter((x) => x === ': keepalive\n\n')).toHaveLength(2);

    c.close();
    expect(res.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    c.send('counts', '{}');
    expect(res.chunks).toHaveLength(3);
  });

  it('closes once, and runs its close callback, when the client goes away', () => {
    const c = open();
    const onClose = vi.fn();
    c.whenClosed(onClose);
    req.emit('close');
    res.emit('close');
    expect(c.closed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs a close callback at once on a connection already closed', () => {
    const c = open();
    c.close();
    const onClose = vi.fn();
    c.whenClosed(onClose);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('drops a client that stopped reading', () => {
    const c = open();
    const onClose = vi.fn();
    c.whenClosed(onClose);
    res.writableLength = MAX_BUFFERED_BYTES + 1;
    c.send('run', '{}');
    expect(c.closed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(res.chunks).toEqual([': open\n\n']);
    // Destroyed, not ended: end() would wait on a peer that is not reading.
    expect(res.destroyed).toBe(true);
    expect(res.writableEnded).toBe(false);
  });

  it('ends a graceful close rather than destroying it', () => {
    const c = open();
    c.close();
    expect(res.writableEnded).toBe(true);
    expect(res.destroyed).toBe(false);
  });
});

describe('SseConnection on a real socket', () => {
  let server: http.Server;
  let client: Socket | null = null;

  afterEach(async () => {
    client?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('frees the socket of a client that never reads once the buffer cap is passed', async () => {
    let connection: SseConnection | null = null;
    let request: IncomingMessage | null = null;
    server = http.createServer((req, res) => {
      request = req;
      connection = SseConnection.open(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    // A client that sends its request and then never reads a byte.
    client = connect(port, '127.0.0.1');
    client.pause();
    client.write('GET /events HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await vi.waitFor(() => expect(connection).not.toBeNull(), { timeout: 5_000 });
    const c = connection!;
    const event = JSON.stringify({ type: 'counts', pad: 'x'.repeat(64 * 1024) });
    // Fill the kernel buffers and then the response's own, until the cap drops it.
    await vi.waitFor(
      () => {
        for (let i = 0; i < 64 && !c.closed; i += 1) c.send('counts', event);
        expect(c.closed).toBe(true);
      },
      { timeout: 10_000, interval: 10 },
    );
    expect(request!.socket.destroyed).toBe(true);
    await vi.waitFor(
      async () => {
        const open = await new Promise<number>((resolve, reject) =>
          server.getConnections((err, n) => (err ? reject(err) : resolve(n))),
        );
        expect(open).toBe(0);
      },
      { timeout: 5_000 },
    );
  });
});
