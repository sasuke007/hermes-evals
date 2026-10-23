/**
 * Request-handler safety for egress's servers. Trials talk to the gateway and
 * the proxy directly, so nothing a request contains may end the process: an
 * exception in an async handler would otherwise be an unhandled rejection,
 * which exits Node, and a restart empties the registry of every attempt.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

/** Wraps an async handler so any throw answers 500 (or drops the response) instead of escaping. */
export function guarded(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): RequestListener {
  return (req, res) => {
    handler(req, res).catch(() => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal error', type: 'api_error' } }));
    });
  };
}

/**
 * Parses a request target. Node's HTTP parser accepts absolute-form targets
 * that the URL parser rejects (`http://a:99999/x`, `http://[/x`); those are
 * malformed requests, answered with 400.
 */
export function parseTarget(raw: string | undefined, base: string): URL | null {
  try {
    return new URL(raw ?? '/', base);
  } catch {
    return null;
  }
}
