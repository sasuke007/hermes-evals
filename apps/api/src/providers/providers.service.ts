/**
 * Model access (plan 6.1, UI_FLOWS 5.3 and 6): every provider's status, and
 * the Nous Portal device login, which this service relays to nous-login. The
 * API never sees a token: nous-login answers states, links and codes, and an
 * API-key provider is reported by the name of its variable only.
 */
import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, eq, or, sql } from 'drizzle-orm';
import {
  NousLoginSchema,
  ProvidersResponseSchema,
  type NousLogin,
  type Provider,
  type ProviderInfo,
} from '@hermes-evals/shared';
import { DB } from '../database/db.provider.js';
import { configurationVersions, configurations, experiments } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import { findLiveWorker } from '../queue/live-worker.js';
import {
  NOUS_LOGIN_CLIENT,
  NousLoginServiceError,
  NousLoginUnavailableError,
  type NousLoginClient,
} from './nous-login.client.js';
import { hostProxyOf } from './readiness.js';
import { providerRows } from './views.js';

/** POST /providers/nous/login in host mode: the containers cannot log a host process in. */
export const HOST_LOGIN_CONFLICT =
  "This stack uses this machine's Hermes login (NOUS_HOST_PROXY), so Nous Portal is not connected from here.";

/** A device login that is not running: what GET /providers/nous/login answers when nothing can be. */
const NO_LOGIN: NousLogin = {
  state: 'not_connected',
  userCode: null,
  verifyUrl: null,
  expiresAt: null,
  error: null,
  billingUrl: null,
};

@Injectable()
export class ProvidersService {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    @Inject(NOUS_LOGIN_CLIENT) private readonly nousLogin: NousLoginClient,
  ) {}

  /** GET /providers */
  async list(): Promise<ProviderInfo[]> {
    const worker = await findLiveWorker(this.db);
    const hostProxy = hostProxyOf(worker);
    const [usedBy, paused, nous] = await Promise.all([
      this.usedBy(),
      this.pausedByProvider(),
      // In host mode nous-login is not consulted (and need not run at all).
      hostProxy ? null : this.nousLogin.status(),
    ]);
    const rows = providerRows({
      usedBy,
      paused,
      egressEnvNames: worker?.egressEnvNames ?? null,
      hostProxy,
      nous,
    });
    return ProvidersResponseSchema.parse(rows);
  }

  /** POST /providers/nous/login: a new code, replacing a pending one. */
  async startLogin(): Promise<NousLogin> {
    if (hostProxyOf(await findLiveWorker(this.db))) {
      throw new ConflictException({ statusCode: 409, message: HOST_LOGIN_CONFLICT });
    }
    return this.relay(() => this.nousLogin.startLogin());
  }

  /** GET /providers/nous/login: polled every 2 s while waiting. Never fails for a missing service. */
  async getLogin(): Promise<NousLogin> {
    try {
      return NousLoginSchema.parse(await this.nousLogin.getLogin());
    } catch (err) {
      if (err instanceof NousLoginUnavailableError) return NO_LOGIN;
      throw this.translate(err);
    }
  }

  /** DELETE /providers/nous/login */
  cancelLogin(): Promise<NousLogin> {
    return this.relay(() => this.nousLogin.cancelLogin());
  }

  /** POST /providers/nous/logout */
  logout(): Promise<NousLogin> {
    return this.relay(() => this.nousLogin.logout());
  }

  private async relay(call: () => Promise<NousLogin>): Promise<NousLogin> {
    try {
      return NousLoginSchema.parse(await call());
    } catch (err) {
      throw this.translate(err);
    }
  }

  private translate(err: unknown): unknown {
    if (err instanceof NousLoginUnavailableError) {
      return new ServiceUnavailableException({
        statusCode: 503,
        message: `The Nous Portal login service is unavailable: ${err.reason}`,
      });
    }
    if (err instanceof NousLoginServiceError) {
      return new BadGatewayException({ statusCode: 502, message: err.message });
    }
    return err;
  }

  /** Configuration names by the provider of their latest version, sorted. */
  private async usedBy(): Promise<Map<Provider, string[]>> {
    const rows = await this.db
      .select({ name: configurations.name, provider: configurationVersions.provider })
      .from(configurations)
      .innerJoin(
        configurationVersions,
        and(
          eq(configurationVersions.configurationId, configurations.id),
          eq(configurationVersions.version, configurations.latestVersion),
        ),
      )
      .orderBy(configurations.name);
    const byProvider = new Map<Provider, string[]>();
    for (const row of rows)
      byProvider.set(row.provider, [...(byProvider.get(row.provider) ?? []), row.name]);
    return byProvider;
  }

  /** Experiments paused with provider_disconnected, counted under each provider they use. */
  private async pausedByProvider(): Promise<Map<Provider, number>> {
    const rows = await this.db
      .select({
        provider: configurationVersions.provider,
        count: sql<number>`count(distinct ${experiments.id})::int`,
      })
      .from(experiments)
      .innerJoin(
        configurationVersions,
        or(
          eq(configurationVersions.id, experiments.baselineVersionId),
          sql`${configurationVersions.id} = any(${experiments.candidateVersionIds})`,
        ),
      )
      .where(
        and(eq(experiments.status, 'paused'), eq(experiments.pauseReason, 'provider_disconnected')),
      )
      .groupBy(configurationVersions.provider);
    return new Map(rows.map((row) => [row.provider, row.count]));
  }
}
