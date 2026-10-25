/**
 * The HTTP client for nous-login (docker/nous-login.py, plan 6.1), the
 * service that runs Hermes's Nous Portal device login in the nous-home
 * volume. The API reaches it over the internal provider-admin network for
 * GET /providers and the four login routes; the worker reaches it for the
 * provider guard's status check (readiness.ts).
 *
 * Nothing secret crosses this client: nous-login answers only states, the
 * link, the user code, its expiry, the granted scope and messages. Every
 * answer is parsed, so a changed service fails here rather than reaching a
 * response half understood.
 *
 * `status()` never throws: an unreachable or misbehaving service is reported
 * as `unavailable` with the reason, which is what GET /providers shows.
 * `checkedStatus()` is the same call for the provider checks (readiness.ts):
 * it throws NousLoginUnreachableError when nous-login could not be reached
 * or understood, so "cannot check" is never read as "not connected", and
 * resolves `unavailable` only when nous-login itself answered it (its
 * startup check of the Hermes functions it calls failed). The login calls throw
 * NousLoginUnavailableError when the service cannot log in (its startup
 * check failed, or it cannot be reached) and NousLoginServiceError when it
 * answered something else unexpected.
 */
import { NousLoginSchema, type NousLogin } from '@hermes-evals/shared';
import { z } from 'zod';

/**
 * What the nous-login volume holds. `unavailable`: the service failed its
 * startup check of the Hermes functions it calls, cannot read the volume, or
 * cannot be reached.
 */
export const NOUS_VOLUME_STATES = [
  'not_connected',
  'connected',
  'relogin_required',
  'unavailable',
] as const;
export type NousVolumeState = (typeof NOUS_VOLUME_STATES)[number];

/** nous-login's GET /status. */
export const NousLoginStatusSchema = z.object({
  state: z.enum(NOUS_VOLUME_STATES),
  /** Granted scope while connected, e.g. `inference:invoke`. */
  scope: z.string().nullable(),
  relogin_required: z.boolean(),
  source: z.literal('volume'),
  /** Why the state is `unavailable`; null otherwise. */
  reason: z.string().nullable(),
  /** The portal the login runs against (HERMES_PORTAL_BASE_URL or Nous Portal). */
  portalUrl: z.string(),
  billingUrl: z.string(),
  /** The pending or last failed device login; null when none, or once it connected. */
  login: NousLoginSchema.nullable(),
});
export type NousLoginStatus = z.infer<typeof NousLoginStatusSchema>;

/** Injection token for the NousLoginClient (nous-login.module.ts provides it). */
export const NOUS_LOGIN_CLIENT = Symbol('NOUS_LOGIN_CLIENT');

/** nous-login's answer to a login route while it cannot log in. */
const UnavailableBodySchema = z.object({ state: z.literal('unavailable'), reason: z.string() });

/** Nous Portal's billing page, when nous-login cannot say which portal it uses. */
export const DEFAULT_NOUS_BILLING_URL = 'https://portal.nousresearch.com/billing';

/** nous-login cannot run a login now; `reason` says why, in words the UI can show. */
export class NousLoginUnavailableError extends Error {
  override readonly name = 'NousLoginUnavailableError';
  constructor(readonly reason: string) {
    super(`the Nous login service is unavailable: ${reason}`);
  }
}

/** nous-login answered, but not with what the contract says. */
export class NousLoginServiceError extends Error {
  override readonly name = 'NousLoginServiceError';
}

/** A status check reached no answer it could read: transport, timeout, HTTP status or shape. */
export class NousLoginUnreachableError extends Error {
  override readonly name = 'NousLoginUnreachableError';
}

/** Per-call limits. Status is polled by the UI and asked before claims, so it must be quick. */
export interface NousLoginTimeouts {
  statusMs: number;
  /** nous-login waits up to 30 s for the portal to issue a code. */
  startMs: number;
  /** Cancel and logout wait out a login that is being saved (up to 20 s there). */
  changeMs: number;
}

export const DEFAULT_NOUS_LOGIN_TIMEOUTS: NousLoginTimeouts = {
  statusMs: 2_000,
  startMs: 40_000,
  changeMs: 30_000,
};

const unavailableStatus = (reason: string): NousLoginStatus => ({
  state: 'unavailable',
  scope: null,
  relogin_required: false,
  source: 'volume',
  reason,
  portalUrl: '',
  billingUrl: DEFAULT_NOUS_BILLING_URL,
  login: null,
});

export class NousLoginClient {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly timeouts: NousLoginTimeouts = DEFAULT_NOUS_LOGIN_TIMEOUTS,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** The volume's state and the current login. Never throws. */
  async status(): Promise<NousLoginStatus> {
    try {
      return await this.checkedStatus();
    } catch (err) {
      return unavailableStatus((err as Error).message);
    }
  }

  /** As status(), but throws NousLoginUnreachableError when there is no answer to read. */
  async checkedStatus(): Promise<NousLoginStatus> {
    let res: { status: number; body: unknown };
    try {
      res = await this.call('GET', '/status', this.timeouts.statusMs);
    } catch (err) {
      throw new NousLoginUnreachableError((err as Error).message, { cause: err });
    }
    if (res.status !== 200) {
      throw new NousLoginUnreachableError(
        `nous-login answered HTTP ${res.status} to a status check`,
      );
    }
    const parsed = NousLoginStatusSchema.safeParse(res.body);
    if (!parsed.success) {
      throw new NousLoginUnreachableError('nous-login answered a status check in an unknown shape');
    }
    return parsed.data;
  }

  /** Start a login, replacing a pending one; answers once the portal issued a code or it ended. */
  startLogin(): Promise<NousLogin> {
    return this.loginCall('POST', '/login', this.timeouts.startMs);
  }

  getLogin(): Promise<NousLogin> {
    return this.loginCall('GET', '/login', this.timeouts.statusMs);
  }

  cancelLogin(): Promise<NousLogin> {
    return this.loginCall('DELETE', '/login', this.timeouts.changeMs);
  }

  /** Disconnect: what `hermes logout --provider nous` does, in the volume. */
  logout(): Promise<NousLogin> {
    return this.loginCall('POST', '/logout', this.timeouts.changeMs);
  }

  private async loginCall(method: string, path: string, timeoutMs: number): Promise<NousLogin> {
    let res: { status: number; body: unknown };
    try {
      res = await this.call(method, path, timeoutMs);
    } catch (err) {
      throw new NousLoginUnavailableError((err as Error).message);
    }
    if (res.status === 503) {
      const body = UnavailableBodySchema.safeParse(res.body);
      throw new NousLoginUnavailableError(
        body.success ? body.data.reason : 'nous-login answered HTTP 503',
      );
    }
    if (res.status !== 200) {
      const detail = z.object({ error: z.string() }).safeParse(res.body);
      throw new NousLoginServiceError(
        `nous-login answered HTTP ${res.status} to ${method} ${path}` +
          (detail.success ? `: ${detail.data.error}` : ''),
      );
    }
    const login = NousLoginSchema.safeParse(res.body);
    if (!login.success) {
      throw new NousLoginServiceError(`nous-login answered ${method} ${path} in an unknown shape`);
    }
    return login.data;
  }

  /** One request with a deadline; the error message names what failed, never a body. */
  private async call(
    method: string,
    path: string,
    timeoutMs: number,
  ): Promise<{ status: number; body: unknown }> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch (err) {
      const timedOut = (err as Error).name === 'TimeoutError';
      throw new Error(
        timedOut
          ? `nous-login did not answer within ${timeoutMs / 1000} s (${this.baseUrl})`
          : `nous-login is not reachable at ${this.baseUrl}`,
        { cause: err },
      );
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Left null: the status code says enough, and the shape check refuses it.
    }
    return { status: res.status, body };
  }
}
