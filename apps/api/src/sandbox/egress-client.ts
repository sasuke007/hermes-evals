/**
 * Talks to egress over its admin socket: register an attempt (token, network
 * policy, model access) before its trial starts, and remove it when the trial
 * ends, collecting the attempt's model usage and connection log. The worker
 * also asks it which environment variable names it holds (secret presence,
 * plan 5.3); values never cross the socket.
 */
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { z } from 'zod';
import { ENV_NAME_PATTERN } from '@hermes-evals/shared';

/**
 * One http MCP server an attempt may reach through the MCP gateway
 * (`http://egress:8080/mcp/<name>`, plan 5.3). Names only: egress reads each
 * header's value from its own environment, so no value crosses the socket.
 */
export interface EgressMcpRoute {
  /** The server name: the gateway path segment and the config.yaml key. */
  name: string;
  /** The definition's exact URL. Requests go there and nowhere else; no redirect is followed. */
  url: string;
  /** Headers egress adds to every forwarded request, each value from its own environment variable `env`. */
  headers: Array<{ header: string; env: string }>;
}

export interface EgressRegistration {
  /**
   * The attempt token. The forward proxy checks it as proxy credentials, and
   * both the model gateway and the MCP gateway check it as
   * `Authorization: Bearer <token>` (spike in execution/providers-map.ts:
   * config.yaml gives each http MCP server `Authorization: Bearer
   * ${HERMES_EVALS_ATTEMPT_TOKEN}` and the container environment carries the
   * value). The MCP gateway strips that header before forwarding upstream.
   */
  token: string;
  /**
   * `allowlist`: CONNECT refuses every host and `allowHosts` stays empty
   * (UI_FLOWS 19 #16); the trial reaches only the model and MCP gateways.
   * `public`: any public host, only for configurations that enable the web or
   * browser toolset.
   */
  mode: 'allowlist' | 'public';
  allowHosts?: string[];
  allowPorts?: number[];
  /** Model gateway upstream name (ProviderRoute.upstream), or null when the attempt makes no model calls. */
  provider: string | null;
  models?: string[];
  maxTokens?: number;
  expiresAt: number;
  /**
   * For provider `custom` only: the configuration version's own base URL,
   * which egress forwards this attempt's model calls to (with CUSTOM_API_KEY
   * from its environment, when set). It may be a private address: the
   * configuration chooses it, the agent cannot.
   */
  upstream?: { baseUrl: string };
  /** The attempt's http MCP servers; empty or absent when it has none. */
  mcp?: EgressMcpRoute[];
}

export interface EgressUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * One entry of an attempt's connection log. The lifecycle stores each as a
 * `network` platform event (NetworkEventPayloadSchema in shared records.ts).
 */
export interface EgressLogEntry {
  at: string;
  /** `mcp`: a call through the MCP gateway, with `server` set. */
  kind: 'connect' | 'http' | 'model' | 'mcp';
  /** The MCP server name, for `mcp`. */
  server?: string;
  /** The HTTP method, for `mcp`. */
  method?: string;
  host?: string;
  ip?: string;
  port?: number;
  model?: string;
  decision: 'allowed' | 'denied';
  reason?: string;
  status?: number;
  bytesUp?: number;
  bytesDown?: number;
  ms?: number;
  /** A `model` call's own usage, when the upstream reported it. */
  promptTokens?: number;
  completionTokens?: number;
}

const EnvNamesResponseSchema = z.object({ names: z.array(z.string().regex(ENV_NAME_PATTERN)) });

const count = z.number().int().nonnegative();

/** One connection log entry as egress's registry writes it (apps/egress/src/registry.ts LogEntry). */
const EgressLogEntrySchema = z.object({
  at: z.string(),
  kind: z.enum(['connect', 'http', 'model', 'mcp']),
  server: z.string().optional(),
  method: z.string().optional(),
  host: z.string().optional(),
  ip: z.string().optional(),
  port: z.number().int().optional(),
  model: z.string().optional(),
  decision: z.enum(['allowed', 'denied']),
  reason: z.string().optional(),
  status: z.number().int().optional(),
  bytesUp: count.optional(),
  bytesDown: count.optional(),
  ms: z.number().nonnegative().optional(),
  promptTokens: count.optional(),
  completionTokens: count.optional(),
}) satisfies z.ZodType<EgressLogEntry>;

/**
 * DELETE /attempts/:id's answer: the attempt's usage and connection log.
 * Parsed, not cast, as the other answers are: usage prices the attempt
 * (pricing.ts billableTokens) and the log becomes events.
 */
const EgressReportSchema = z.object({
  usage: z.object({
    calls: count,
    promptTokens: count,
    completionTokens: count,
    totalTokens: count,
  }),
  log: z.array(EgressLogEntrySchema),
});

const EgressHealthSchema = z.object({
  ok: z.boolean(),
  attempts: z.number().int().nonnegative(),
  /**
   * The development host forward (NOUS_HOST_PROXY) and whether its target
   * answered when egress last checked (cached for a few seconds). Present only
   * when that variable is set.
   */
  hostProxy: z
    .object({ target: z.string().min(1), reachable: z.boolean(), checkedAt: z.string() })
    .optional(),
});
export type EgressHealth = z.infer<typeof EgressHealthSchema>;

/**
 * A fresh per-attempt secret: 256 bits as 64 lowercase hex digits. Hex, not
 * base64url: the token is a command-line value (`hermes chat --api-key
 * <token>`), and argparse reads a value that begins with `-` (one base64url
 * token in 64) as an option, so Hermes would exit 2 before the run. Hex is
 * also safe in the proxy URL's userinfo and in a Bearer header.
 */
export const newAttemptToken = (): string => randomBytes(32).toString('hex');

export class EgressClient {
  constructor(private readonly socketPath: string) {}

  private call(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = 10_000,
  ): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const req = http.request({
        socketPath: this.socketPath,
        method,
        path,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`egress ${method} ${path} timed out`)));
      req.on('response', (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          // A throw inside this listener would be an uncaught exception and end the worker.
          try {
            resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null });
          } catch {
            reject(
              new Error(`egress ${method} ${path} answered ${res.statusCode} with invalid JSON`),
            );
          }
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  async register(attemptId: string, registration: EgressRegistration): Promise<void> {
    const res = await this.call('PUT', `/attempts/${attemptId}`, registration);
    if (res.status !== 204)
      throw new Error(`egress refused registration: ${JSON.stringify(res.json)}`);
  }

  /**
   * Removes the attempt; its token stops working at once. Returns what it
   * used and did, null when egress did not have it. Throws on an answer it
   * cannot read, so a changed egress never prices an attempt from garbage.
   */
  async remove(attemptId: string): Promise<{ usage: EgressUsage; log: EgressLogEntry[] } | null> {
    const res = await this.call('DELETE', `/attempts/${attemptId}`);
    if (res.status !== 200) return null;
    const report = EgressReportSchema.safeParse(res.json);
    if (!report.success) {
      throw new Error(`egress DELETE /attempts/${attemptId} answered a report in an unknown shape`);
    }
    return report.data;
  }

  /**
   * Sorted names of the variables set in egress's environment: where the
   * values of http MCP headers live. Throws when egress cannot be reached or
   * answers anything else; the caller decides what an unknown list means.
   * The timeout is short because the worker asks on every 10 s heartbeat.
   */
  async envNames(timeoutMs = 3_000): Promise<string[]> {
    const res = await this.call('GET', '/env-names', undefined, timeoutMs);
    if (res.status !== 200) throw new Error(`egress GET /env-names answered ${res.status}`);
    return EnvNamesResponseSchema.parse(res.json).names;
  }

  /**
   * Egress's health answer, with the host forward when it has one. Null when
   * egress cannot be reached or answers anything else. The timeout is short
   * because the worker asks on every heartbeat.
   */
  async healthReport(timeoutMs = 3_000): Promise<EgressHealth | null> {
    try {
      const res = await this.call('GET', '/health', undefined, timeoutMs);
      if (res.status !== 200) return null;
      const parsed = EgressHealthSchema.safeParse(res.json);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async health(): Promise<boolean> {
    try {
      return (await this.call('GET', '/health')).status === 200;
    } catch {
      return false;
    }
  }
}
