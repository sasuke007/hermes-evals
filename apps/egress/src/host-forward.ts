/**
 * Development path to a model proxy on the host, such as
 * `hermes proxy start --provider nous` using the login you already have.
 *
 * That proxy binds 127.0.0.1 and refuses any Host header that is not a
 * loopback name, which guards it against DNS rebinding. When NOUS_HOST_PROXY
 * is set, egress listens on its own loopback and forwards raw TCP to the host
 * proxy, so the gateway calls `http://127.0.0.1:<port>` and the request
 * arrives with a loopback Host. The listener is part of the egress process:
 * it lives and restarts with it.
 *
 * Who can reach what: trials cannot reach egress's loopback (egress refuses
 * loopback destinations) nor the host (their networks are internal). Any
 * container on a non-internal network in the Docker VM can reach the host
 * proxy directly, though, as with any service on the host's loopback under
 * Colima or Docker Desktop. Use this only on a machine you trust.
 */
import net from 'node:net';

export interface HostPort {
  host: string;
  port: number;
}

export function parseHostPort(value: string, name: string): HostPort {
  const match = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(value.trim());
  const port = match ? Number(match[2]) : NaN;
  if (!match || port < 1 || port > 65535)
    throw new Error(`${name} must be host:port, got ${value}`);
  return { host: match[1]!, port };
}

export function startHostForward(options: {
  listen: HostPort;
  target: HostPort;
  log: (entry: Record<string, unknown>) => void;
}): net.Server {
  const { listen, target, log } = options;
  if (!['127.0.0.1', '::1'].includes(listen.host)) {
    throw new Error(`the host forward must listen on loopback, not ${listen.host}`);
  }
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    client.pipe(upstream).pipe(client);
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', close);
    upstream.on('error', (err) => {
      log({
        msg: 'host proxy unreachable',
        target: `${target.host}:${target.port}`,
        error: err.message,
      });
      close();
    });
  });
  server.listen(listen.port, listen.host, () =>
    log({
      msg: 'host forward listening',
      listen: `${listen.host}:${listen.port}`,
      target: `${target.host}:${target.port}`,
    }),
  );
  return server;
}
