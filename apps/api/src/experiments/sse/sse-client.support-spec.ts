/**
 * A minimal server-sent events client for the HTTP specs: opens a GET on a
 * listening server, parses messages as they arrive, and waits for the ones
 * a test expects. Test-only (the `support-spec` suffix keeps it out of the
 * build and out of the test run).
 */
import { request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

export interface SseMessage {
  event: string;
  data: string;
}

export interface SseStream {
  status: number;
  headers: IncomingMessage['headers'];
  messages: SseMessage[];
  /** Comment lines (`: ...`) seen so far, without the colon. */
  comments: string[];
  /** Resolves when `predicate` holds for the messages so far; rejects after `ms`. */
  until(predicate: (messages: SseMessage[]) => boolean, ms?: number): Promise<SseMessage[]>;
  /** Hangs up, as a closed browser tab does. */
  close(): void;
}

/** The body of a response that is not a stream (a 404 or 503 before the stream opened). */
export interface PlainResponse {
  status: number;
  headers: IncomingMessage['headers'];
  body: string;
}

const urlOf = (server: Server, path: string): URL => {
  const { port } = server.address() as AddressInfo;
  return new URL(path, `http://127.0.0.1:${port}`);
};

/**
 * GETs `path`. A text/event-stream answer becomes an SseStream; anything
 * else is read to the end and returned as a PlainResponse.
 */
export function openSse(server: Server, path: string): Promise<SseStream | PlainResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      urlOf(server, path),
      { headers: { Accept: 'text/event-stream' } },
      (res) => {
        res.setEncoding('utf8');
        const type = res.headers['content-type'] ?? '';
        if (!type.startsWith('text/event-stream')) {
          let body = '';
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
          return;
        }
        const messages: SseMessage[] = [];
        const comments: string[] = [];
        const waiters = new Set<() => void>();
        let buffer = '';
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let end = buffer.indexOf('\n\n');
          while (end >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let event = 'message';
            const data: string[] = [];
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) comments.push(line.slice(1).trim());
              else if (line.startsWith('event: ')) event = line.slice('event: '.length);
              else if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
            }
            if (data.length > 0) messages.push({ event, data: data.join('\n') });
            end = buffer.indexOf('\n\n');
          }
          for (const wake of waiters) wake();
        });
        res.on('error', () => {});
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          messages,
          comments,
          until(predicate, ms = 5000) {
            return new Promise((done, fail) => {
              const check = () => {
                if (!predicate(messages)) return;
                clearTimeout(timer);
                waiters.delete(check);
                done(messages);
              };
              const timer = setTimeout(() => {
                waiters.delete(check);
                fail(new Error(`timed out; got ${messages.map((m) => m.event).join(', ')}`));
              }, ms);
              waiters.add(check);
              check();
            });
          },
          close() {
            req.destroy();
          },
        });
      },
    );
    req.on('error', (err) => {
      if (!req.destroyed) reject(err);
    });
    req.end();
  });
}

export const isStream = (r: SseStream | PlainResponse): r is SseStream => 'messages' in r;

/** Resolves once `check` holds, polling every 10 ms; rejects after `ms`. */
export async function eventually(check: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 10));
  }
}
