/**
 * Model access, sandbox and worker contracts (plan section 6.1 and section 11).
 * The live API will validate against these schemas; fixtures are typed by them.
 * The platform never sees a token: a login is only a user code, a link, an expiry and a state.
 */
import { z } from 'zod';

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

// ── Sandbox ──────────────────────────────────────────────────────────────

export const SandboxCheckSchema = z.object({
  /** Stable id, e.g. "no-default-route". */
  id: z.string(),
  /** Plain-English claim: "has no default route". */
  name: z.string(),
  passed: z.boolean(),
  /** Evidence line: "ip route → no default route", or the failure. */
  detail: z.string(),
});
export type SandboxCheck = z.infer<typeof SandboxCheckSchema>;

export const SandboxStatusSchema = z.object({
  proven: z.boolean(),
  /** The 15 isolation checks in their fixed order. */
  checks: z.array(SandboxCheckSchema),
  /** ISO 8601 time of the self-test. */
  checkedAt: z.string(),
  /** What ran it: "worker start". */
  trigger: z.string(),
  /** Hermes revision: "hermes-agent v0.22.4 @ 4d04303". */
  revision: z.string(),
  /** Image tag: "nousresearch/hermes-agent:v0.22.4". */
  image: z.string(),
  /** Image digest (may be shortened for display): "sha256:7a6920…". */
  digest: z.string(),
  /** Command that re-runs the self-test. */
  selftestCommand: z.string(),
});
export type SandboxStatus = z.infer<typeof SandboxStatusSchema>;

// ── Workers and the running summary ──────────────────────────────────────

export const WorkerSchema = z.object({
  id: z.string(),
  status: z.enum(['online', 'offline']),
  /** ISO 8601. A worker heartbeats every 5 s; none for 60 s means it is gone. */
  lastHeartbeatAt: z.string(),
  concurrency: z.number().int().nonnegative(),
  slotsInUse: z.number().int().nonnegative().nullable(),
  slotsTotal: z.number().int().nonnegative().nullable(),
  sandboxProven: z.boolean(),
});
export type Worker = z.infer<typeof WorkerSchema>;

export const RunningExperimentSchema = z.object({
  id: z.string(),
  name: z.string(),
  scored: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});
export type RunningExperiment = z.infer<typeof RunningExperimentSchema>;

export const RunningSummarySchema = z.object({
  count: z.number().int().nonnegative(),
  scored: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  experiments: z.array(RunningExperimentSchema),
});
export type RunningSummary = z.infer<typeof RunningSummarySchema>;

/** GET /system/summary (plan section 11), trimmed to what the shell and System use. */
export const SystemSummarySchema = z.object({
  running: RunningSummarySchema,
  workers: z.array(WorkerSchema),
  /** Queued runs waiting for a worker (shown when no worker is connected). */
  queuedRuns: z.number().int().nonnegative(),
});
export type SystemSummary = z.infer<typeof SystemSummarySchema>;

/** A worker counts as present when online with a heartbeat in the last 60 s. */
export const WORKER_TIMEOUT_MS = 60_000;
