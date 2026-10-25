import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import AppShell from '@/components/layout/AppShell.vue';
import { useProvidersStore } from '@/stores/providers';
import { useSystemStore } from '@/stores/system';
import { useScenario } from '@/stores/__tests__/scenarioEnv';

const Blank = defineComponent({ render: () => h('div') });

let wrapper: VueWrapper | null = null;

async function mountShell(scenario: string | null, path = '/experiments') {
  useScenario(scenario);
  const pinia = createPinia();
  setActivePinia(pinia);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/experiments' },
      { path: '/experiments', component: Blank },
      { path: '/experiments/:id', component: Blank },
      { path: '/suites', component: Blank },
      { path: '/suites/:id', component: Blank },
      { path: '/configurations', component: Blank },
      { path: '/resources', component: Blank },
      { path: '/resources/:tab', component: Blank },
      { path: '/system', component: Blank },
    ],
  });
  await router.push(path);
  await router.isReady();
  wrapper = mount(AppShell, { global: { plugins: [pinia, router] }, attachTo: document.body });
  await flushPromises();
  return { w: wrapper, router };
}

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  useProvidersStore().dispose();
  useSystemStore().dispose();
  vi.unstubAllGlobals();
});

const banner = () => wrapper!.find('[data-testid="provider-banner"]');
const systemLink = () => wrapper!.find('[data-testid="system-link"]');
const themeToggle = () => wrapper!.find('[data-testid="theme-toggle"]');
const approvalPill = () => wrapper!.find('[data-testid="approval-pill"]');

describe('AppShell', () => {
  it('draws the bar: brand, four sections, System, theme toggle', async () => {
    const { w } = await mountShell(null);
    expect(w.find('[data-testid="brand"]').text()).toBe('Hermes Evals');
    const nav = w.find('nav[aria-label="Sections"]');
    expect(nav.findAll('a').map((a) => a.text())).toEqual([
      'Experiments',
      'Suites',
      'Configurations',
      'Resources',
    ]);
    expect(nav.find('[aria-current="page"]').text()).toBe('Experiments');
    expect(systemLink().text()).toBe('System');
    const toggle = themeToggle();
    expect(toggle.attributes('aria-label')).toMatch(/^Switch to (dark|light) theme$/);
  });

  it('keeps the section current on nested routes', async () => {
    const { w } = await mountShell(null, '/experiments/exp_01JBFMCPVB');
    expect(w.find('nav [aria-current="page"]').text()).toBe('Experiments');
  });

  it('marks System current on /system, outside the work sections', async () => {
    const { w } = await mountShell(null, '/system');
    expect(w.find('nav [aria-current="page"]').exists()).toBe(false);
    expect(systemLink().attributes('aria-current')).toBe('page');
  });

  it('shows the live pill: 2 running · 127 / 300 scored', async () => {
    const { w } = await mountShell(null);
    const pill = w.find('[data-testid="live-pill"]');
    expect(pill.text().replace(/\s+/g, ' ')).toBe('2 running · 127 / 300 scored');
    expect(pill.attributes('title')).toBe(
      'Live: MCP vs baseline, invoices-v1 (87 / 120) · Skill + MCP, invoices-v1 (40 / 180)',
    );
    expect(w.find('[data-testid="no-worker-pill"]').exists()).toBe(false);
    expect(approvalPill().exists()).toBe(false);
  });

  it('is healthy by default: hollow System dot, no banner', async () => {
    await mountShell(null);
    expect(systemLink().attributes('data-attention')).toBe('false');
    expect(systemLink().attributes('title')).toBe(
      'System: model access, sandbox and workers are healthy',
    );
    expect(banner().exists()).toBe(false);
  });

  it('hides the live pill when nothing is running', async () => {
    const { w } = await mountShell('nothing-running');
    expect(w.find('[data-testid="live-pill"]').exists()).toBe(false);
    expect(w.find('[data-testid="no-worker-pill"]').exists()).toBe(false);
  });

  it('turns the pill amber when no worker is connected', async () => {
    const { w } = await mountShell('no-worker');
    expect(w.find('[data-testid="live-pill"]').exists()).toBe(false);
    const pill = w.find('[data-testid="no-worker-pill"]');
    expect(pill.text().replace(/\s+/g, ' ')).toBe('1 running · no worker');
    expect(pill.attributes('title')).toBe('No worker is connected; queued runs will not start');
    expect(pill.attributes('href')).toBe('/experiments/exp_01JBFMCPVB');
    expect(systemLink().attributes('data-attention')).toBe('true');
  });

  it('turns the System dot amber when the sandbox is not proven', async () => {
    await mountShell('sandbox-failed');
    expect(systemLink().attributes('data-attention')).toBe('true');
    expect(systemLink().text()).toContain('needs attention');
    expect(banner().exists()).toBe(false);
  });

  it('shows the not-connected banner with Connect, which opens the dialog', async () => {
    await mountShell('nous-not-connected');
    expect(banner().attributes('role')).toBe('status');
    expect(banner().find('[data-testid="banner-text"]').text().replace(/\s+/g, ' ')).toBe(
      'Nous Portal is not connected. Experiments that use it cannot run.',
    );
    expect(banner().find('[data-testid="banner-lead"]').text()).toBe(
      'Nous Portal is not connected.',
    );
    expect(banner().find('button[data-testid="banner-action"]').text()).toBe('Connect');
    expect(systemLink().attributes('data-attention')).toBe('true');
    expect(systemLink().attributes('title')).toBe(
      'System needs attention: a provider is not connected, no worker is online, or the sandbox is not proven',
    );
    await banner().find('button[data-testid="banner-action"]').trigger('click');
    await flushPromises();
    const providers = useProvidersStore();
    expect(providers.dialogOpen).toBe(true);
    expect(providers.origin).toBe('other');
  });

  it('shows the renewal banner with Reconnect', async () => {
    await mountShell('nous-renewal');
    expect(banner().find('[data-testid="banner-text"]').text().replace(/\s+/g, ' ')).toBe(
      'Your Nous Portal login needs renewing. 1 experiment is paused.',
    );
    expect(banner().find('button[data-testid="banner-action"]').text()).toBe('Reconnect');
    expect(banner().attributes('data-banner')).toBe('renewal');
  });

  it.each(['/suites', '/suites/invoices-v1'])(
    'does not show the banner on %s, which never calls a model',
    async (path) => {
      await mountShell('nous-not-connected', path);
      expect(banner().exists()).toBe(false);
      expect(systemLink().attributes('data-attention')).toBe('true');
    },
  );

  it.each(['/configurations', '/system', '/resources', '/resources/skills'])(
    'shows the banner on %s (Resources too: UI_FLOWS 19 #4)',
    async (path) => {
      await mountShell('nous-not-connected', path);
      expect(banner().exists()).toBe(true);
    },
  );

  it('shows the no-key banner when a configuration uses a provider without a key', async () => {
    await mountShell(null);
    const providers = useProvidersStore();
    providers.providers.find((p) => p.id === 'openrouter')!.usedBy = ['or-baseline'];
    await flushPromises();
    expect(banner().attributes('data-banner')).toBe('no-key');
    expect(banner().find('[data-testid="banner-text"]').text().replace(/\s+/g, ' ')).toBe(
      'OpenRouter has no API key. Experiments that use it cannot run.',
    );
    const action = banner().find('a[data-testid="banner-action"]');
    expect(action.text()).toBe('How to add it');
    expect(action.attributes('href')).toBe('/system');
  });

  it('turns the live pill amber while the summary stream reconnects', async () => {
    const { w } = await mountShell('stream-lost');
    expect(w.find('[data-testid="live-pill"]').exists()).toBe(false);
    const pill = w.find('[data-testid="reconnecting-pill"]');
    expect(pill.text().replace(/\s+/g, ' ')).toMatch(
      /^2 running · Reconnecting \(attempt 3\) · last update \d\d:\d\d:\d\d$/,
    );
    expect(pill.attributes('title')).toBe(
      'The live stream dropped; values are frozen at the last update and will catch up on reconnect',
    );
  });

  it('says Offline with Retry once the summary stream has been down for 30 s', async () => {
    const { w } = await mountShell('stream-offline');
    expect(w.find('[data-testid="live-pill"]').exists()).toBe(false);
    expect(w.find('[data-testid="reconnecting-pill"]').exists()).toBe(false);
    const pill = w.find('[data-testid="offline-pill"]');
    expect(pill.text().replace(/\s+/g, ' ')).toMatch(
      /^2 running · Offline · last update \d\d:\d\d:\d\d Retry$/,
    );
    const system = useSystemStore();
    const retry = vi.spyOn(system, 'retryLive');
    await pill.find('button').trigger('click');
    expect(retry).toHaveBeenCalledOnce();
  });

  it('shows Offline even when nothing is running', async () => {
    const { w } = await mountShell('stream-offline,nothing-running');
    expect(w.find('[data-testid="offline-pill"]').text()).toMatch(/^Offline/);
  });

  it.each(['nous-host-down', 'nous-unavailable'])(
    '%s: the banner opens System instead of a Connect the API would refuse',
    async (scenario) => {
      await mountShell(scenario);
      expect(banner().attributes('data-banner')).toBe('not-connected');
      expect(banner().find('[data-testid="banner-lead"]').text()).toBe(
        'Nous Portal is not connected.',
      );
      const action = banner().find('a[data-testid="banner-action"]');
      expect(action.text()).toBe('Open System');
      expect(action.attributes('href')).toBe('/system');
    },
  );

  it('on System itself, the banner that would open System has no action', async () => {
    await mountShell('nous-host-down', '/system');
    expect(banner().find('[data-testid="banner-lead"]').text()).toBe(
      'Nous Portal is not connected.',
    );
    expect(banner().find('[data-testid="banner-action"]').exists()).toBe(false);
  });

  it('shows ApprovalPill while a login waits with the dialog closed; it reopens the dialog', async () => {
    const { w } = await mountShell('nous-waiting');
    const pill = approvalPill();
    expect(pill.text().replace(/\s+/g, ' ')).toBe('Waiting for Nous approval · 14:52 left');
    expect(pill.attributes('title')).toBe('Reopen the Nous Portal login');
    // The pill sits before the live pill, as drawn.
    const zone = w.find('[data-testid="status-zone"]').element.children;
    expect((zone[0] as HTMLElement).dataset.testid).toBe('approval-pill');
    expect(banner().exists()).toBe(true);

    await pill.trigger('click');
    await flushPromises();
    const providers = useProvidersStore();
    expect(providers.dialogOpen).toBe(true);
    expect(providers.loginPhase).toBe('waiting');
    expect(approvalPill().exists()).toBe(false);

    // Closed with the login still waiting: the pill comes back and takes focus again.
    (document.activeElement as HTMLElement | null)?.blur();
    providers.closeDialog();
    await flushPromises();
    expect(document.activeElement).toBe(approvalPill().element);
  });

  it('toggles the theme', async () => {
    await mountShell(null);
    const before = document.documentElement.dataset.theme;
    await themeToggle().trigger('click');
    expect(document.documentElement.dataset.theme).not.toBe(before);
    const label = themeToggle().attributes('aria-label');
    expect(label).toBe(
      document.documentElement.dataset.theme === 'dark'
        ? 'Switch to light theme'
        : 'Switch to dark theme',
    );
  });
});
