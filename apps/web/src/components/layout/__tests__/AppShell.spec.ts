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

const banner = () => wrapper!.find('.banner');
const systemLink = () => wrapper!.find('.system-link');

describe('AppShell', () => {
  it('draws the bar: brand, four sections, System, theme toggle', async () => {
    const { w } = await mountShell(null);
    expect(w.find('.brand').text()).toBe('Hermes Evals');
    const nav = w.find('nav[aria-label="Sections"]');
    expect(nav.findAll('a').map((a) => a.text())).toEqual([
      'Experiments',
      'Suites',
      'Configurations',
      'Resources',
    ]);
    expect(nav.find('[aria-current="page"]').text()).toBe('Experiments');
    expect(systemLink().text()).toBe('System');
    const toggle = w.find('button.iconbtn');
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
    expect(w.find('.approval-pill').exists()).toBe(false);
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
    expect(banner().find('.banner-text').text().replace(/\s+/g, ' ')).toBe(
      'Nous Portal is not connected. Experiments that use it cannot run.',
    );
    expect(banner().find('.banner-lead').text()).toBe('Nous Portal is not connected.');
    expect(banner().find('button.bannerbtn').text()).toBe('Connect');
    expect(systemLink().attributes('data-attention')).toBe('true');
    expect(systemLink().attributes('title')).toBe(
      'System needs attention: a provider is not connected or the sandbox is not proven',
    );
    await banner().find('button.bannerbtn').trigger('click');
    await flushPromises();
    const providers = useProvidersStore();
    expect(providers.dialogOpen).toBe(true);
    expect(providers.origin).toBe('other');
  });

  it('shows the renewal banner with Reconnect', async () => {
    await mountShell('nous-renewal');
    expect(banner().find('.banner-text').text().replace(/\s+/g, ' ')).toBe(
      'Your Nous Portal login needs renewing. 1 experiment is paused.',
    );
    expect(banner().find('button.bannerbtn').text()).toBe('Reconnect');
    expect(banner().attributes('data-banner')).toBe('renewal');
  });

  it.each(['/suites', '/suites/invoices-v1', '/resources', '/resources/skills'])(
    'does not show the banner on %s, which never calls a model',
    async (path) => {
      await mountShell('nous-not-connected', path);
      expect(banner().exists()).toBe(false);
      expect(systemLink().attributes('data-attention')).toBe('true');
    },
  );

  it('shows the banner on Configurations and System', async () => {
    await mountShell('nous-not-connected', '/configurations');
    expect(banner().exists()).toBe(true);
    wrapper!.unmount();
    wrapper = null;
    await mountShell('nous-not-connected', '/system');
    expect(banner().exists()).toBe(true);
  });

  it('shows ApprovalPill while a login waits with the dialog closed; it reopens the dialog', async () => {
    const { w } = await mountShell('nous-waiting');
    const pill = w.find('.approval-pill');
    expect(pill.text().replace(/\s+/g, ' ')).toBe('Waiting for Nous approval · 14:52 left');
    expect(pill.attributes('title')).toBe('Reopen the Nous Portal login');
    // The pill sits before the live pill, as drawn.
    const zone = w.find('.status-zone').element.children;
    expect(zone[0]!.classList.contains('approval-pill')).toBe(true);
    expect(banner().exists()).toBe(true);

    await pill.trigger('click');
    await flushPromises();
    const providers = useProvidersStore();
    expect(providers.dialogOpen).toBe(true);
    expect(providers.loginPhase).toBe('waiting');
    expect(w.find('.approval-pill').exists()).toBe(false);
  });

  it('toggles the theme', async () => {
    const { w } = await mountShell(null);
    const before = document.documentElement.dataset.theme;
    await w.find('button.iconbtn').trigger('click');
    expect(document.documentElement.dataset.theme).not.toBe(before);
    const label = w.find('button.iconbtn').attributes('aria-label');
    expect(label).toBe(
      document.documentElement.dataset.theme === 'dark'
        ? 'Switch to light theme'
        : 'Switch to dark theme',
    );
  });
});
