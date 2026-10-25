/**
 * The transport of the LLM judge's path over egress's admin socket (Phase 3
 * S2): one request with a deadline for the whole answer and an abort
 * signal, and the typed error that tells the judge client how it failed.
 * EgressClient's judge methods (egress-client.ts) are built on it.
 */
import http from 'node:http';

/**
 * Why a judge-path call over the admin socket failed, so the judge client
 * can tell a refusal (never retried) from a transport failure (retried once)
 * and a timeout:
 * - `refused`: egress answered and said no (a registration it will not hold);
 * - `timeout`: no whole answer within the call's timeout;
 * - `aborted`: the caller's signal aborted it;
 * - `unreachable`: the socket could not be reached or broke;
 * - `protocol`: egress answered something this client cannot read.
 */
export type EgressFailure = 'refused' | 'timeout' | 'aborted' | 'unreachable' | 'protocol';

export class EgressCallError extends Error {
  override readonly name = 'EgressCallError';

  constructor(
    readonly failure: EgressFailure,
    message: string,
    /** Egress's HTTP status, when it answered. */
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

/** Longest judge-path answer read into memory; egress itself caps an upstream answer at 4 MiB. */
const MAX_JUDGE_REPLY_BYTES = 8 * 1024 * 1024;

/** The readable part of an egress refusal: `{ error: { message } }` or `{ message }`. */
export function refusalMessage(json: unknown): string {
  if (typeof json === 'object' && json !== null) {
    const { error, message } = json as { error?: { message?: unknown }; message?: unknown };
    if (typeof error?.message === 'string') return error.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.map(String).join('; ');
  }
  return JSON.stringify(json)?.slice(0, 300) ?? 'no reason given';
}

/**
 * One request over egress's admin socket with a deadline for the whole
 * answer, not only for idle time, and the caller's abort signal. Resolves
 * whatever status egress answered, with its JSON body; rejects with an
 * EgressCallError saying which way it failed.
 */
export function adminSocketCall(
  socketPath: string,
  method: string,
  path: string,
  body: unknown,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ status: number; json: unknown }> {
  const what = `egress ${method} ${path}`;
  return new Promise((resolve, reject) => {
    const { signal, timeoutMs } = options;
    if (signal?.aborted) {
      reject(new EgressCallError('aborted', `${what} was aborted`));
      return;
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request({
      socketPath,
      method,
      path,
      headers: payload
        ? { 'content-type': 'application/json', 'content-length': payload.length }
        : {},
    });
    let failure: EgressCallError | null = null;
    const settle = (outcome: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      outcome();
    };
    const fail = (error: EgressCallError) => {
      failure ??= error;
      req.destroy(error);
    };
    const broke = (err: Error) =>
      settle(() =>
        reject(failure ?? new EgressCallError('unreachable', `${what} failed: ${err.message}`)),
      );
    const timer = setTimeout(
      () => fail(new EgressCallError('timeout', `${what} did not answer within ${timeoutMs} ms`)),
      timeoutMs,
    );
    const onAbort = () => fail(new EgressCallError('aborted', `${what} was aborted`));
    signal?.addEventListener('abort', onAbort, { once: true });

    req.on('response', (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let ended = false;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_JUDGE_REPLY_BYTES) {
          fail(
            new EgressCallError(
              'protocol',
              `${what} answered more than ${MAX_JUDGE_REPLY_BYTES} bytes`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        ended = true;
        const status = res.statusCode ?? 0;
        const text = Buffer.concat(chunks).toString('utf8');
        // A throw inside this listener would be an uncaught exception and end the worker.
        settle(() => {
          try {
            resolve({ status, json: text ? JSON.parse(text) : null });
          } catch {
            reject(new EgressCallError('protocol', `${what} answered ${status} with invalid JSON`));
          }
        });
      });
      res.on('error', broke);
      res.on('close', () => {
        if (!ended) broke(new Error('the answer broke off'));
      });
    });
    req.on('error', broke);
    req.end(payload);
  });
}
