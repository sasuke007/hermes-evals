/**
 * The forward proxy trials use for every non-model connection: HTTP CONNECT
 * tunnels (https) and absolute-form requests (plain http). Each request must
 * carry the attempt's credentials in Proxy-Authorization; each destination
 * passes checkDestination before DNS and resolvePublic after it, and the
 * socket is opened to the vetted address. Every decision is logged against
 * the attempt.
 */
import http, { type IncomingMessage } from 'node:http';
import net from 'node:net';
import { guarded } from './handler.js';
import { checkDestination, resolvePublic, type Resolver } from './policy.js';
import type { Registration, Registry } from './registry.js';

export interface ProxyOptions {
  registry: Registry;
  resolve: Resolver;
  /** Opens the outbound socket; replaceable in tests. */
  connect?: (address: string, port: number) => net.Socket;
  maxTunnelsPerAttempt?: number;
  idleTimeoutMs?: number;
}

const defaultConnect = (address: string, port: number): net.Socket =>
  net.connect({ host: address, port });

function credentials(header: string | undefined): { attemptId: string; token: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0) return null;
  return { attemptId: decoded.slice(0, colon), token: decoded.slice(colon + 1) };
}

/** Parses a CONNECT authority: `host:port` or `[v6]:port`. */
export function parseAuthority(
  authority: string | undefined,
): { host: string; port: number } | null {
  if (!authority) return null;
  const v6 = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(authority);
  const plain = /^([^:[\]\s/@]+):(\d{1,5})$/.exec(authority);
  const match = v6 ?? plain;
  if (!match) return null;
  return { host: match[1]!, port: Number(match[2]) };
}

function authenticate(registry: Registry, req: IncomingMessage): Registration | null {
  const creds = credentials(req.headers['proxy-authorization']);
  return creds ? registry.authenticate(creds.attemptId, creds.token) : null;
}

function refuseSocket(socket: net.Socket, status: number, text: string, reason?: string): void {
  const lines = [`HTTP/1.1 ${status} ${text}`];
  if (status === 407) lines.push('Proxy-Authenticate: Basic realm="egress"');
  if (reason) lines.push(`X-Egress-Reason: ${reason.replace(/[^\x20-\x7e]/g, '')}`);
  lines.push('Content-Length: 0', 'Connection: close', '', '');
  socket.end(lines.join('\r\n'));
}

export function createProxyServer(options: ProxyOptions): http.Server {
  const { registry, resolve } = options;
  const connect = options.connect ?? defaultConnect;
  const maxTunnels = options.maxTunnelsPerAttempt ?? 64;
  const idle = options.idleTimeoutMs ?? 120_000;

  /** Shared decision path; returns the vetted address or logs and reports the refusal. */
  async function decide(
    registration: Registration,
    kind: 'connect' | 'http',
    host: string,
    port: number,
  ): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
    const verdict = checkDestination(host, port, registration);
    if (!verdict.allow) {
      registry.log(registration.attemptId, {
        kind,
        host,
        port,
        decision: 'denied',
        reason: verdict.reason,
      });
      return { ok: false, reason: verdict.reason };
    }
    const resolved = await resolvePublic(host, resolve);
    if (!resolved.ok) {
      registry.log(registration.attemptId, {
        kind,
        host,
        port,
        decision: 'denied',
        reason: resolved.reason,
      });
      return resolved;
    }
    return resolved;
  }

  // Absolute-form requests: plain http through the proxy.
  const server = http.createServer(
    guarded(async (req, res) => {
      const registration = authenticate(registry, req);
      if (!registration) {
        res.writeHead(407, { 'proxy-authenticate': 'Basic realm="egress"', connection: 'close' });
        res.end();
        return;
      }
      let target: URL;
      try {
        target = new URL(req.url ?? '');
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (target.protocol !== 'http:' || target.username || target.password) {
        registry.log(registration.attemptId, {
          kind: 'http',
          host: target.hostname,
          decision: 'denied',
          reason: 'only plain http URLs without credentials',
        });
        res.writeHead(403, { 'x-egress-reason': 'only plain http URLs without credentials' }).end();
        return;
      }
      const port = target.port ? Number(target.port) : 80;
      const decision = await decide(registration, 'http', target.hostname, port);
      if (!decision.ok) {
        res.writeHead(403, { 'x-egress-reason': decision.reason }).end();
        return;
      }
      const started = Date.now();
      const headers = { ...req.headers };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      headers.host = target.host;
      const upstream = http.request({
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        createConnection: () => connect(decision.address, port),
      });
      upstream.on('response', (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
        response.on('end', () =>
          registry.log(registration.attemptId, {
            kind: 'http',
            host: target.hostname,
            ip: decision.address,
            port,
            decision: 'allowed',
            status: response.statusCode,
            ms: Date.now() - started,
          }),
        );
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    }),
  );

  // CONNECT tunnels: https and anything else over TCP. A throw drops the client socket.
  server.on('connect', (req: IncomingMessage, socket: net.Socket, head: Buffer) => {
    handleConnect(req, socket, head).catch(() => socket.destroy());
  });
  const handleConnect = async (req: IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const registration = authenticate(registry, req);
    if (!registration) return refuseSocket(socket, 407, 'Proxy Authentication Required');
    const target = parseAuthority(req.url);
    if (!target) {
      registry.log(registration.attemptId, {
        kind: 'connect',
        decision: 'denied',
        reason: 'malformed authority',
      });
      return refuseSocket(socket, 400, 'Bad Request', 'malformed authority');
    }
    const decision = await decide(registration, 'connect', target.host, target.port);
    if (!decision.ok) return refuseSocket(socket, 403, 'Forbidden', decision.reason);
    if (!registry.openTunnel(registration.attemptId, maxTunnels)) {
      registry.log(registration.attemptId, {
        kind: 'connect',
        host: target.host,
        port: target.port,
        decision: 'denied',
        reason: 'too many open tunnels',
      });
      return refuseSocket(socket, 429, 'Too Many Requests', 'too many open tunnels');
    }

    const started = Date.now();
    const upstream = connect(decision.address, target.port);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      registry.closeTunnel(registration.attemptId);
      registry.log(registration.attemptId, {
        kind: 'connect',
        host: target.host,
        ip: decision.address,
        port: target.port,
        decision: 'allowed',
        bytesUp: upstream.bytesWritten,
        bytesDown: upstream.bytesRead,
        ms: Date.now() - started,
      });
      socket.destroy();
      upstream.destroy();
    };
    upstream.setTimeout(idle, close);
    socket.setTimeout(idle, close);
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => {
      if (!socket.writableEnded && upstream.bytesRead === 0)
        refuseSocket(socket, 502, 'Bad Gateway');
      close();
    });
    upstream.on('close', close);
    socket.on('close', close);
  };

  return server;
}
