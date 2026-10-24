/**
 * Which Host and Origin the API answers (plan 6.1). RequestedWithGuard's
 * custom-header rule stops other sites only while their requests are
 * cross-origin. DNS rebinding makes them same-origin: a page on
 * rebind.attacker.example re-resolves its own name to 127.0.0.1, and its
 * fetches then reach this API with no preflight. They still carry the
 * attacker's name in Host (and Origin), so the API answers only the names it
 * is reached by: loopback, the Compose service name, the web origin's host,
 * and any listed in ALLOWED_HOSTS.
 */
import type { NextFunction, Request, Response } from 'express';

export interface HostPolicy {
  /** Lower-case host names, without port or brackets. */
  hosts: ReadonlySet<string>;
  /** CORS_ORIGIN as configured, the web app's origin. */
  corsOrigin: string;
}

/** The names the API is always reached by: loopback, and `api` (the Compose service). */
const ALWAYS_ALLOWED = ['localhost', '127.0.0.1', '::1', 'api'];

export const HOST_NOT_ALLOWED = 'host not allowed';

/** The hosts allowed for this configuration: the fixed ones, CORS_ORIGIN's host and ALLOWED_HOSTS. */
export function hostPolicy(corsOrigin: string, allowedHosts?: string): HostPolicy {
  const hosts = new Set(ALWAYS_ALLOWED);
  const originHost = hostOfUrl(corsOrigin);
  if (originHost) hosts.add(originHost);
  for (const name of (allowedHosts ?? '').split(',')) {
    const host = hostOf(name.trim());
    if (host) hosts.add(host);
  }
  return { hosts, corsOrigin };
}

/**
 * The host name of a Host header value: the port stripped, `[::1]` unwrapped,
 * lower-cased. Null when there is none.
 */
export function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  let host = value.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return null;
    host = host.slice(1, end);
  } else if (host.split(':').length === 2) {
    // name:port; a bare IPv6 address has more than one colon and no port.
    host = host.slice(0, host.indexOf(':'));
  }
  return host === '' ? null : host;
}

function hostOfUrl(url: string): string | null {
  try {
    return hostOf(new URL(url).host);
  } catch {
    return null;
  }
}

export function isAllowedHost(policy: HostPolicy, header: string | undefined): boolean {
  const host = hostOf(header);
  return host !== null && policy.hosts.has(host);
}

/**
 * Whether a state-changing request's Origin may drive the API: the web
 * origin itself, or http(s) on an allowed host at any port (nginx on 8080,
 * the Vite proxy on 5173, Swagger on 3000). `null` (a sandboxed frame or a
 * file: page) is never allowed.
 */
export function isAllowedOrigin(policy: HostPolicy, origin: string): boolean {
  if (origin === policy.corsOrigin) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = hostOf(url.host);
  return host !== null && policy.hosts.has(host);
}

/**
 * Express middleware, installed before routing (configureApi), so it covers
 * every route, the docs and 404s: a request whose Host is not allowed gets
 * 403 { statusCode, message } and reaches nothing else.
 */
export function hostAllowlist(policy: HostPolicy) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isAllowedHost(policy, req.headers.host)) return next();
    res.status(403).json({ statusCode: 403, message: HOST_NOT_ALLOWED });
  };
}
