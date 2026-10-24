/**
 * Model access, sandbox and worker contracts (plan section 6.1 and section 11).
 * The live API will validate against these schemas; fixtures are typed by them.
 * The platform never sees a token: a login is only a user code, a link, an expiry and a state.
 *
 * The sandbox, worker and running-summary schemas live in @hermes-evals/shared
 * and are re-exported here. Model access moves there with the providers API (Phase 2).
 */
import { z } from 'zod';

export {
  RunningExperimentSchema,
  RunningSummarySchema,
  SandboxCheckSchema,
  SandboxStatusSchema,
  SystemSummarySchema,
  WORKER_TIMEOUT_MS,
  WorkerSchema,
} from '@hermes-evals/shared';
export type {
  RunningExperiment,
  RunningSummary,
  SandboxCheck,
  SandboxStatus,
  SystemSummary,
  Worker,
} from '@hermes-evals/shared';

// ── Providers ────────────────────────────────────────────────────────────

/** Nous Portal status as GET /providers reports it (plan 6.1 login states, plus the host proxy). */
export const NOUS_STATUSES = [
  'not_connected',
  'waiting_for_approval',
  'connected',
  'relogin_required',
  'expired',
  'denied',
  'needs_subscription',
  'failed',
  /** NOUS_HOST_PROXY is set: this machine's Hermes login is used (development). */
  'host',
  /** NOUS_HOST_PROXY is set but `hermes proxy start` is not answering. */
  'host_unreachable',
] as const;
export type NousStatus = (typeof NOUS_STATUSES)[number];

/** API-key providers report presence only; the value never leaves the server. */
export const KEY_PROVIDER_STATUSES = ['configured', 'missing'] as const;
export type KeyProviderStatus = (typeof KEY_PROVIDER_STATUSES)[number];

export const PROVIDER_STATUSES = [...NOUS_STATUSES, ...KEY_PROVIDER_STATUSES] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const AUTH_METHODS = ['oauth-device', 'env-key'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** State of the Nous device login (GET/POST /providers/nous/login). */
export const NOUS_LOGIN_STATES = [
  'not_connected',
  'waiting_for_approval',
  'connected',
  'expired',
  'denied',
  'needs_subscription',
  'failed',
] as const;
export type NousLoginState = (typeof NOUS_LOGIN_STATES)[number];

export const NousLoginSchema = z.object({
  state: z.enum(NOUS_LOGIN_STATES),
  /** Short code the user checks in Nous Portal, e.g. K7QD-P2MX. */
  userCode: z.string().nullable(),
  /** Nous Portal link that already carries the code. */
  verifyUrl: z.string().nullable(),
  /** ISO 8601. The code is valid for 15 minutes. */
  expiresAt: z.string().nullable(),
  /** Human message for `failed`, e.g. "Could not reach Nous Portal: connection timed out." */
  error: z.string().nullable(),
  /** Nous Portal billing page, for `needs_subscription`. */
  billingUrl: z.string().nullable(),
});
export type NousLogin = z.infer<typeof NousLoginSchema>;

export const ProviderInfoSchema = z.object({
  /** 'nous' | 'openrouter' | … (the configuration `provider` value). */
  id: z.string(),
  /** Display name: Nous Portal, OpenRouter. */
  name: z.string(),
  authMethod: z.enum(AUTH_METHODS),
  status: z.enum(PROVIDER_STATUSES),
  /** Granted scope when connected, e.g. "inference". */
  scope: z.string().nullable(),
  /** The environment variable an API-key provider reads, e.g. OPENROUTER_API_KEY. */
  envVar: z.string().nullable(),
  /** Command that applies a changed .env, e.g. `docker compose up -d egress worker`. */
  applyCommand: z.string().nullable(),
  /** Command that starts the host proxy for `host_unreachable`. */
  hostCommand: z.string().nullable(),
  billingUrl: z.string().nullable(),
  /** Names of the configurations that use this provider. */
  usedBy: z.array(z.string()),
  /** Experiments paused with reason provider_disconnected because of this provider. */
  pausedExperiments: z.number().int().nonnegative(),
  /** The pending or last device login (Nous only). */
  login: NousLoginSchema.nullable(),
});
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

export const ProvidersResponseSchema = z.array(ProviderInfoSchema);
