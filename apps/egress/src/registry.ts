/**
 * Live attempts and what each may do. The worker registers an attempt over
 * the admin socket before its trial starts and removes it when the trial
 * ends; removal returns the attempt's usage and connection log, which become
 * evidence in the run inspector.
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ENV_NAME_PATTERN } from './env-names.js';

/** The upstream name whose base URL comes with each registration instead of MODEL_UPSTREAMS. */
export const CUSTOM_UPSTREAM = 'custom';

/**
 * Provider credentials egress holds for the model gateway. An MCP route may
 * not name one as a header variable: a definition must never be able to make
 * egress send a provider key to a URL it chose. Main adds the apiKeyEnv of
 * every configured upstream.
 */
export const PROVIDER_KEY_ENV_NAMES: readonly string[] = [
  'NOUS_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CUSTOM_API_KEY',
];

/**
 * Headers a route may not set: the hop-by-hop ones, and those that frame or
 * address the request (Host, Content-Length). The same list the shared MCP
 * definition schema refuses when a definition is saved (RESERVED_HEADERS
 * and mcpRouteProblems in packages/shared contracts/resources.ts), so a
 * definition that saves also registers.
 */
export const REFUSED_ROUTE_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** MCP server names: the shared slug rule, which makes a safe single path segment. */
const ROUTE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/**
 * The attempt token travels as `Bearer <token>` and as the password of the
 * proxy's Basic credentials, so it may hold no space and no colon.
 */
const TOKEN = /^[A-Za-z0-9._~+/=-]+$/;

/** An absolute http(s) URL with a host and no user:password@ (egress adds credentials). */
function isPlainHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

const HttpUrlSchema = z
  .string()
  .max(2048)
  .refine(isPlainHttpUrl, 'must be an http(s) URL without user:password@');

const McpRouteSchema = z
  .object({
    /** The gateway path segment: `/mcp/<name>`. */
    name: z.string().regex(ROUTE_NAME),
    /** The definition's exact URL; requests go there and nowhere else. */
    url: HttpUrlSchema,
    /** Headers egress adds, each value read from its own environment variable `env`. */
    headers: z
      .array(
        z
          .object({
            header: z.string().regex(HEADER_NAME),
            env: z.string().regex(ENV_NAME_PATTERN),
          })
          .strict(),
      )
      .max(32)
      .default([]),
  })
  .strict()
  .superRefine((route, ctx) => {
    const names = route.headers.map((h) => h.header.toLowerCase());
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', path: ['headers'], message: 'header names must not repeat' });
    }
    const refused = names.filter((name) => REFUSED_ROUTE_HEADERS.has(name));
    if (refused.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message: `egress does not let a route set ${refused.join(', ')}`,
      });
    }
  });
export type McpRoute = z.output<typeof McpRouteSchema>;

export const RegistrationSchema = z
  .object({
    /**
     * The attempt's secret. The forward proxy checks it as proxy credentials;
     * the model and MCP gateways check it as `Authorization: Bearer <token>`.
     */
    token: z.string().min(32).max(128).regex(TOKEN, 'a token holds no space or colon'),
    /**
     * `allowlist`: only `allowHosts`, which the platform keeps empty, so CONNECT
     * refuses every host and the trial reaches only the model and MCP
     * gateways. `public`: any public host, for configurations that enable web
     * or browser toolsets.
     */
    mode: z.enum(['allowlist', 'public']),
    allowHosts: z.array(z.string().min(1).max(253)).max(64).default([]),
    allowPorts: z.array(z.number().int().min(1).max(65_535)).max(16).default([443]),
    /** Model gateway upstream name, or null when the attempt makes no model calls. */
    provider: z.string().min(1).max(64).nullable(),
    /**
     * Provider `custom` only, and required for it: the configuration's own
     * base URL. It may be a private address, because the configuration
     * chooses it and the agent cannot.
     */
    upstream: z.object({ baseUrl: HttpUrlSchema }).strict().optional(),
    /** Models the attempt may call; empty means any model the upstream serves. */
    models: z.array(z.string().min(1).max(200)).max(16).default([]),
    /** Stop serving model calls once this many tokens were used. */
    maxTokens: z.number().int().positive().optional(),
    /** Epoch milliseconds after which the token no longer works. */
    expiresAt: z.number().int().positive(),
    /** http MCP servers the attempt reaches through the MCP gateway. */
    mcp: z.array(McpRouteSchema).max(32).default([]),
  })
  .strict()
  .superRefine((r, ctx) => {
    if ((r.provider === CUSTOM_UPSTREAM) !== (r.upstream !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['upstream'],
        message: `upstream is given exactly when provider is ${CUSTOM_UPSTREAM}`,
      });
    }
    const names = r.mcp.map((route) => route.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', path: ['mcp'], message: 'MCP route names must not repeat' });
    }
  });
export type RegistrationInput = z.input<typeof RegistrationSchema>;
export type Registration = z.output<typeof RegistrationSchema> & { attemptId: string };

export interface Usage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LogEntry {
  at: string;
  /** `mcp`: a call through the MCP gateway, with `server` and `method` set. */
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

interface Entry {
  registration: Registration;
  usage: Usage;
  log: LogEntry[];
  tunnels: number;
  mcpCalls: number;
  modelCalls: number;
}

export interface RegistryOptions {
  /** Upstream credential variables, refused as MCP header variables like PROVIDER_KEY_ENV_NAMES. */
  credentialEnvNames?: Iterable<string>;
  /**
   * Egress's environment, read when an attempt registers: a route whose
   * header variable is missing or empty there is refused, so the worker ends
   * the attempt as `setup` naming it before any container exists, instead of
   * a run whose every MCP call answers 503 being scored as if it had its
   * server. Egress's environment cannot change while an attempt is
   * registered (a restart drops every registration). Main passes
   * process.env; without it routes are not checked, as in tests of the
   * gateway's own handling of a missing value.
   */
  env?: () => NodeJS.ProcessEnv;
}

const listOf = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

const MAX_LOG = 2000;

/**
 * How long a registration is kept after it expires. Its token is refused from
 * expiresAt on, but a worker that removes the attempt late still collects its
 * usage and connection log. After this it is dropped: an attempt whose worker
 * died is never removed (recovery ends it in the database only), and would
 * otherwise stay in memory, with up to MAX_LOG log entries, for the life of
 * the process.
 */
export const EXPIRED_RETENTION_MS = 10 * 60_000;

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export class Registry {
  private readonly attempts = new Map<string, Entry>();
  private readonly credentialEnvNames: ReadonlySet<string>;
  private readonly env: (() => NodeJS.ProcessEnv) | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    options: RegistryOptions = {},
  ) {
    this.credentialEnvNames = new Set([
      ...PROVIDER_KEY_ENV_NAMES,
      ...(options.credentialEnvNames ?? []),
    ]);
    this.env = options.env;
  }

  /** Validates and stores a registration; throws (ZodError or Error) when it is refused. */
  register(attemptId: string, input: unknown): Registration {
    this.prune();
    const registration = { ...RegistrationSchema.parse(input), attemptId };
    const credentials = registration.mcp.flatMap((route) =>
      route.headers.filter((h) => this.credentialEnvNames.has(h.env)).map((h) => h.env),
    );
    if (credentials.length > 0) {
      const names = [...new Set(credentials)].join(', ');
      throw new Error(
        `mcp: ${names} holds a provider credential; egress never sends it to an MCP server`,
      );
    }
    if (this.env) {
      const env = this.env();
      const missing = [
        ...new Set(registration.mcp.flatMap((route) => route.headers.map((h) => h.env))),
      ].filter((name) => !env[name]);
      if (missing.length > 0) {
        throw new Error(
          `mcp: ${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} not set in egress's ` +
            'environment; the MCP servers that use them cannot start',
        );
      }
    }
    this.attempts.set(attemptId, {
      registration,
      usage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      log: [],
      tunnels: 0,
      mcpCalls: 0,
      modelCalls: 0,
    });
    return registration;
  }

  remove(attemptId: string): { usage: Usage; log: LogEntry[] } | null {
    const entry = this.attempts.get(attemptId);
    if (!entry) return null;
    this.attempts.delete(attemptId);
    return { usage: entry.usage, log: entry.log };
  }

  get(
    attemptId: string,
  ): { registration: Omit<Registration, 'token'>; usage: Usage; log: LogEntry[] } | null {
    const entry = this.attempts.get(attemptId);
    if (!entry) return null;
    const { token: _token, ...registration } = entry.registration;
    return { registration, usage: entry.usage, log: entry.log };
  }

  /** The live registration for an attempt id and token, or null. */
  authenticate(attemptId: string, token: string): Registration | null {
    const entry = this.attempts.get(attemptId);
    if (!entry || !sameSecret(entry.registration.token, token)) return null;
    if (entry.registration.expiresAt <= this.now()) return null;
    return entry.registration;
  }

  /** The live registration that owns a bearer token, or null. */
  byToken(token: string): Registration | null {
    for (const entry of this.attempts.values()) {
      if (sameSecret(entry.registration.token, token)) {
        return entry.registration.expiresAt > this.now() ? entry.registration : null;
      }
    }
    return null;
  }

  usage(attemptId: string): Usage | null {
    return this.attempts.get(attemptId)?.usage ?? null;
  }

  addUsage(attemptId: string, usage: Partial<Usage>): void {
    const entry = this.attempts.get(attemptId);
    if (!entry) return;
    entry.usage.calls += usage.calls ?? 0;
    entry.usage.promptTokens += usage.promptTokens ?? 0;
    entry.usage.completionTokens += usage.completionTokens ?? 0;
    entry.usage.totalTokens += usage.totalTokens ?? 0;
  }

  log(attemptId: string, entry: Omit<LogEntry, 'at'>): void {
    const target = this.attempts.get(attemptId);
    if (!target || target.log.length >= MAX_LOG) return;
    target.log.push({ at: new Date(this.now()).toISOString(), ...entry });
  }

  /** Reserves a tunnel slot; false when the attempt already has `max` open. */
  openTunnel(attemptId: string, max: number): boolean {
    const entry = this.attempts.get(attemptId);
    if (!entry || entry.tunnels >= max) return false;
    entry.tunnels += 1;
    return true;
  }

  closeTunnel(attemptId: string): void {
    const entry = this.attempts.get(attemptId);
    if (entry && entry.tunnels > 0) entry.tunnels -= 1;
  }

  /** Reserves one in-flight MCP gateway call; false when the attempt already has `max`. */
  openMcpCall(attemptId: string, max: number): boolean {
    const entry = this.attempts.get(attemptId);
    if (!entry || entry.mcpCalls >= max) return false;
    entry.mcpCalls += 1;
    return true;
  }

  closeMcpCall(attemptId: string): void {
    const entry = this.attempts.get(attemptId);
    if (entry && entry.mcpCalls > 0) entry.mcpCalls -= 1;
  }

  /** Reserves one in-flight model gateway call; false when the attempt already has `max`. */
  openModelCall(attemptId: string, max: number): boolean {
    const entry = this.attempts.get(attemptId);
    if (!entry || entry.modelCalls >= max) return false;
    entry.modelCalls += 1;
    return true;
  }

  closeModelCall(attemptId: string): void {
    const entry = this.attempts.get(attemptId);
    if (entry && entry.modelCalls > 0) entry.modelCalls -= 1;
  }

  /** Model gateway calls the attempt has in flight now. */
  modelCallsInFlight(attemptId: string): number {
    return this.attempts.get(attemptId)?.modelCalls ?? 0;
  }

  /** Registrations whose token is still honoured: what /health reports as `attempts`. */
  get size(): number {
    this.prune();
    const now = this.now();
    let live = 0;
    for (const entry of this.attempts.values()) if (entry.registration.expiresAt > now) live += 1;
    return live;
  }

  /** Drops registrations that expired more than EXPIRED_RETENTION_MS ago. */
  private prune(): void {
    const cutoff = this.now() - EXPIRED_RETENTION_MS;
    for (const [attemptId, entry] of this.attempts) {
      if (entry.registration.expiresAt <= cutoff) this.attempts.delete(attemptId);
    }
  }
}
