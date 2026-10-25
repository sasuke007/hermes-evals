/**
 * Model access (plan section 6.1, UI_FLOWS 5.3 and 6): every provider's
 * status and the Nous Portal device login. The platform never sees a token:
 * a login is only a user code, a link, an expiry and a state, and an API-key
 * provider reports presence only.
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { PROVIDERS } from '../vocab.js';
import { countView, isoTimeView } from './common.js';

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
  /**
   * nous-login's startup check found the Hermes login functions it calls
   * missing or changed, so it cannot log in (UI_FLOWS 19 #12).
   */
  'unavailable',
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

/**
 * GET and POST /providers/nous/login. A waiting login carries its code, link
 * and expiry; an ended one carries none of them.
 */
export const NousLoginSchema = z
  .object({
    state: z.enum(NOUS_LOGIN_STATES),
    /** Short code the user checks in Nous Portal, e.g. K7QD-P2MX. */
    userCode: z.string().nullable(),
    /** Nous Portal link that already carries the code. */
    verifyUrl: z.string().nullable(),
    /** ISO 8601. The code is valid for 15 minutes. */
    expiresAt: isoTimeView.nullable(),
    /** Human message for `failed`, e.g. "Could not reach Nous Portal: connection timed out." */
    error: z.string().nullable(),
    /** Nous Portal billing page, for `needs_subscription`. */
    billingUrl: z.string().nullable(),
  })
  .superRefine((login, ctx) => {
    const waiting = login.state === 'waiting_for_approval';
    for (const key of ['userCode', 'verifyUrl', 'expiresAt'] as const) {
      if (waiting !== (login[key] !== null)) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is set exactly while the login waits for approval`,
        });
      }
    }
  });
export type NousLogin = z.infer<typeof NousLoginSchema>;

/** One provider of System → Model access. */
export const ProviderInfoSchema = z
  .object({
    /** The configuration `provider` value: 'nous', 'openrouter', … */
    id: z.enum(PROVIDERS),
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
    pausedExperiments: countView,
    /** The pending or last device login (Nous only). */
    login: NousLoginSchema.nullable(),
  })
  .superRefine((p, ctx) => {
    const statuses: readonly string[] =
      p.authMethod === 'oauth-device' ? NOUS_STATUSES : KEY_PROVIDER_STATUSES;
    if (!statuses.includes(p.status)) {
      ctx.addIssue({
        code: 'custom',
        path: ['status'],
        message: `a ${p.authMethod} provider reports one of ${statuses.join(', ')}`,
      });
    }
    if (p.authMethod === 'env-key' && p.login !== null) {
      ctx.addIssue({ code: 'custom', path: ['login'], message: 'only a device login has one' });
    }
  });
export type ProviderInfo = z.infer<typeof ProviderInfoSchema>;

/** GET /providers. */
export const ProvidersResponseSchema = z.array(ProviderInfoSchema);
