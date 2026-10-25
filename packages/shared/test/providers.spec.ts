import { describe, expect, it } from 'vitest';
import {
  NOUS_STATUSES,
  NousLoginSchema,
  ProvidersResponseSchema,
  type NousLogin,
  type ProviderInfo,
} from '../src/contracts/index.js';

/** Shapes as the web fixtures build them (apps/web/src/fixtures/system.ts). */
const WAITING: NousLogin = {
  state: 'waiting_for_approval',
  userCode: 'K7QD-P2MX',
  verifyUrl: 'https://portal.nousresearch.com/device?user_code=K7QD-P2MX',
  expiresAt: '2026-10-24T15:37:52.000Z',
  error: null,
  billingUrl: null,
};

const ENDED: NousLogin = {
  state: 'failed',
  userCode: null,
  verifyUrl: null,
  expiresAt: null,
  error: 'Could not reach Nous Portal: connection timed out.',
  billingUrl: null,
};

const NOUS: ProviderInfo = {
  id: 'nous',
  name: 'Nous Portal',
  authMethod: 'oauth-device',
  status: 'waiting_for_approval',
  scope: null,
  envVar: null,
  applyCommand: null,
  hostCommand: 'hermes proxy start --provider nous',
  billingUrl: 'https://portal.nousresearch.com/billing',
  usedBy: ['baseline', 'with-skill', 'with-mcp'],
  pausedExperiments: 1,
  login: WAITING,
};

const OPENROUTER: ProviderInfo = {
  id: 'openrouter',
  name: 'OpenRouter',
  authMethod: 'env-key',
  status: 'missing',
  scope: null,
  envVar: 'OPENROUTER_API_KEY',
  applyCommand: 'docker compose up -d egress worker',
  hostCommand: null,
  billingUrl: null,
  usedBy: [],
  pausedExperiments: 0,
  login: null,
};

describe('ProvidersResponseSchema', () => {
  it('accepts the providers the web fixtures build, in every Nous status', () => {
    expect(ProvidersResponseSchema.parse([NOUS, OPENROUTER])).toEqual([NOUS, OPENROUTER]);
    for (const status of NOUS_STATUSES) {
      const nous = { ...NOUS, status, login: status === 'waiting_for_approval' ? WAITING : ENDED };
      expect(ProvidersResponseSchema.safeParse([nous]).success, status).toBe(true);
    }
    expect(NOUS_STATUSES).toContain('unavailable');
  });

  it('keeps each auth method to its own statuses', () => {
    const bad: [ProviderInfo, string][] = [
      [{ ...NOUS, status: 'configured' }, '0.status'],
      [{ ...OPENROUTER, status: 'connected' }, '0.status'],
      [{ ...OPENROUTER, login: ENDED }, '0.login'],
      [{ ...OPENROUTER, id: 'groq' as ProviderInfo['id'] }, '0.id'],
      [{ ...NOUS, pausedExperiments: -1 }, '0.pausedExperiments'],
    ];
    for (const [provider, path] of bad) {
      const result = ProvidersResponseSchema.safeParse([provider]);
      expect(result.success, path).toBe(false);
      expect(result.error!.issues.map((i) => i.path.join('.'))).toEqual([path]);
    }
  });
});

describe('NousLoginSchema', () => {
  it('carries the code, link and expiry exactly while waiting', () => {
    expect(NousLoginSchema.parse(WAITING)).toEqual(WAITING);
    expect(NousLoginSchema.parse(ENDED)).toEqual(ENDED);
    expect(NousLoginSchema.safeParse({ ...WAITING, userCode: null }).success).toBe(false);
    expect(NousLoginSchema.safeParse({ ...ENDED, verifyUrl: WAITING.verifyUrl }).success).toBe(
      false,
    );
    expect(NousLoginSchema.safeParse({ ...ENDED, state: 'unavailable' }).success).toBe(false);
  });
});
