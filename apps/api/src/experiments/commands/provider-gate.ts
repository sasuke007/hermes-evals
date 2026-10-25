/**
 * The provider check before every command that leads to a model call:
 * launch, Resume, Retry failed runs and Retry (plan 6.1 "Nudges", UI_FLOWS 7).
 * It asks providers/readiness.ts, the one rule the worker's provider guard
 * uses too, so the API never lets through what the worker would pause on.
 *
 * Readiness needs nous-login's local status, which the providers module
 * owns. It reaches this gate through the PROVIDER_READINESS_DEPS token, which
 * a global module provides (the API wires it to its nous-login client), so
 * the commands do not depend on how that client is built.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Provider } from '@hermes-evals/shared';
import { DB } from '../../database/db.provider.js';
import type { AppDb } from '../../database/types.js';
import {
  providerReadiness,
  type ProviderReadiness,
  type ProviderReadinessDeps,
} from '../../providers/readiness.js';

/** Injection token for ProviderReadinessDeps; provide it from a @Global() module. */
export const PROVIDER_READINESS_DEPS = Symbol('PROVIDER_READINESS_DEPS');

/** How refusals name a provider: "Retry needs Nous Portal". */
export const PROVIDER_NAMES: Record<Provider, string> = {
  nous: 'Nous Portal',
  'nous-api': 'the Nous API',
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  custom: 'the custom endpoint',
};

/** A provider that cannot serve runs now, with the sentence the UI shows. */
export interface ProviderBlock {
  provider: Provider;
  reason: string;
}

@Injectable()
export class ProviderGate {
  constructor(
    @Inject(DB) private readonly db: AppDb,
    @Inject(PROVIDER_READINESS_DEPS) private readonly deps: ProviderReadinessDeps,
  ) {}

  /** One provider's readiness. A check that throws counts as not ready, with why. */
  async readiness(provider: Provider): Promise<ProviderReadiness> {
    try {
      return await providerReadiness(this.db, provider, this.deps);
    } catch (err) {
      return {
        ready: false,
        status: provider === 'nous' ? 'unavailable' : 'missing',
        reason: `could not check ${PROVIDER_NAMES[provider]}: ${(err as Error).message}`,
      };
    }
  }

  /** The providers among `providers` that are not ready, each checked once, in the order given. */
  async blocked(providers: readonly Provider[]): Promise<ProviderBlock[]> {
    const blocks: ProviderBlock[] = [];
    // One at a time: the checks share the database client and are each a quick local read.
    for (const provider of new Set(providers)) {
      const answer = await this.readiness(provider);
      if (!answer.ready) {
        blocks.push({
          provider,
          reason: answer.reason ?? `${PROVIDER_NAMES[provider]} is not ready`,
        });
      }
    }
    return blocks;
  }
}

/** The 409 message for blocked providers: their reasons, as the launch panel shows them. */
export const blockedMessage = (blocks: readonly ProviderBlock[]): string =>
  blocks.map((b) => b.reason).join('; ');
