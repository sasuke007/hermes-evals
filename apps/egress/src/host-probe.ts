/**
 * Whether the development host proxy answers (NOUS_HOST_PROXY, UI_FLOWS 19
 * #7). Only egress can reach it, so egress's admin /health reports it, the
 * worker records that on its `workers` row, and the API shows Nous as `host`
 * or `host_unreachable`. The check is a bare TCP connect: the host proxy
 * refuses any request whose Host is not a loopback name, so an HTTP request
 * from here would prove nothing more. Answers are cached briefly because the
 * worker asks on every heartbeat.
 */
import net from 'node:net';
import type { HostPort } from './host-forward.js';

export interface HostProxyStatus {
  /** `host:port` as configured (IPv6 in brackets). */
  target: string;
  /** Whether a TCP connection to the target opened within the timeout. */
  reachable: boolean;
  /** When the connection was tried (ISO 8601); up to `cacheMs` before the answer. */
  checkedAt: string;
}

export interface HostProbeOptions {
  /** How long a connection may take to open (default 1 s). */
  timeoutMs?: number;
  /** How long an answer is reused (default 5 s). */
  cacheMs?: number;
  now?: () => number;
  /** Opens the probe socket; replaceable in tests. */
  connect?: (target: HostPort) => net.Socket;
}

export function formatHostPort({ host, port }: HostPort): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

export class HostProxyProbe {
  readonly target: string;
  private cached: { status: HostProxyStatus; at: number } | null = null;
  private inFlight: Promise<HostProxyStatus> | null = null;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly now: () => number;
  private readonly connect: (target: HostPort) => net.Socket;

  constructor(
    private readonly hostPort: HostPort,
    options: HostProbeOptions = {},
  ) {
    this.target = formatHostPort(hostPort);
    this.timeoutMs = options.timeoutMs ?? 1000;
    this.cacheMs = options.cacheMs ?? 5000;
    this.now = options.now ?? Date.now;
    this.connect = options.connect ?? ((t) => net.connect({ host: t.host, port: t.port }));
  }

  /** The cached answer while fresh, else one new check concurrent callers share. Never rejects. */
  status(): Promise<HostProxyStatus> {
    if (this.cached && this.now() - this.cached.at < this.cacheMs) {
      return Promise.resolve(this.cached.status);
    }
    this.inFlight ??= this.check().finally(() => (this.inFlight = null));
    return this.inFlight;
  }

  private async check(): Promise<HostProxyStatus> {
    const at = this.now();
    const reachable = await new Promise<boolean>((resolve) => {
      let socket: net.Socket;
      try {
        socket = this.connect(this.hostPort);
      } catch {
        return resolve(false);
      }
      const done = (ok: boolean) => {
        clearTimeout(timer);
        socket.destroy();
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), this.timeoutMs);
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
    const status = { target: this.target, reachable, checkedAt: new Date(at).toISOString() };
    this.cached = { status, at };
    return status;
  }
}
