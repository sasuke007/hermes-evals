import { describe, expect, it } from 'vitest';
import { isReservedEnvName, PROVIDER_KEY_ENV_NAMES, PROVIDERS } from '@hermes-evals/shared';
import {
  ATTEMPT_TOKEN_ENV,
  egressModelAccess,
  hermesModelArgs,
  hermesModelConfig,
  isBackgroundHost,
  MCP_GATEWAY_HEADERS,
  MODEL_GATEWAY_BASE_URL,
  PROVIDER_ROUTES,
  providerRoute,
} from './providers-map.js';

describe('PROVIDER_ROUTES', () => {
  it('routes every platform provider, each to its own egress upstream', () => {
    expect(Object.keys(PROVIDER_ROUTES).sort()).toEqual([...PROVIDERS].sort());
    const upstreams = PROVIDERS.map((p) => providerRoute(p).upstream);
    expect(new Set(upstreams).size).toBe(PROVIDERS.length);
    for (const provider of PROVIDERS) expect(providerRoute(provider).provider).toBe(provider);
  });

  it('launches Hermes only with the ids verified to speak Chat Completions through the gateway', () => {
    expect(Object.fromEntries(PROVIDERS.map((p) => [p, providerRoute(p).hermesProvider]))).toEqual({
      nous: 'nous',
      'nous-api': 'nous',
      openrouter: 'openrouter',
      openai: 'custom',
      anthropic: 'custom',
      custom: 'custom',
    });
  });

  it('keeps every upstream key a reserved credential name that no MCP definition can use', () => {
    for (const provider of PROVIDERS) {
      const { apiKeyEnv } = providerRoute(provider);
      if (apiKeyEnv === null) continue;
      expect(PROVIDER_KEY_ENV_NAMES as readonly string[]).toContain(apiKeyEnv);
      expect(isReservedEnvName(apiKeyEnv)).toBe(true);
    }
  });

  it('marks only Hermes nous routes as making the credits-seed call', () => {
    for (const provider of PROVIDERS) {
      const route = providerRoute(provider);
      expect(route.creditsSeed, provider).toBe(route.hermesProvider === 'nous');
      expect(route.backgroundHosts.length > 0, provider).toBe(route.creditsSeed);
    }
    expect(isBackgroundHost('nous', 'Inference-API.nousresearch.com')).toBe(true);
    expect(isBackgroundHost('openrouter', 'inference-api.nousresearch.com')).toBe(false);
    expect(isBackgroundHost('nous', undefined)).toBe(false);
  });
});

describe('launch flags and config', () => {
  it('always points Hermes at the gateway with the attempt token', () => {
    expect(hermesModelArgs('anthropic', 'claude-x', 'tok')).toEqual([
      '--provider',
      'custom',
      '-m',
      'claude-x',
      '--base-url',
      'http://egress:8080/v1',
      '--api-key',
      'tok',
    ]);
    expect(hermesModelConfig('nous-api', 'm')).toEqual({
      default: 'm',
      provider: 'nous',
      base_url: MODEL_GATEWAY_BASE_URL,
      context_length: 131_072,
    });
  });

  it('gives http MCP servers a header that references the token, never holds it', () => {
    expect(MCP_GATEWAY_HEADERS).toEqual({ Authorization: 'Bearer ${HERMES_EVALS_ATTEMPT_TOKEN}' });
    expect(ATTEMPT_TOKEN_ENV).toBe('HERMES_EVALS_ATTEMPT_TOKEN');
    expect(isReservedEnvName(ATTEMPT_TOKEN_ENV)).toBe(true);
    expect(Object.isFrozen(MCP_GATEWAY_HEADERS)).toBe(true);
  });
});

describe('egressModelAccess', () => {
  it('names the upstream and model, and registers custom with its own base URL', () => {
    expect(egressModelAccess({ provider: 'openrouter', model: 'a/b', baseUrl: null })).toEqual({
      provider: 'openrouter',
      models: ['a/b'],
    });
    expect(
      egressModelAccess({
        provider: 'custom',
        model: 'mock/scripted',
        baseUrl: 'http://mock-model:8090/v1',
      }),
    ).toEqual({
      provider: 'custom',
      models: ['mock/scripted'],
      upstream: { baseUrl: 'http://mock-model:8090/v1' },
    });
    expect(() => egressModelAccess({ provider: 'custom', model: 'm', baseUrl: null })).toThrow(
      /base URL/,
    );
  });
});
