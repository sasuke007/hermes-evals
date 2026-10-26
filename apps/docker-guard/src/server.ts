/**
 * HTTP server on a unix socket that forwards allowed Docker Engine API calls
 * to the real socket. Streaming responses (logs, wait) are piped through.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import {
  checkCreateBody,
  decideRoute,
  restrictListQuery,
  TRIAL_LABEL,
  TRIAL_LABEL_VALUE,
  type GuardConfig,
} from './policy.js';

export interface ServerOptions extends GuardConfig {
  /** Path of the real Docker socket. */
  upstreamSocket: string;
  log?: (entry: Record<string, unknown>) => void;
}

const MAX_CREATE_BODY = 256 * 1024;
/** Long-lived streams (logs, wait) a worker may hold open at once. */
const MAX_OPEN_STREAMS = 128;
const FULL_ID = /^[0-9a-f]{64}$/;

/** Upstream headers are built, never copied: nothing the policy did not review reaches the Engine. */
function upstreamHeaders(body?: Buffer): Record<string, string> {
  const headers: Record<string, string> = { host: 'docker' };
  if (body) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
  }
  return headers;
}

/** True when the client sent, or announced, a request body. */
function hasBody(req: IncomingMessage): boolean {
  const length = Number(req.headers['content-length'] ?? 0);
  return length > 0 || req.headers['transfer-encoding'] !== undefined;
}

function deny(res: ServerResponse, status: number, message: string, details?: string[]): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message, details }));
}

function upstreamRequest(
  options: ServerOptions,
  method: string,
  path: string,
  headers: Record<string, string>,
): http.ClientRequest {
  // A fresh upstream connection per call: no keep-alive state shared between requests.
  return http.request({ socketPath: options.upstreamSocket, method, path, headers, agent: false });
}

/** Sends a small request to the Engine and returns its status and parsed JSON body. */
async function engineJson(
  options: ServerOptions,
  method: string,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = upstreamRequest(options, method, path, { host: 'docker' });
    request.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        resolve({ status: response.statusCode ?? 502, body });
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Sends the decided request (with the validated body, if any) to the Engine and pipes the answer back. */
function forward(
  options: ServerOptions,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body?: Buffer,
): void {
  const upstream = upstreamRequest(options, req.method ?? 'GET', path, upstreamHeaders(body));
  upstream.on('response', (response) => {
    res.writeHead(response.statusCode ?? 502, response.headers);
    // Send the headers now, as the Engine did. Node otherwise holds them until the first
    // body byte, so a silent container's logs, or a wait that has registered, would look
    // to the worker like a request still in flight.
    res.flushHeaders();
    response.pipe(res);
  });
  upstream.on('error', (err) => {
    if (!res.headersSent) deny(res, 502, `docker engine unreachable: ${err.message}`);
    else res.destroy(err);
  });
  // A client that goes away (for example a cancelled log follow) ends the upstream call too.
  res.on('close', () => upstream.destroy());
  upstream.end(body);
}

export function createGuardServer(options: ServerOptions): http.Server {
  const log = options.log ?? ((entry) => process.stdout.write(`${JSON.stringify(entry)}\n`));

  let openStreams = 0;
  const server = http.createServer(async (req, res) => {
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    let decision: ReturnType<typeof decideRoute>;
    try {
      decision = decideRoute(method, url, options);
    } catch (err) {
      decision = {
        allow: false,
        status: 400,
        reason: `malformed request: ${(err as Error).message}`,
      };
    }
    if (decision.allow && decision.kind !== 'container-create' && hasBody(req)) {
      decision = { allow: false, status: 400, reason: 'this operation takes no request body' };
    }
    if (!decision.allow) {
      log({ at: new Date().toISOString(), method, url, allow: false, reason: decision.reason });
      deny(res, decision.status, decision.reason);
      return;
    }

    try {
      switch (decision.kind) {
        case 'container-list':
          forward(options, req, res, restrictListQuery(decision.path));
          return;

        case 'container-create': {
          let parsed: unknown;
          try {
            parsed = JSON.parse((await readBody(req, MAX_CREATE_BODY)).toString('utf8'));
          } catch (err) {
            deny(res, 400, `invalid create body: ${(err as Error).message}`);
            return;
          }
          const checked = checkCreateBody(parsed, options, decision.name);
          if (!checked.ok) {
            log({
              at: new Date().toISOString(),
              method,
              url,
              allow: false,
              reason: 'create body refused',
              details: checked.reasons,
            });
            deny(res, 403, 'container create refused', checked.reasons);
            return;
          }
          // Pin the image by id, so a retagged image cannot be swapped in between check and use.
          const image = await engineJson(
            options,
            'GET',
            `/images/${encodeURIComponent(options.trialImage)}/json`,
          );
          const imageId = (image.body as { Id?: string } | null)?.Id;
          if (image.status !== 200 || !imageId) {
            deny(res, 409, `trial image ${options.trialImage} is not present`);
            return;
          }
          const body = Buffer.from(JSON.stringify({ ...checked.body, Image: imageId }));
          log({
            at: new Date().toISOString(),
            method,
            url,
            allow: true,
            ...(checked.kind === 'verifier'
              ? { verifier: checked.body.Labels['hermes-evals.verifier'] }
              : { attempt: checked.body.Labels['hermes-evals.attempt'] }),
          });
          forward(options, req, res, decision.path, body);
          return;
        }

        case 'container-op': {
          // The operation is allowed only on a container that carries the trial label,
          // and is sent to the immutable id that check resolved, not to the caller's reference.
          const inspect = await engineJson(
            options,
            'GET',
            `/containers/${encodeURIComponent(decision.containerId!)}/json`,
          );
          if (inspect.status === 404) {
            deny(res, 404, 'no such container');
            return;
          }
          const labels = (inspect.body as { Config?: { Labels?: Record<string, string> } } | null)
            ?.Config?.Labels;
          if (labels?.[TRIAL_LABEL] !== TRIAL_LABEL_VALUE) {
            log({
              at: new Date().toISOString(),
              method,
              url,
              allow: false,
              reason: 'not a trial container',
            });
            deny(res, 403, 'only trial containers may be operated on');
            return;
          }
          const resolvedId = (inspect.body as { Id?: string } | null)?.Id;
          if (!resolvedId || !FULL_ID.test(resolvedId)) {
            deny(res, 502, 'engine returned no container id');
            return;
          }
          const resolvedPath = decision.path.replace(
            /^\/containers\/[^/?]+/,
            `/containers/${resolvedId}`,
          );
          const streaming = /\/(logs|wait)(\?|$)/.test(resolvedPath);
          if (streaming && openStreams >= MAX_OPEN_STREAMS) {
            deny(res, 429, 'too many open log or wait streams');
            return;
          }
          if (streaming) {
            openStreams += 1;
            res.on('close', () => (openStreams -= 1));
          }
          forward(options, req, res, resolvedPath);
          return;
        }

        default:
          forward(options, req, res, decision.path);
      }
    } catch (err) {
      if (!res.headersSent) deny(res, 502, (err as Error).message);
      else res.destroy(err as Error);
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return server;
}
