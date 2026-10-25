/**
 * egress entrypoint: the forward proxy, the model and MCP gateways and the
 * admin socket share one registry of live attempts.
 *
 * Environment:
 *   PROXY_PORT       forward proxy port (default 3128)
 *   GATEWAY_PORT     model and MCP gateway port (default 8080)
 *   ADMIN_SOCKET     unix socket for the worker (default /run/egress/admin.sock)
 *   MODEL_UPSTREAMS  JSON: { "<provider>": { "baseUrl": "...", "apiKeyEnv": "NAME" } }
 *                    `custom` has no entry: each custom attempt registers its base URL.
 *   CUSTOM_API_KEY   optional key sent to a custom attempt's base URL
 *   MODEL_TOKEN_CAP_PER_ATTEMPT  total tokens an attempt (or a judge registration)
 *                    is served when its registration names no maxTokens
 *                    (default 2000000); past it the model gateway answers
 *                    402 and the judge path 429
 *   NOUS_HOST_PROXY  development: host:port of `hermes proxy start` on the host
 *   and the values of http MCP headers, under the names the definitions give.
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import { createAdminServer } from './admin.js';
import { CUSTOM_API_KEY_ENV, createGatewayServer, type Upstream } from './gateway.js';
import { parseHostPort, startHostForward } from './host-forward.js';
import { HostProxyProbe } from './host-probe.js';
import { JudgeRegistry } from './judge-registry.js';
import { createProxyServer } from './proxy.js';
import { CUSTOM_UPSTREAM, Registry } from './registry.js';
import { DEFAULT_TOKEN_CAP_PER_ATTEMPT } from './upstream.js';

const UpstreamsSchema = z
  .record(
    z.string(),
    z
      .object({
        baseUrl: z.string().url(),
        apiKeyEnv: z.string().optional(),
        bodyDefaults: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  )
  .refine((upstreams) => !(CUSTOM_UPSTREAM in upstreams), {
    message: `${CUSTOM_UPSTREAM} has no fixed upstream: each custom attempt registers its base URL`,
  });

/** MODEL_TOKEN_CAP_PER_ATTEMPT; empty or unset means the default. */
const TokenCapSchema = z.coerce
  .number()
  .int()
  .min(1000)
  .max(1_000_000_000)
  .default(DEFAULT_TOKEN_CAP_PER_ATTEMPT);

function log(entry: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}

function loadUpstreams(): { upstreams: Record<string, Upstream>; keyNames: string[] } {
  const configured = UpstreamsSchema.parse(JSON.parse(process.env.MODEL_UPSTREAMS ?? '{}'));
  const upstreams: Record<string, Upstream> = {};
  const keyNames: string[] = [];
  for (const [name, { baseUrl, apiKeyEnv, bodyDefaults }] of Object.entries(configured)) {
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
    if (apiKeyEnv) keyNames.push(apiKeyEnv);
    if (apiKeyEnv && !apiKey)
      log({ msg: 'upstream credential missing', provider: name, env: apiKeyEnv });
    upstreams[name] = { baseUrl, apiKey, bodyDefaults };
  }
  return { upstreams, keyNames };
}

const proxyPort = Number(process.env.PROXY_PORT ?? 3128);
const gatewayPort = Number(process.env.GATEWAY_PORT ?? 8080);
const adminSocket = process.env.ADMIN_SOCKET ?? '/run/egress/admin.sock';
const { upstreams, keyNames } = loadUpstreams();
const tokenCap = TokenCapSchema.parse(process.env.MODEL_TOKEN_CAP_PER_ATTEMPT || undefined);
// No MCP route may name an upstream credential as a header variable, nor one egress lacks.
const registry = new Registry(Date.now, {
  credentialEnvNames: keyNames,
  env: () => process.env,
});
log({
  msg: 'custom upstream key',
  env: CUSTOM_API_KEY_ENV,
  set: Boolean(process.env[CUSTOM_API_KEY_ENV]),
});

// Development: reach a Nous proxy on the host through egress's own loopback (host-forward.ts).
const HOST_FORWARD_PORT = 8645;
const hostProxy = process.env.NOUS_HOST_PROXY?.trim();
const hostTarget = hostProxy ? parseHostPort(hostProxy, 'NOUS_HOST_PROXY') : null;
const hostForward = hostTarget
  ? startHostForward({
      listen: { host: '127.0.0.1', port: HOST_FORWARD_PORT },
      target: hostTarget,
      log,
    })
  : null;
// Admin /health says whether the host proxy answers; the worker records it (UI_FLOWS 19 #7).
const hostProbe = hostTarget ? new HostProxyProbe(hostTarget) : null;
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
const gateway = createGatewayServer({
  registry,
  upstreams,
  mcp: { log },
  tokenCapPerAttempt: tokenCap,
});
// The judge path forwards with the same upstreams, read after the host forward replaced nous's.
const admin = createAdminServer(registry, {
  hostProxy: hostProbe,
  judges: { judges: new JudgeRegistry(), upstreams, tokenCap, log },
});

proxy.listen(proxyPort, '0.0.0.0', () => log({ msg: 'proxy listening', port: proxyPort }));
gateway.listen(gatewayPort, '0.0.0.0', () =>
  log({
    msg: 'model and MCP gateway listening',
    port: gatewayPort,
    providers: Object.keys(upstreams),
    tokenCapPerAttempt: tokenCap,
  }),
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
