/**
 * egress entrypoint: the forward proxy, the model gateway and the admin
 * socket share one registry of live attempts.
 *
 * Environment:
 *   PROXY_PORT       forward proxy port (default 3128)
 *   GATEWAY_PORT     model gateway port (default 8080)
 *   ADMIN_SOCKET     unix socket for the worker (default /run/egress/admin.sock)
 *   MODEL_UPSTREAMS  JSON: { "<provider>": { "baseUrl": "...", "apiKeyEnv": "NAME" } }
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { createAdminServer } from './admin.js';
import { createGatewayServer, type Upstream } from './gateway.js';
import { parseHostPort, startHostForward } from './host-forward.js';
import { createProxyServer } from './proxy.js';
import { Registry } from './registry.js';

const UpstreamsSchema = z.record(
  z.string(),
  z
    .object({
      baseUrl: z.string().url(),
      apiKeyEnv: z.string().optional(),
      bodyDefaults: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
);

function log(entry: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function loadUpstreams(): Record<string, Upstream> {
  const configured = UpstreamsSchema.parse(JSON.parse(process.env.MODEL_UPSTREAMS ?? '{}'));
  const upstreams: Record<string, Upstream> = {};
  for (const [name, { baseUrl, apiKeyEnv, bodyDefaults }] of Object.entries(configured)) {
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
    if (apiKeyEnv && !apiKey)
      log({ msg: 'upstream credential missing', provider: name, env: apiKeyEnv });
    upstreams[name] = { baseUrl, apiKey, bodyDefaults };
  }
  return upstreams;
}

const registry = new Registry();
const proxyPort = Number(process.env.PROXY_PORT ?? 3128);
const gatewayPort = Number(process.env.GATEWAY_PORT ?? 8080);
const adminSocket = process.env.ADMIN_SOCKET ?? '/run/egress/admin.sock';
const upstreams = loadUpstreams();

// Development: reach a Nous proxy on the host through egress's own loopback (host-forward.ts).
const HOST_FORWARD_PORT = 8645;
const hostProxy = process.env.NOUS_HOST_PROXY?.trim();
const hostForward = hostProxy
  ? startHostForward({
      listen: { host: '127.0.0.1', port: HOST_FORWARD_PORT },
      target: parseHostPort(hostProxy, 'NOUS_HOST_PROXY'),
      log,
    })
  : null;
if (hostForward) {
  upstreams.nous = {
    ...upstreams.nous,
    baseUrl: `http://127.0.0.1:${HOST_FORWARD_PORT}/v1`,
  };
  log({ msg: 'nous upstream is the host proxy (development)', target: hostProxy });
}

const proxy = createProxyServer({
  registry,
  resolve: async (host) =>
    (await lookup(host, { all: true, verbatim: true })).map((a) => a.address),
});
const gateway = createGatewayServer({ registry, upstreams });
const admin = createAdminServer(registry);

proxy.listen(proxyPort, '0.0.0.0', () => log({ msg: 'proxy listening', port: proxyPort }));
gateway.listen(gatewayPort, '0.0.0.0', () =>
  log({ msg: 'model gateway listening', port: gatewayPort, providers: Object.keys(upstreams) }),
);
mkdirSync(dirname(adminSocket), { recursive: true });
if (existsSync(adminSocket)) unlinkSync(adminSocket);
admin.listen(adminSocket, () => {
  chmodSync(adminSocket, 0o666);
  log({ msg: 'admin listening', socket: adminSocket });
});

// Last line of defence: a rejection that escaped a handler is logged, never fatal.
// A restart would drop every running attempt's registration.
process.on('unhandledRejection', (reason) =>
  log({
    msg: 'unhandled rejection',
    error: reason instanceof Error ? reason.message : String(reason),
  }),
);

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    for (const server of [proxy, gateway, admin, hostForward]) server?.close();
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
