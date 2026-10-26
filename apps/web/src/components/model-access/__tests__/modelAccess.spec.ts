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
  const ACTIONS = '[data-testid="psr-actions"]';
  const actions = () => wrapper!.findAll(`${ACTIONS} .btn`).map((b) => b.text());

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
    expect(wrapper!.find('[data-kind]').text()).toBe(chip);
    expect(wrapper!.find('[data-testid="psr-detail"]').text()).toContain(detail);
    expect(actions()).toEqual(buttons);
    expect(wrapper!.find('input').exists()).toBe(false);
    vi.useRealTimers();
  });

  it('shows the host proxy command to copy when the proxy is down', async () => {
    await row('nous-host-down');
    expect(wrapper!.find('[data-testid="copy-command"] code').text()).toBe(
      'hermes proxy start --provider nous',
    );
    expect(wrapper!.find('[data-testid="copy-command"] button').attributes('aria-label')).toBe(
      'Copy command',
    );
    expect(wrapper!.find(ACTIONS).text()).toContain('copy the command');
  });

  it('asks before disconnecting, Keep connected takes focus', async () => {
    const { store } = await row(null);
    await wrapper!.find(`${ACTIONS} button`).trigger('click');
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
    await wrapper!.find(`${ACTIONS} button`).trigger('click');
    await flushPromises();
    expect(store.dialogOpen).toBe(true);
    expect(store.origin).toBe('other');
  });

  it('unavailable: says why, then reveals the terminal login on request', async () => {
    const { store, global } = await storeFor('nous-not-connected');
    const nous = store.providers.find((p) => p.id === 'nous')!;
    nous.status = 'unavailable';
    wrapper = mount(ProviderStatusRow, {
      props: { provider: nous, layout: 'grid' },
      global,
      attachTo: document.body,
    });
    const chip = wrapper.find('[data-kind]');
    expect(chip.text()).toBe('unavailable');
    expect(chip.attributes('data-tone')).toBe('fail');
    expect(wrapper.find('[data-testid="psr-detail"]').text()).toContain(
      'The login service failed its startup check: this Hermes version does not offer the device login the platform uses.',
    );
    expect(wrapper.find('[data-testid="copy-command"]').exists()).toBe(false);
    expect(actions()).toEqual(['Show how to connect from a terminal']);
    await wrapper.find(`${ACTIONS} button`).trigger('click');
    expect(wrapper.find('[data-testid="copy-command"] code').text()).toBe(
      'docker compose run --rm --entrypoint /opt/hermes/.venv/bin/hermes nous-proxy auth add nous --type oauth --no-browser',
    );
    // ModelAccessStates: once shown, the command can be hidden again.
    expect(actions()).toEqual(['Hide command']);
    await wrapper.find(`${ACTIONS} button`).trigger('click');
    expect(wrapper.find('[data-testid="copy-command"]').exists()).toBe(false);
    expect(actions()).toEqual(['Show how to connect from a terminal']);
  });

  it('sets the backticked names of the host detail in code', async () => {
    await row('nous-host');
    const codes = wrapper!.findAll('[data-testid="psr-detail"] code').map((c) => c.text());
    expect(codes).toEqual(['NOUS_HOST_PROXY', '.env']);
  });

  it('OpenRouter missing: steps and a copy button, never a key field', async () => {
    await row(null, 'openrouter');
    expect(wrapper!.find('[data-kind]').text()).toBe('missing');
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
    const rows = wrapper.findAll('tr[data-provider]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.findAll('td')).toHaveLength(5);
    expect(rows[1]!.text()).toContain(
      'No input here: keys are never accepted or stored in the UI.',
    );
    expect(rows[1]!.find('[data-testid="copy-command"] code').text()).toBe(
      'docker compose up -d egress worker',
    );
    await rows[0]!.find('button').trigger('click');
    expect(wrapper.find('[data-testid="psr-confirm-row"] td').attributes('colspan')).toBe('5');
  });
});

describe('SandboxCheckList', () => {
  it('collapses to the summary when every check passes', () => {
    useScenario(null);
    wrapper = mount(SandboxCheckList, { props: { status: sandboxFixture() } });
    expect(wrapper.find('[data-kind]').text()).toBe('proven');
    expect(wrapper.text()).toContain(
      'Isolation proven · 16 of 16 checks · checked 2 min ago at worker start',
    );
    expect(wrapper.findAll('li[data-check]')).toHaveLength(0);
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    const toggle = wrapper.find('button[aria-expanded]');
    expect(toggle.text()).toBe('Show 16 checks');
    expect(toggle.attributes('aria-expanded')).toBe('false');
  });

  it('expands to all 16 on request, the verifier container last', async () => {
    useScenario(null);
    wrapper = mount(SandboxCheckList, { props: { status: sandboxFixture() } });
    await wrapper.find('button[aria-expanded]').trigger('click');
    const rows = wrapper.findAll('li[data-check]');
    expect(rows).toHaveLength(16);
    expect(rows[0]!.text()).toContain('01 runs as an unprivileged user (uid 10000)');
    expect(rows[4]!.text()).toContain('ip route → no default route');
    expect(rows[15]!.attributes('data-check')).toBe('verifier-container');
    expect(rows[15]!.text()).toContain('16 a verifier container starts through docker-guard');
    expect(wrapper.find('button[aria-expanded]').text()).toBe('Hide checks');
  });

  it('lists failing checks, disables execution and names the self-test', async () => {
    useScenario('sandbox-failed');
    wrapper = mount(SandboxCheckList, { props: { status: sandboxFixture() } });
    expect(wrapper.find('[data-kind]').text()).toBe('not proven');
    expect(wrapper.find('[role="alert"]').text()).toContain(
      'Execution is disabled: 2 of 16 isolation checks failed. No run will start until every check passes.',
    );
    expect(wrapper.find('[role="alert"] code').text()).toBe(
      'docker compose exec worker node dist/sandbox-cli.js selftest',
    );
    expect(wrapper.text()).toContain('Isolation not proven · 14 of 16 checks');
    // Collapsed by default, as the System board draws it: only the failures show.
    const failing = wrapper.findAll('li[data-check]');
    expect(failing).toHaveLength(2);
    expect(failing[0]!.find('[role="img"]').attributes('aria-label')).toBe('failed');
    expect(failing[0]!.text()).toContain('192.168.5.2:22 open');
    expect(failing[1]!.text()).toContain('10.0.4.7:5432 reachable');
    expect(wrapper.find('button[aria-expanded]').text()).toBe('Show all 16 checks');
    await wrapper.find('button[aria-expanded]').trigger('click');
    expect(wrapper.findAll('li[data-check]')).toHaveLength(16);
    expect(wrapper.find('button[aria-expanded]').text()).toBe('Hide checks');
  });

  it("sandbox-verifier-refused: the verifier container fails alone, with the guard's reason", () => {
    useScenario('sandbox-verifier-refused');
    wrapper = mount(SandboxCheckList, { props: { status: sandboxFixture() } });
    expect(wrapper.find('[role="alert"]').text()).toContain(
      'Execution is disabled: 1 of 16 isolation checks failed.',
    );
    const failing = wrapper.findAll('li[data-check]');
    expect(failing.map((li) => li.attributes('data-check'))).toEqual(['verifier-container']);
    expect(failing[0]!.text()).toContain('docker-guard refused the container (403)');
  });

  it('shortens the image digest as drawn, the full one in the tooltip', () => {
    const digest = `sha256:${'70484f8952851150ad628ca89c11d853faecf82da84f388cecc896ae0e2c2ad1'}`;
    wrapper = mount(SandboxCheckList, { props: { status: { ...sandboxFixture(), digest } } });
    const code = wrapper.find(`code[title="${digest}"]`);
    expect(code.text()).toBe('sha256:70484f…');
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
    const reason = wrapper.find('[data-testid="blocked-reason"]');
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
    expect(wrapper.find('[data-testid="blocked-reason"]').exists()).toBe(false);
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

  it('an API-key provider without a key: the server step with Copy, never a field or Connect', async () => {
    const { global } = await storeFor('openrouter-in-use');
    wrapper = mount(ProviderNotice, { props: { provider: 'openrouter' }, global });
    const notice = wrapper.find('[role="status"]');
    expect(notice.attributes('data-status')).toBe('missing');
    const text = notice.text().replace(/\s+/g, ' ');
    expect(text).toContain(
      'No API key. OPENROUTER_API_KEY is not set on the server. You can save this configuration now and add the key before you launch.',
    );
    expect(text).toContain(
      'Add OPENROUTER_API_KEY=… to .env, then run docker compose up -d egress worker',
    );
    expect(notice.find('button[aria-label="Copy the command"]').text()).toContain('Copy');
    const link = notice.find('a');
    expect(link.text()).toBe('See System › Model access');
    expect(link.attributes('href')).toBe('/system');
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Connect');
  });

  it('a configured key reads Connected', async () => {
    const { global } = await storeFor('openrouter-configured');
    wrapper = mount(ProviderNotice, { props: { provider: 'openrouter' }, global });
    expect(wrapper.text()).toBe('Connected');
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
    expect(wrapper.find('[data-testid="setup-card"]').exists()).toBe(false);
  });

  it('missing-key: the server step and Open System, no Connect button', async () => {
    const { store, global } = await storeFor('openrouter-in-use');
    wrapper = mount(SetupCard, { global });
    expect(wrapper.find('[data-testid="setup-card"]').exists()).toBe(false);
    const card = wrapper.find('[data-testid="setup-key-card"]');
    expect(card.attributes('data-provider')).toBe('openrouter');
    expect(card.find('#setup-key-title').text()).toBe(
      'Add an OpenRouter API key to run experiments',
    );
    expect(card.text().replace(/\s+/g, ' ')).toContain(
      'Your configurations use openrouter, and the server has no key for it. The platform never accepts keys in the UI: add it on the server.',
    );
    expect(card.text().replace(/\s+/g, ' ')).toContain(
      'Add OPENROUTER_API_KEY=… to .env, then run docker compose up -d egress worker',
    );
    expect(card.find('a').text()).toBe('Open System');
    expect(card.findAll('button').map((b) => b.attributes('aria-label'))).toEqual([
      'Copy the command',
    ]);
    expect(store.dialogOpen).toBe(false);
  });

  it('forced variants follow `show`', async () => {
    const { global } = await storeFor(null);
    wrapper = mount(SetupCard, { props: { variant: 'card', show: true }, global });
    expect(wrapper.find('[data-testid="setup-card"]').exists()).toBe(true);
    await wrapper.setProps({ variant: 'missing-key' });
    expect(wrapper.find('[data-testid="setup-key-card"]').exists()).toBe(true);
    await wrapper.setProps({ show: false });
    expect(wrapper.html()).not.toContain('setup');
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
    expect(wrapper.find('[data-kind]').text()).toBe('Connected');
    expect(wrapper.find('a.btn.primary').text()).toBe('New configuration');
  });
});
