import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import BlockedReason from '@/components/model-access/BlockedReason.vue';
import ProviderNotice from '@/components/model-access/ProviderNotice.vue';
import ProviderStatusRow from '@/components/model-access/ProviderStatusRow.vue';
import SandboxCheckList from '@/components/model-access/SandboxCheckList.vue';
import SetupCard from '@/components/model-access/SetupCard.vue';
import { sandboxFixture } from '@/fixtures/system';
import { useProvidersStore, type FollowUpAction } from '@/stores/providers';
import { useScenario } from '@/stores/__tests__/scenarioEnv';

const Blank = defineComponent({ render: () => h('div') });
let wrapper: VueWrapper | null = null;

async function storeFor(scenario: string | null) {
  useScenario(scenario);
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useProvidersStore();
  await store.load();
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/:p(.*)*', component: Blank }],
  });
  return { store, global: { plugins: [pinia, router] } };
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  useProvidersStore().dispose();
  vi.unstubAllGlobals();
});

describe('ProviderStatusRow (grid)', () => {
  async function row(scenario: string | null, id = 'nous') {
    const { store, global } = await storeFor(scenario);
    const provider = store.providers.find((p) => p.id === id)!;
    wrapper = mount(ProviderStatusRow, {
      props: { provider, layout: 'grid' },
      global,
      attachTo: document.body,
    });
    return { store, w: wrapper };
  }
  const actions = () => wrapper!.findAll('.psr-actions .btn').map((b) => b.text());

  it.each([
    [
      'nous-not-connected',
      'not connected',
      'Connect once; every experiment that uses Nous Portal can then run.',
      ['Connect Nous Portal'],
    ],
    ['nous-waiting', 'waiting', 'Code K7QD-P2MX · 14:52 left', ['Open dialog', 'Cancel']],
    [null, 'connected', 'Signed in · scope inference', ['Disconnect']],
    [
      'nous-renewal',
      'reconnect',
      'Nous Portal ended this login. Experiments that use it are paused until you reconnect.',
      ['Reconnect'],
    ],
    ['nous-expired', 'expired', 'The code expired before it was approved.', ['Get a new code']],
    ['nous-declined', 'declined', 'The login was declined in Nous Portal.', ['Try again']],
    [
      'nous-subscription',
      'subscription',
      'This Nous account has no active subscription.',
      ['Open Nous Portal billing ↗'],
    ],
    ['nous-failed', 'error', 'Could not reach Nous Portal: connection timed out.', ['Try again']],
    [
      'nous-host',
      'this machine',
      "Using this machine's Hermes login (development). Set by NOUS_HOST_PROXY in .env.",
      [],
    ],
    [
      'nous-host-down',
      'not running',
      "This stack uses this machine's Hermes login, but its proxy is not running. Start it in a terminal:",
      [],
    ],
  ])('%s → %s', async (scenario, chip, detail, buttons) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-24T15:00:00Z'));
    await row(scenario);
    expect(wrapper!.find('.status-chip').text()).toBe(chip);
    expect(wrapper!.find('.psr-detail').text()).toContain(detail);
    expect(actions()).toEqual(buttons);
    expect(wrapper!.find('input').exists()).toBe(false);
    vi.useRealTimers();
  });

  it('shows the host proxy command to copy when the proxy is down', async () => {
    await row('nous-host-down');
    expect(wrapper!.find('.cmd code').text()).toBe('hermes proxy start --provider nous');
    expect(wrapper!.find('.cmd button').attributes('aria-label')).toBe('Copy command');
    expect(wrapper!.find('.psr-actions').text()).toContain('copy the command');
  });

  it('asks before disconnecting, Keep connected takes focus', async () => {
    const { store } = await row(null);
    await wrapper!.find('.psr-actions button').trigger('click');
    const group = wrapper!.find('[role="group"][aria-label="Confirm disconnect"]');
    expect(group.text()).toContain('Disconnect Nous Portal?');
    expect(group.text()).toContain('Running experiments that use it will pause.');
    expect(document.activeElement?.textContent?.trim()).toBe('Keep connected');
    await group.findAll('button')[0]!.trigger('click');
    await flushPromises();
    expect(store.nousStatus).toBe('not_connected');
  });

  it('Connect opens the dialog from origin other', async () => {
    const { store } = await row('nous-not-connected');
    await wrapper!.find('.psr-actions button').trigger('click');
    await flushPromises();
    expect(store.dialogOpen).toBe(true);
    expect(store.origin).toBe('other');
  });

  it('OpenRouter missing: steps and a copy button, never a key field', async () => {
    await row(null, 'openrouter');
    expect(wrapper!.find('.status-chip').text()).toBe('missing');
    expect(wrapper!.text()).toContain('OPENROUTER_API_KEY=…');
    expect(wrapper!.find('button[aria-label="Copy command"]').text()).toContain('Copy command');
    expect(wrapper!.find('input').exists()).toBe(false);
  });
});

describe('ProviderStatusRow (table)', () => {
  it('renders System table rows and the confirm row', async () => {
    const { store, global } = await storeFor(null);
    const Table = defineComponent({
      setup() {
        return () =>
          h('table', [
            h(
              'tbody',
              store.providers.map((p) =>
                h(ProviderStatusRow, { provider: p, layout: 'table', key: p.id }),
              ),
            ),
          ]);
      },
    });
    wrapper = mount(Table, { global, attachTo: document.body });
    const rows = wrapper.findAll('tr.psr-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.findAll('td')).toHaveLength(5);
    expect(rows[1]!.text()).toContain(
      'No input here: keys are never accepted or stored in the UI.',
    );
    expect(rows[1]!.find('.cmd code').text()).toBe('docker compose up -d egress worker');
    await rows[0]!.find('button').trigger('click');
    expect(wrapper.find('tr.psr-confirm-row td').attributes('colspan')).toBe('5');
  });
});

describe('SandboxCheckList', () => {
  it('collapses to the summary when every check passes', () => {
    useScenario(null);
    wrapper = mount(SandboxCheckList, { props: { status: sandboxFixture() } });
    expect(wrapper.find('.status-chip').text()).toBe('proven');
    expect(wrapper.text()).toContain(
      'Isolation proven · 15 of 15 checks · checked 2 min ago at worker start',
    );
    expect(wrapper.findAll('li.chk')).toHaveLength(0);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    const toggle = wrapper.find('button[aria-expanded]');
    expect(toggle.text()).toBe('Show 15 checks');
    expect(toggle.attributes('aria-expanded')).toBe('false');
  });

  it('expands to all 15 on request', async () => {
    useScenario(null);
    wrapper = mount(SandboxCheckList, { props: { status: sandboxFixture() } });
    await wrapper.find('button[aria-expanded]').trigger('click');
    const rows = wrapper.findAll('li.chk');
    expect(rows).toHaveLength(15);
    expect(rows[0]!.text()).toContain('01 runs as an unprivileged user (uid 10000)');
    expect(rows[4]!.text()).toContain('ip route → no default route');
    expect(wrapper.find('button[aria-expanded]').text()).toBe('Hide checks');
  });

  it('lists failing checks, disables execution and names the self-test', async () => {
    useScenario('sandbox-failed');
    wrapper = mount(SandboxCheckList, { props: { status: sandboxFixture() } });
    expect(wrapper.find('.status-chip').text()).toBe('not proven');
    expect(wrapper.find('[role="alert"]').text()).toContain(
      'Execution is disabled: 2 of 15 isolation checks failed. No run will start until every check passes.',
    );
    expect(wrapper.find('[role="alert"] code').text()).toBe(
      'docker compose exec worker node dist/sandbox-cli.js selftest',
    );
    expect(wrapper.text()).toContain('Isolation not proven · 13 of 15 checks');
    // Expanded by default when failing; collapsing still keeps the failures.
    expect(wrapper.findAll('li.chk')).toHaveLength(15);
    await wrapper.find('button[aria-expanded]').trigger('click');
    const failing = wrapper.findAll('li.chk');
    expect(failing).toHaveLength(2);
    expect(failing[0]!.find('[role="img"]').attributes('aria-label')).toBe('failed');
    expect(failing[0]!.text()).toContain('192.168.5.2:22 open');
    expect(failing[1]!.text()).toContain('10.0.4.7:5432 reachable');
    expect(wrapper.find('button[aria-expanded]').text()).toBe('Show all 15 checks');
  });
});

describe('BlockedReason', () => {
  it('disables the control and describes it with the visible reason', async () => {
    const { store, global } = await storeFor('nous-not-connected');
    const onFollowUp = vi.fn<(action: FollowUpAction) => void>();
    wrapper = mount(BlockedReason, {
      props: {
        reason: "Can't launch yet: Nous Portal is not connected.",
        fixLabel: 'Connect',
        connectOrigin: 'new-experiment',
        'onFollow-up': onFollowUp,
      },
      slots: {
        default: `<template #default="{ attrs }"><button class="btn primary" v-bind="attrs">Launch 120 runs</button></template>`,
      },
      global,
    });
    const control = wrapper.find('button.btn.primary');
    const reason = wrapper.find('.blocked-reason');
    expect(control.attributes('disabled')).toBeDefined();
    expect(control.attributes('title')).toBe("Can't launch yet: Nous Portal is not connected.");
    expect(control.attributes('aria-describedby')).toBe(reason.attributes('id'));
    expect(reason.text()).toBe("Can't launch yet: Nous Portal is not connected. Connect");

    await reason.find('button').trigger('click');
    await flushPromises();
    expect(store.dialogOpen).toBe(true);
    expect(store.origin).toBe('new-experiment');
    store.simulate('approve');
    await flushPromises();
    store.followUp('launch');
    expect(onFollowUp).toHaveBeenCalledWith('launch');
  });

  it('renders the control enabled and no reason when not blocked', async () => {
    const { global } = await storeFor(null);
    wrapper = mount(BlockedReason, {
      props: { reason: 'Connect Nous Portal first', blocked: false },
      slots: {
        default: `<template #default="{ attrs }"><button class="btn" v-bind="attrs">Resume</button></template>`,
      },
      global,
    });
    expect(wrapper.find('button').attributes('disabled')).toBeUndefined();
    expect(wrapper.find('.blocked-reason').exists()).toBe(false);
  });
});

describe('ProviderNotice', () => {
  it.each([
    [
      'nous-not-connected',
      'Not connected. You can save this configuration now and connect before you launch. Connect now',
    ],
    ['nous-renewal', 'Login needs renewing. Experiments that use it are paused. Reconnect'],
    [null, 'Connected'],
  ])('%s', async (scenario, text) => {
    const { global } = await storeFor(scenario);
    wrapper = mount(ProviderNotice, { props: { provider: 'nous' }, global });
    expect(wrapper.text().replace(/\s+/g, ' ')).toBe(text);
  });
});

describe('SetupCard', () => {
  it('shows while no provider is connected, and opens the dialog', async () => {
    const { store, global } = await storeFor('nous-not-connected');
    wrapper = mount(SetupCard, { global });
    expect(wrapper.text()).toContain('Connect a model to run experiments');
    expect(wrapper.text()).toContain(
      'Experiments call a model. Connect Nous Portal once, or add an API key for another provider.',
    );
    expect(wrapper.find('a').text()).toBe('Use an API key instead');
    await wrapper.find('button').trigger('click');
    await flushPromises();
    expect(store.dialogOpen).toBe(true);
  });

  it('goes away once a provider is connected', async () => {
    const { global } = await storeFor(null);
    wrapper = mount(SetupCard, { global });
    expect(wrapper.find('.setup-card').exists()).toBe(false);
  });

  it('merges into the empty list; connected turns step 1 into a chip', async () => {
    const { global } = await storeFor('nous-not-connected');
    wrapper = mount(SetupCard, { props: { variant: 'empty' }, global });
    expect(wrapper.text()).toContain('No experiments yet');
    expect(wrapper.text()).toContain('Not connected yet.');
    expect(wrapper.find('button').text()).toBe('Connect Nous Portal');
    wrapper.unmount();

    const connected = await storeFor(null);
    wrapper = mount(SetupCard, { props: { variant: 'empty' }, global: connected.global });
    expect(wrapper.find('.status-chip').text()).toBe('Connected');
    expect(wrapper.find('a.btn.primary').text()).toBe('New configuration');
  });
});
