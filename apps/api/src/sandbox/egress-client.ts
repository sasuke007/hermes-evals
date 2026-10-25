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
import { adminSocketCall, EgressCallError, refusalMessage } from './admin-socket-call.js';

export { EgressCallError, type EgressFailure } from './admin-socket-call.js';

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

// ---------------------------------------------------------------------------
// The LLM judge's path (Phase 3 S2): EgressClient implements it over
// egress's admin socket (apps/egress/src/judge-path.ts).
// ---------------------------------------------------------------------------

/**
 * A judge registration: what one llm_judge key may call, registered just
 * before its call and removed in `finally`, like an attempt but narrower.
 * Kind judge: the judge model only, no MCP routes, no CONNECT, no token
 * (nothing outside the admin socket can use it). Egress forwards with the
 * model gateway's own code, so provider keys and the Nous login never
 * leave egress and nous-proxy.
 */
export interface EgressJudgeRegistration {
  kind: 'judge';
  /** Model gateway upstream name (ProviderRoute.upstream of the judge's provider). */
  provider: string;
  /** For provider `custom` only, and required for it: JUDGE_BASE_URL. */
  upstream?: { baseUrl: string };
  /** The one model this registration may call; a call naming another is refused. */
  model: string;
  /** Stop serving once this many tokens were used (a judge call needs a few thousand). */
  maxTokens?: number;
  /** Epoch milliseconds after which egress drops the registration by itself. */
  expiresAt: number;
}

/**
 * The chat completion body the judge sends, as OpenAI's API takes it.
 * Egress adds the upstream's credentials and body defaults, never the caller.
 */
export interface EgressJudgeChatBody {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  temperature: number;
  max_tokens: number;
  response_format?: { type: string; [key: string]: unknown };
  stream?: false;
}

/** One judge call's answer, as egress relayed it. */
export interface EgressJudgeReply {
  /** The upstream's HTTP status, or egress's own when it refused or could not forward. */
  status: number;
  /** The answer's JSON body (a chat completion, or an error object); null when it had none. */
  body: unknown;
  /** This call's usage as egress metered it; null when the upstream reported none. */
  usage: EgressUsage | null;
}

/** What a judge registration used and did, returned when it is removed. */
export interface EgressJudgeReport {
  usage: EgressUsage;
  log: EgressLogEntry[];
}

/**
 * The judge's path on the admin socket. `judgeId` is a fresh ULID per
 * registration (database/ids.ts newId), so it never names an attempt.
 */
export interface EgressJudgeApi {
  /** Registers before the call. Rejects when egress refuses the registration. */
  registerJudge(judgeId: string, registration: EgressJudgeRegistration): Promise<void>;
  /**
   * Forwards one chat completion. Resolves whatever status the upstream or
   * egress answered (the caller decides on retry); rejects only when the
   * socket fails, the timeout passes or `signal` aborts.
   */
  judgeComplete(
    judgeId: string,
    body: EgressJudgeChatBody,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<EgressJudgeReply>;
  /** Removes the registration; its usage and connection log, or null when egress did not have it. */
  removeJudge(judgeId: string): Promise<EgressJudgeReport | null>;
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
const EgressUsageSchema = z.object({
  calls: count,
  promptTokens: count,
  completionTokens: count,
  totalTokens: count,
}) satisfies z.ZodType<EgressUsage>;

const EgressReportSchema = z.object({
  usage: EgressUsageSchema,
  log: z.array(EgressLogEntrySchema),
});

/**
 * POST /judges/:id/chat/completions's answer when an upstream answered: its
 * status, its JSON body (null when it sent none) and this call's usage.
 */
const EgressJudgeReplySchema = z
  .object({
    status: z.number().int().min(100).max(599),
    body: z.unknown(),
    usage: EgressUsageSchema.nullable(),
  })
  .strict();

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

export class EgressClient implements EgressJudgeApi {
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

  /** Registers one judge call (PUT /judges/:id). Rejects with `refused` when egress says no. */
  async registerJudge(judgeId: string, registration: EgressJudgeRegistration): Promise<void> {
    const res = await adminSocketCall(this.socketPath, 'PUT', `/judges/${judgeId}`, registration, {
      timeoutMs: 10_000,
    });
    if (res.status !== 204) {
      throw new EgressCallError(
        'refused',
        `egress refused the judge registration (${res.status}): ${refusalMessage(res.json)}`,
        res.status,
      );
    }
  }

  /**
   * Forwards one judge chat completion. An upstream's answer comes back as
   * egress relayed it; egress's own refusal (an unknown or expired
   * registration, another model, the token cap, an upstream it cannot reach)
   * as that status and body, with no usage. Rejects only on the socket, the
   * timeout, the signal or an answer it cannot read.
   */
  async judgeComplete(
    judgeId: string,
    body: EgressJudgeChatBody,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<EgressJudgeReply> {
    const path = `/judges/${judgeId}/chat/completions`;
    const res = await adminSocketCall(this.socketPath, 'POST', path, body, options);
    if (res.status !== 200) return { status: res.status, body: res.json, usage: null };
    const reply = EgressJudgeReplySchema.safeParse(res.json);
    if (!reply.success) {
      throw new EgressCallError('protocol', `egress POST ${path} answered in an unknown shape`);
    }
    return { status: reply.data.status, body: reply.data.body ?? null, usage: reply.data.usage };
  }

  /** Removes a judge registration (DELETE /judges/:id): its usage and log, or null when egress had none. */
  async removeJudge(judgeId: string): Promise<EgressJudgeReport | null> {
    const path = `/judges/${judgeId}`;
    const res = await adminSocketCall(this.socketPath, 'DELETE', path, undefined, {
      timeoutMs: 10_000,
    });
    if (res.status === 404) return null;
    if (res.status !== 200) {
      throw new EgressCallError(
        'refused',
        `egress DELETE ${path} answered ${res.status}: ${refusalMessage(res.json)}`,
        res.status,
      );
    }
    const report = EgressReportSchema.safeParse(res.json);
    if (!report.success) {
      throw new EgressCallError('protocol', `egress DELETE ${path} answered in an unknown shape`);
    }
    return report.data;
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
