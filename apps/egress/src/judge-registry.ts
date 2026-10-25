/**
 * Live LLM judge registrations (Phase 3 S2). The worker grades llm_judge
 * keys with a model, and its calls must reach the provider the way an
 * agent's do, with egress's credentials, without the worker holding any.
 * The worker has no TCP route to egress, so each judge call is registered
 * here over the admin socket just before it is made, forwarded by the admin
 * socket's judge path (judge-path.ts), and removed in the worker's
 * `finally`, which returns its usage and connection log.
 *
 * A judge registration is narrower than an attempt's: one model, no MCP
 * routes, no CONNECT, no token (nothing but the admin socket can use it), and
 * a short life (at most JUDGE_MAX_LIFETIME_MS). Kept apart from the attempt
 * registry, so a judge id can never authenticate on the trial-facing gateway
 * or proxy, and an attempt id can never be used as a judge.
 */
import { z } from 'zod';
import { CUSTOM_UPSTREAM, HttpUrlSchema, type LogEntry, type Usage } from './registry.js';

/** Longest a judge registration may live: a judge call and its one retry take minutes, not hours. */
export const JUDGE_MAX_LIFETIME_MS = 10 * 60_000;

/** How long an expired judge registration is kept for a late remove before it is dropped. */
export const JUDGE_EXPIRED_RETENTION_MS = 2 * 60_000;

/** Judge registrations held at once; a worker grades a handful of keys at a time. */
export const MAX_JUDGE_REGISTRATIONS = 256;

/** Calls one judge registration may have in flight: the call, and a retry racing its abort. */
export const MAX_JUDGE_CALLS_IN_FLIGHT = 2;

const MAX_JUDGE_LOG = 32;

/**
 * Fields only an attempt registration has, each refused with the reason
 * rather than as an unknown key, so the worker's error says what it asked for.
 */
const ATTEMPT_ONLY_FIELDS: Readonly<Record<string, string>> = {
  mcp: 'a judge registration reaches no MCP server',
  mode: 'a judge registration makes no CONNECT',
  allowHosts: 'a judge registration makes no CONNECT',
  allowPorts: 'a judge registration makes no CONNECT',
  token: 'a judge registration has no token: only the admin socket can use it',
  models: 'a judge registration names exactly one model, as `model`',
};

export const JudgeRegistrationSchema = z
  .object({
    kind: z.literal('judge'),
    /** Model gateway upstream name: a MODEL_UPSTREAMS key, or `custom`. */
    provider: z.string().min(1).max(64),
    /** For `custom` only, and required for it: the judge's own base URL (JUDGE_BASE_URL). */
    upstream: z.object({ baseUrl: HttpUrlSchema }).strict().optional(),
    /** The one model this registration may call. */
    model: z.string().min(1).max(200),
    /** Stop serving once this many tokens were used; egress's default cap otherwise. */
    maxTokens: z.number().int().positive().optional(),
    /** Epoch milliseconds; within JUDGE_MAX_LIFETIME_MS of registering. */
    expiresAt: z.number().int().positive(),
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
  });
export type JudgeRegistration = z.output<typeof JudgeRegistrationSchema> & { judgeId: string };

/** Why a judge registration was refused, with the admin status that says so. */
export class JudgeRegistrationError extends Error {
  override readonly name = 'JudgeRegistrationError';
  constructor(
    message: string,
    readonly status: 400 | 409 | 503 = 400,
  ) {
    super(message);
  }
}

interface JudgeEntry {
  registration: JudgeRegistration;
  usage: Usage;
  log: LogEntry[];
  calls: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class JudgeRegistry {
  private readonly judges = new Map<string, JudgeEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Validates and stores a registration. Throws a ZodError for a malformed
   * one and a JudgeRegistrationError for one egress will not hold.
   */
  register(judgeId: string, input: unknown): JudgeRegistration {
    this.prune();
    if (isRecord(input)) {
      const asked = Object.keys(ATTEMPT_ONLY_FIELDS).filter((field) => field in input);
      if (asked.length > 0) {
        const reasons = [...new Set(asked.map((field) => ATTEMPT_ONLY_FIELDS[field]))];
        throw new JudgeRegistrationError(`${asked.join(', ')}: ${reasons.join('; ')}`);
      }
    }
    const registration = { ...JudgeRegistrationSchema.parse(input), judgeId };
    const now = this.now();
    if (registration.expiresAt <= now) {
      throw new JudgeRegistrationError('expiresAt: the registration has already expired');
    }
    if (registration.expiresAt > now + JUDGE_MAX_LIFETIME_MS) {
      throw new JudgeRegistrationError(
        `expiresAt: a judge registration lives at most ${JUDGE_MAX_LIFETIME_MS / 60_000} minutes`,
      );
    }
    if (this.judges.has(judgeId)) {
      throw new JudgeRegistrationError(`judge ${judgeId} is already registered`, 409);
    }
    if (this.judges.size >= MAX_JUDGE_REGISTRATIONS) {
      throw new JudgeRegistrationError(
        `egress already holds ${MAX_JUDGE_REGISTRATIONS} judge registrations`,
        503,
      );
    }
    this.judges.set(judgeId, {
      registration,
      usage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      log: [],
      calls: 0,
    });
    return registration;
  }

  /** The registration if it is held and not expired; `expired` when held but past expiresAt. */
  live(judgeId: string): JudgeRegistration | 'expired' | null {
    const entry = this.judges.get(judgeId);
    if (!entry) return null;
    return entry.registration.expiresAt > this.now() ? entry.registration : 'expired';
  }

  get(judgeId: string): { registration: JudgeRegistration; usage: Usage; log: LogEntry[] } | null {
    const entry = this.judges.get(judgeId);
    return entry ? { registration: entry.registration, usage: entry.usage, log: entry.log } : null;
  }

  remove(judgeId: string): { usage: Usage; log: LogEntry[] } | null {
    const entry = this.judges.get(judgeId);
    if (!entry) return null;
    this.judges.delete(judgeId);
    return { usage: entry.usage, log: entry.log };
  }

  usage(judgeId: string): Usage | null {
    return this.judges.get(judgeId)?.usage ?? null;
  }

  addUsage(judgeId: string, usage: Usage): void {
    const entry = this.judges.get(judgeId);
    if (!entry) return;
    entry.usage.calls += usage.calls;
    entry.usage.promptTokens += usage.promptTokens;
    entry.usage.completionTokens += usage.completionTokens;
    entry.usage.totalTokens += usage.totalTokens;
  }

  log(judgeId: string, entry: Omit<LogEntry, 'at'>): void {
    const target = this.judges.get(judgeId);
    if (!target || target.log.length >= MAX_JUDGE_LOG) return;
    target.log.push({ at: new Date(this.now()).toISOString(), ...entry });
  }

  /** Reserves an in-flight call; false when the registration already has the maximum. */
  openCall(judgeId: string): boolean {
    const entry = this.judges.get(judgeId);
    if (!entry || entry.calls >= MAX_JUDGE_CALLS_IN_FLIGHT) return false;
    entry.calls += 1;
    return true;
  }

  closeCall(judgeId: string): void {
    const entry = this.judges.get(judgeId);
    if (entry && entry.calls > 0) entry.calls -= 1;
  }

  /** Registrations not yet expired: what /health reports as `judges`. */
  get size(): number {
    this.prune();
    const now = this.now();
    let live = 0;
    for (const entry of this.judges.values()) if (entry.registration.expiresAt > now) live += 1;
    return live;
  }

  /**
   * Drops registrations that expired more than JUDGE_EXPIRED_RETENTION_MS
   * ago: a worker that died between register and remove never removes its.
   */
  private prune(): void {
    const cutoff = this.now() - JUDGE_EXPIRED_RETENTION_MS;
    for (const [judgeId, entry] of this.judges) {
      if (entry.registration.expiresAt <= cutoff) this.judges.delete(judgeId);
    }
  }
}
