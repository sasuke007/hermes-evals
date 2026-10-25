import { ProvidersResponseSchema, type Provider } from '@hermes-evals/shared';
import { describe, expect, it } from 'vitest';
import { endedLogin, FakeNousLogin, waitingLogin } from './fake-nous-login.support-spec.js';
import type { NousLoginStatus } from './nous-login.client.js';
import { nousDisplayStatus, providerRows, type ProviderFacts } from './views.js';

const status = (fake: FakeNousLogin): NousLoginStatus => fake.status();

const facts = (over: Partial<ProviderFacts> = {}): ProviderFacts => ({
  usedBy: new Map<Provider, string[]>([['nous', ['baseline', 'with-skill']]]),
  paused: new Map<Provider, number>([['nous', 1]]),
  egressEnvNames: ['OPENROUTER_API_KEY'],
  hostProxy: null,
  nous: new FakeNousLogin().status(),
  ...over,
});

describe('nousDisplayStatus', () => {
  it('shows the volume, a waiting login over it, and a failed attempt only while nothing works', () => {
    const fake = new FakeNousLogin();
    expect(nousDisplayStatus(status(fake))).toBe('not_connected');
    fake.login = waitingLogin();
    expect(nousDisplayStatus(status(fake))).toBe('waiting_for_approval');
    fake.login = endedLogin('denied');
    expect(nousDisplayStatus(status(fake))).toBe('denied');
    fake.login = endedLogin('needs_subscription');
    expect(nousDisplayStatus(status(fake))).toBe('needs_subscription');
    fake.volume = 'connected';
    // A reconnect that failed leaves the working login in charge.
    expect(nousDisplayStatus(status(fake))).toBe('connected');
    fake.login = waitingLogin();
    expect(nousDisplayStatus(status(fake))).toBe('waiting_for_approval');
    fake.volume = 'relogin_required';
    fake.login = null;
    expect(nousDisplayStatus(status(fake))).toBe('relogin_required');
    fake.unavailable = 'missing function';
    expect(nousDisplayStatus(status(fake))).toBe('unavailable');
  });
});

describe('providerRows', () => {
  it('lists Nous and the four key providers, by presence only', () => {
    const rows = ProvidersResponseSchema.parse(providerRows(facts()));
    expect(rows.map((r) => [r.id, r.status])).toEqual([
      ['nous', 'not_connected'],
      ['openrouter', 'configured'],
      ['nous-api', 'missing'],
      ['openai', 'missing'],
      ['anthropic', 'missing'],
    ]);
    expect(rows[0]).toMatchObject({
      name: 'Nous Portal',
      authMethod: 'oauth-device',
      usedBy: ['baseline', 'with-skill'],
      pausedExperiments: 1,
      billingUrl: 'http://portal.test/billing',
      hostCommand: null,
      login: null,
    });
    expect(rows[1]).toMatchObject({
      name: 'OpenRouter',
      authMethod: 'env-key',
      envVar: 'OPENROUTER_API_KEY',
      applyCommand: 'docker compose up -d egress worker',
      login: null,
    });
  });

  it('shows the scope and the login only as nous-login gives them', () => {
    const fake = new FakeNousLogin();
    fake.approve();
    const [connected] = providerRows(facts({ nous: fake.status() }));
    expect(connected).toMatchObject({
      status: 'connected',
      scope: 'inference:invoke',
      login: null,
    });
    fake.login = waitingLogin();
    const [waiting] = providerRows(facts({ nous: fake.status() }));
    expect(waiting).toMatchObject({ status: 'waiting_for_approval', scope: null });
    expect(waiting!.login?.userCode).toBe('FAKE-0001');
  });

  it('reports the host login in host mode, with the command, and no device login', () => {
    const hostProxy = { target: 'host.lima.internal:8645', reachable: false, checked_at: '' };
    const [row] = ProvidersResponseSchema.parse(providerRows(facts({ hostProxy, nous: null })));
    expect(row).toMatchObject({
      status: 'host_unreachable',
      hostCommand: 'hermes proxy start --provider nous',
      login: null,
      billingUrl: 'https://portal.nousresearch.com/billing',
    });
    const [up] = providerRows(facts({ hostProxy: { ...hostProxy, reachable: true }, nous: null }));
    expect(up!.status).toBe('host');
  });

  it('lists the custom endpoint only when a configuration uses it, and as configured', () => {
    expect(providerRows(facts()).some((r) => r.id === 'custom')).toBe(false);
    const usedBy = new Map<Provider, string[]>([['custom', ['mock-arm']]]);
    const rows = ProvidersResponseSchema.parse(
      providerRows(facts({ usedBy, egressEnvNames: null })),
    );
    expect(rows.at(-1)).toMatchObject({
      id: 'custom',
      name: 'Custom endpoint',
      status: 'configured',
      envVar: 'CUSTOM_API_KEY',
      usedBy: ['mock-arm'],
      pausedExperiments: 0,
    });
    // No live worker: nobody can say a key is there.
    expect(rows.find((r) => r.id === 'openrouter')!.status).toBe('missing');
  });
});
