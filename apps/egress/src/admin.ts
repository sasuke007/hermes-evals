/**
 * Admin API on a unix socket shared only with the worker: register an attempt
 * before its trial starts, read it, and remove it when the trial ends, and
 * list the names (never the values) of egress's environment for secret
 * presence. No network peer, and so no trial, can reach it.
 *
 * GET /health answers `{ ok, attempts }`, plus `judges` (live judge
 * registrations) when the judge path is configured, and `hostProxy: {
 * target, reachable, checkedAt }` when NOUS_HOST_PROXY is set
 * (host-probe.ts).
 *
 * /judges/... is the LLM judge's path (judge-path.ts): the worker registers
 * one judge call, has egress forward it with the model gateway's upstreams
 * and credentials, and removes it. It answers 404 when main did not
 * configure it.
 */
import http, { type ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { envNames } from './env-names.js';
import { guarded, parseTarget } from './handler.js';
import type { HostProxyProbe } from './host-probe.js';
import { createJudgePath, JUDGE_ROUTE, type JudgePathOptions } from './judge-path.js';
import type { Registry } from './registry.js';

export interface AdminOptions {
  /** The environment GET /env-names reports names from; process.env unless a test supplies one. */
  env?: () => NodeJS.ProcessEnv;
  /** The development host proxy's probe, when NOUS_HOST_PROXY is set. */
  hostProxy?: Pick<HostProxyProbe, 'status'> | null;
  /** The LLM judge's path: its registry, the model upstreams and the token cap. */
  judges?: JudgePathOptions;
}

const ATTEMPT_PATH = /^\/attempts\/([0-9A-HJKMNP-TV-Z]{26})$/;

function json(res: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    res.writeHead(status).end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function createAdminServer(registry: Registry, options: AdminOptions = {}): http.Server {
  const env = options.env ?? (() => process.env);
  const judgePath = options.judges ? createJudgePath(options.judges) : null;
  return http.createServer(
    guarded(async (req, res) => {
      const url = parseTarget(req.url, 'http://admin');
      if (!url) return json(res, 400, { message: 'malformed request target' });
      if (req.method === 'GET' && url.pathname === '/health') {
        const hostProxy = options.hostProxy ? await options.hostProxy.status() : undefined;
        return json(res, 200, {
          ok: true,
          attempts: registry.size,
          ...(options.judges ? { judges: options.judges.judges.size } : {}),
          ...(hostProxy ? { hostProxy } : {}),
        });
      }
      // Read on every request: the worker asks at start and on each heartbeat.
      if (req.method === 'GET' && url.pathname === '/env-names')
        return json(res, 200, { names: envNames(env()) });

      const judge = JUDGE_ROUTE.exec(url.pathname);
      if (judge) {
        return judgePath
          ? judgePath(req, res, judge)
          : json(res, 404, { message: 'the judge path is not configured' });
      }

      const match = ATTEMPT_PATH.exec(url.pathname);
      if (!match) return json(res, 404, { message: 'not found' });
      const attemptId = match[1]!;

      if (req.method === 'PUT') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 64 * 1024) return json(res, 413, { message: 'too large' });
        }
        try {
          registry.register(attemptId, JSON.parse(body));
          return json(res, 204);
        } catch (err) {
          const message =
            err instanceof ZodError
              ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
              : (err as Error).message;
          return json(res, 400, { message });
        }
      }
      if (req.method === 'GET') {
        const entry = registry.get(attemptId);
        return entry ? json(res, 200, entry) : json(res, 404, { message: 'unknown attempt' });
      }
      if (req.method === 'DELETE') {
        const removed = registry.remove(attemptId);
        return removed ? json(res, 200, removed) : json(res, 404, { message: 'unknown attempt' });
      }
      return json(res, 405, { message: 'method not allowed' });
    }),
  );
}
