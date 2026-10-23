/**
 * Live attempts and what each may do. The worker registers an attempt over
 * the admin socket before its trial starts and removes it when the trial
 * ends; removal returns the attempt's usage and connection log, which become
 * evidence in the run inspector.
 */
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const RegistrationSchema = z
  .object({
    token: z.string().min(32).max(128),
    /**
     * `allowlist`: only `allowHosts` (configured MCP http hosts). `public`: any
     * public host, for configurations that enable web or browser toolsets.
     */
    mode: z.enum(['allowlist', 'public']),
    allowHosts: z.array(z.string().min(1).max(253)).max(64).default([]),
    allowPorts: z.array(z.number().int().min(1).max(65_535)).max(16).default([443]),
    /** Model gateway upstream name, or null when the attempt makes no model calls. */
    provider: z.string().min(1).max(64).nullable(),
    /** Models the attempt may call; empty means any model the upstream serves. */
    models: z.array(z.string().min(1).max(200)).max(16).default([]),
    /** Stop serving model calls once this many tokens were used. */
    maxTokens: z.number().int().positive().optional(),
    /** Epoch milliseconds after which the token no longer works. */
    expiresAt: z.number().int().positive(),
  })
  .strict();
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
  kind: 'connect' | 'http' | 'model';
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
}

interface Entry {
  registration: Registration;
  usage: Usage;
  log: LogEntry[];
  tunnels: number;
}

const MAX_LOG = 2000;

const sameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export class Registry {
  private readonly attempts = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  register(attemptId: string, input: unknown): Registration {
    const registration = { ...RegistrationSchema.parse(input), attemptId };
    this.attempts.set(attemptId, {
      registration,
      usage: { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      log: [],
      tunnels: 0,
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

  get size(): number {
    return this.attempts.size;
  }
}
