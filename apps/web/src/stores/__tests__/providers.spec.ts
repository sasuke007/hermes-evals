import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import * as api from '@/api/providers';
import { formatCountdown, useProvidersStore, type FollowUpAction } from '@/stores/providers';
import { setVisibility, useScenario } from './scenarioEnv';

vi.mock('@/api/providers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/providers')>();
  return {
    ...actual,
    getNousLogin: vi.fn<typeof actual.getNousLogin>(actual.getNousLogin),
    startNousLogin: vi.fn<typeof actual.startNousLogin>(actual.startNousLogin),
  };
});

const getNousLogin = vi.mocked(api.getNousLogin);
const startNousLogin = vi.mocked(api.startNousLogin);

async function setup(scenario: string | null) {
  useScenario(scenario);
  setActivePinia(createPinia());
  const store = useProvidersStore();
  await store.load();
  return store;
}

/** Start a login from a page and wait for the code. */
async function connected(store: ReturnType<typeof useProvidersStore>, ...args: unknown[]) {
  const pending = store.connect(...(args as Parameters<typeof store.connect>));
  await pending;
  await flushPromises();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-24T15:00:00Z'));
  setVisibility('visible');
  getNousLogin.mockClear();
  startNousLogin.mockClear();
});
afterEach(() => {
  useProvidersStore().dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('providers store: statuses and flags', () => {
  it('is healthy when Nous Portal is connected (default scenario)', async () => {
    const store = await setup(null);
    expect(store.nousStatus).toBe('connected');
    expect(store.nousConnected).toBe(true);
    expect(store.anyConnected).toBe(true);
    expect(store.needsAttention).toBe(false);
    expect(store.bannerKind).toBe('none');
    expect(store.approvalLeft).toBeNull();
    expect(store.providers.map((p) => p.name)).toEqual(['Nous Portal', 'OpenRouter']);
  });

  it('raises nothing before the first answer', () => {
    useScenario('nous-not-connected');
    setActivePinia(createPinia());
    const store = useProvidersStore();
    expect(store.bannerKind).toBe('none');
    expect(store.needsAttention).toBe(false);
  });

  it('flags not connected: banner, attention', async () => {
    const store = await setup('nous-not-connected');
    expect(store.nousStatus).toBe('not_connected');
    expect(store.bannerKind).toBe('not-connected');
    expect(store.needsAttention).toBe(true);
    expect(store.anyConnected).toBe(false);
  });

  it('flags a login that needs renewing, with the paused count', async () => {
    const store = await setup('nous-renewal');
    expect(store.bannerKind).toBe('renewal');
    expect(store.needsAttention).toBe(true);
    expect(store.pausedCount).toBe(1);
  });

  it.each([
    ['nous-expired', 'expired'],
    ['nous-declined', 'denied'],
    ['nous-subscription', 'needs_subscription'],
    ['nous-failed', 'failed'],
    ['nous-host-down', 'host_unreachable'],
  ])('%s needs attention and shows the not-connected banner', async (scenario, status) => {
    const store = await setup(scenario);
    expect(store.nousStatus).toBe(status);
    expect(store.needsAttention).toBe(true);
    expect(store.bannerKind).toBe('not-connected');
  });

  it('treats the development login as connected', async () => {
    const store = await setup('nous-host');
    expect(store.nousStatus).toBe('host');
    expect(store.nousConnected).toBe(true);
    expect(store.needsAttention).toBe(false);
    expect(store.bannerKind).toBe('none');
  });

  it('counts a configured API key as a connected provider', async () => {
    const store = await setup('nous-not-connected,openrouter-configured');
    expect(store.anyConnected).toBe(true);
    // Nous is still used by every configuration, so it still needs attention.
    expect(store.bannerKind).toBe('not-connected');
  });

  it('formats the countdown as m:ss', () => {
    expect(formatCountdown(892)).toBe('14:52');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(-3)).toBe('0:00');
  });
});

describe('providers store: the Nous login', () => {
  it('requests a code, then waits with K7QD-P2MX and 15 minutes', async () => {
    const store = await setup('nous-not-connected');
    const pending = store.connect('new-experiment');
    expect(store.dialogOpen).toBe(true);
    expect(store.loginPhase).toBe('requesting');
    expect(store.nousStatus).toBe('waiting_for_approval');
    await pending;
    expect(store.loginPhase).toBe('waiting');
    expect(store.userCode).toBe('K7QD-P2MX');
    expect(store.verifyUrl).toContain('K7QD-P2MX');
    expect(store.countdown).toBe('15:00');
    expect(store.dialogHeading).toBe('Connect Nous Portal');
  });

  it('counts down and polls every 2 s while waiting', async () => {
    const store = await setup('nous-not-connected');
    await connected(store, 'other');
    getNousLogin.mockClear();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(getNousLogin).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getNousLogin).toHaveBeenCalledTimes(3);
    expect(store.countdown).toBe('14:54');
    expect(store.loginPhase).toBe('waiting');
  });

  it('pauses polling while the page is hidden and polls on return', async () => {
    const store = await setup('nous-not-connected');
    await connected(store, 'other');
    getNousLogin.mockClear();

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getNousLogin).not.toHaveBeenCalled();

    setVisibility('visible');
    await flushPromises();
    expect(getNousLogin).toHaveBeenCalledTimes(1);
    expect(store.countdown).toBe('14:50');
  });

  it('keeps the login going when the dialog closes, with the ApprovalPill countdown', async () => {
    const store = await setup('nous-not-connected');
    await connected(store, 'other');
    expect(store.approvalLeft).toBeNull();

    store.closeDialog();
    expect(store.loginPhase).toBe('waiting');
    expect(store.approvalLeft).toBe('15:00');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(store.approvalLeft).toBe('13:59');

    await store.openDialog();
    expect(store.dialogOpen).toBe(true);
    expect(store.approvalLeft).toBeNull();
    expect(store.loginPhase).toBe('waiting');
  });

  it('reopens a waiting login instead of starting another', async () => {
    const store = await setup('nous-not-connected');
    await connected(store, 'other');
    const startSpy = vi.spyOn(store, 'retry');
    store.closeDialog();
    await store.connect('new-experiment');
    expect(store.loginPhase).toBe('waiting');
    expect(store.origin).toBe('new-experiment');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('picks up a login already waiting (nous-waiting): pill at 14:52', async () => {
    const store = await setup('nous-waiting');
    expect(store.loginPhase).toBe('waiting');
    expect(store.dialogOpen).toBe(false);
    expect(store.approvalLeft).toBe('14:52');
    expect(store.bannerKind).toBe('not-connected');
  });

  it('connects on approval and hands the follow-up to the opener', async () => {
    const store = await setup('nous-not-connected');
    const onFollowUp = vi.fn<(action: FollowUpAction) => void>();
    await connected(store, 'new-experiment', onFollowUp, { experimentName: 'Skill vs no skill' });

    store.simulate('approve');
    await flushPromises();
    expect(store.loginPhase).toBe('connected');
    expect(store.nousConnected).toBe(true);
    expect(store.bannerKind).toBe('none');
    expect(onFollowUp).not.toHaveBeenCalled();

    store.followUp('launch');
    expect(onFollowUp).toHaveBeenCalledWith('launch');
    expect(store.dialogOpen).toBe(false);
    expect(store.loginPhase).toBe('idle');
  });

  it('resolves by itself under a nous-login-approve scenario, found by polling', async () => {
    const store = await setup('nous-not-connected,nous-login-approve');
    await connected(store, 'other');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(store.loginPhase).toBe('waiting');
    await vi.advanceTimersByTimeAsync(2_000);
    await flushPromises();
    expect(store.loginPhase).toBe('connected');
  });

  it('expires when the code runs out', async () => {
    const store = await setup('nous-not-connected,nous-login-expire');
    await connected(store, 'other');
    expect(store.countdown).toBe('0:10');
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(store.loginPhase).toBe('expired');
    expect(store.nousStatus).toBe('expired');
    expect(store.userCode).toBeNull();
  });

  it.each([
    ['decline', 'declined', 'denied'],
    ['subscription', 'subscription', 'needs_subscription'],
    ['fail', 'failed', 'failed'],
    ['expire', 'expired', 'expired'],
  ] as const)('ends as %s', async (outcome, phase, status) => {
    const store = await setup('nous-not-connected');
    await connected(store, 'other');
    store.simulate(outcome);
    await flushPromises();
    expect(store.loginPhase).toBe(phase);
    expect(store.nousStatus).toBe(status);
    expect(store.needsAttention).toBe(true);
  });

  it('keeps the reason of a failed login', async () => {
    const store = await setup('nous-not-connected');
    await connected(store, 'other');
    store.simulate('fail');
    await flushPromises();
    expect(store.loginError).toBe('Could not reach Nous Portal: connection timed out.');
  });

  it('keeps the billing link of a login without a subscription', async () => {
    const store = await setup('nous-not-connected');
    await connected(store, 'other');
    store.simulate('subscription');
    await flushPromises();
    expect(store.billingUrl).toContain('billing');
  });

  it('gets a new code after an end state, keeping the origin', async () => {
    const store = await setup('nous-not-connected');
    const onFollowUp = vi.fn<(action: FollowUpAction) => void>();
    await connected(store, 'paused-experiment', onFollowUp);
    store.simulate('expire');
    await flushPromises();
    await store.retry();
    expect(store.loginPhase).toBe('waiting');
    expect(store.origin).toBe('paused-experiment');
    store.simulate('approve');
    await flushPromises();
    store.followUp('resume');
    expect(onFollowUp).toHaveBeenCalledWith('resume');
  });

  it('cancels a waiting login and goes back to not connected', async () => {
    const store = await setup('nous-not-connected');
    await connected(store, 'other');
    await store.cancel();
    expect(store.loginPhase).toBe('idle');
    expect(store.dialogOpen).toBe(false);
    expect(store.nousStatus).toBe('not_connected');
    getNousLogin.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getNousLogin).not.toHaveBeenCalled();
  });

  it('forgets an ended login when the dialog closes', async () => {
    const store = await setup('nous-not-connected');
    await connected(store, 'other');
    store.simulate('decline');
    await flushPromises();
    store.closeDialog();
    expect(store.loginPhase).toBe('idle');
    expect(store.nousStatus).toBe('denied');
  });

  it('shows the outcome in the row when the login ends with the dialog closed', async () => {
    const store = await setup('nous-not-connected');
    await connected(store, 'other');
    store.closeDialog();
    store.simulate('approve');
    await flushPromises();
    expect(store.loginPhase).toBe('idle');
    expect(store.dialogOpen).toBe(false);
    expect(store.nousStatus).toBe('connected');
    expect(store.approvalLeft).toBeNull();
  });

  it('reads "Reconnect" for a renewal and for a paused experiment', async () => {
    const renewal = await setup('nous-renewal');
    await connected(renewal, 'other');
    expect(renewal.dialogHeading).toBe('Reconnect Nous Portal');
    renewal.dispose();

    const paused = await setup('nous-not-connected');
    await connected(paused, 'paused-experiment');
    expect(paused.dialogHeading).toBe('Reconnect Nous Portal');
  });

  it('offers the follow-up at once when already connected', async () => {
    const store = await setup(null);
    const onFollowUp = vi.fn<(action: FollowUpAction) => void>();
    await store.connect('new-experiment', onFollowUp);
    expect(store.loginPhase).toBe('connected');
    store.followUp('back');
    expect(onFollowUp).toHaveBeenCalledWith('back');
  });

  it('disconnects', async () => {
    const store = await setup(null);
    await store.disconnect();
    expect(store.nousStatus).toBe('not_connected');
    expect(store.bannerKind).toBe('not-connected');
  });
});

describe('providers store: when Nous cannot be connected from the UI', () => {
  it.each([
    ['nous-host-down', 'host_unreachable'],
    ['nous-unavailable', 'unavailable'],
  ])('%s: Connect opens the manual step and asks the API for nothing', async (scenario, status) => {
    const store = await setup(scenario);
    expect(store.nousStatus).toBe(status);
    expect(store.nousManualOnly).toBe(true);
    await store.connect('new-experiment');
    expect(store.dialogOpen).toBe(true);
    expect(store.loginPhase).toBe('manual');
    await store.retry();
    expect(store.loginPhase).toBe('manual');
    expect(startNousLogin).not.toHaveBeenCalled();

    store.closeDialog();
    expect(store.loginPhase).toBe('idle');
    expect(store.approvalLeft).toBeNull();
  });

  it('the development login is connected, not manual', async () => {
    const store = await setup('nous-host');
    expect(store.nousManualOnly).toBe(false);
    await store.connect('other');
    expect(store.loginPhase).toBe('connected');
    expect(startNousLogin).not.toHaveBeenCalled();
  });
});

describe('providers store: the setup card above the experiment list', () => {
  it('asks for nothing while connected, and for a connection while nothing is', async () => {
    expect((await setup(null)).setupVariant).toBe('none');
    useProvidersStore().dispose();
    expect((await setup('nous-not-connected')).setupVariant).toBe('connect');
  });

  it('asks for nothing before the first answer', () => {
    useScenario('nous-not-connected');
    setActivePinia(createPinia());
    expect(useProvidersStore().setupVariant).toBe('none');
  });

  it('asks for the key when every provider in use is a key provider without one', async () => {
    const store = await setup('openrouter-in-use');
    expect(store.usedProviders.map((p) => p.id)).toEqual(['openrouter']);
    expect(store.setupVariant).toBe('missing-key');
    expect(store.setupKeyProvider?.envVar).toBe('OPENROUTER_API_KEY');
    expect(store.bannerKind).toBe('no-key');
  });

  it('a configured key or a connected Nous among the providers in use is enough', async () => {
    const store = await setup('openrouter-in-use,openrouter-configured');
    expect(store.setupVariant).toBe('none');
  });
});
