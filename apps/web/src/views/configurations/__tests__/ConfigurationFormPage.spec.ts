import { afterEach, describe, expect, it, vi } from 'vitest';
// Loaded up front, so the lazy route a save or a row opens resolves at once, even under load.
import '@/views/configurations/ConfigurationDetailPage.vue';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import ConfigurationFormPage from '@/views/configurations/ConfigurationFormPage.vue';
import { CONFIG_IDS } from '@/fixtures/configurations';
import { MCP_INVOICE_DB, MCP_VENDOR_API } from '@/fixtures/resources';
import { useConfigurationsStore } from '@/stores/configurations';
import { useProvidersStore } from '@/stores/providers';
import { mountPage, unmountAll } from './mountPage';

afterEach(() => {
  unmountAll();
  useProvidersStore().dispose();
  vi.unstubAllGlobals();
});

const edit = (scenario: string | null = null) =>
  mountPage(ConfigurationFormPage, `/configurations/${CONFIG_IDS['with-skill']}/edit`, scenario);
const create = (scenario: string | null = null) =>
  mountPage(ConfigurationFormPage, '/configurations/new', scenario);

const field = (w: VueWrapper, label: string) => w.findAll('label').find((l) => l.text() === label);
const control = (w: VueWrapper, label: string) => {
  const for_ = field(w, label)?.attributes('for');
  if (!for_) throw new Error(`no field labelled ${label}`);
  return w.get(`[id="${for_}"]`);
};
/** Text as read on screen: runs of whitespace are one space. */
const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
/** The aside's change rows as "field before → after". */
const changeRows = (w: VueWrapper) =>
  w
    .findAll('aside [data-testid="changes"] li')
    .map((li) => norm([...li.element.children].map((c) => c.textContent).join(' ')));
const save = (w: VueWrapper) => w.get('[data-testid="save"]');
const hint = (w: VueWrapper) => w.get('[data-testid="save-hint"]').text();
const aside = (w: VueWrapper) => w.get('aside');

describe('ConfigurationFormPage', () => {
  describe('edit of a version experiments used (ConfigForm board)', () => {
    it('says saving creates version 2 and which experiments keep version 1', async () => {
      const { w } = await edit();
      expect(w.get('nav[aria-label="Breadcrumb"]').text()).toBe(
        'Configurations / with-skill / Edit',
      );
      expect(w.get('h1').text()).toBe('Edit with-skill');
      expect(norm(w.get('[data-testid="version-banner"]').text())).toBe(
        'with-skill v1 has been used by 3 experiments. Saving creates version 2. Skill + MCP, invoices-v1; Skill vs no skill, invoices-v1; and Skill vs no skill, quick check keep version 1. New experiments use the latest version.',
      );
      expect(aside(w).get('h2').text()).toBe('Changes from v1');
      expect(aside(w).text()).toContain('No changes yet.');
      expect(save(w).text()).toBe('Save as version 2');
      expect(save(w).attributes('disabled')).toBeDefined();
      expect(hint(w)).toBe('Make a change to save a new version.');
    });

    it('fills the form from the version: model, provider, toolsets, skill, limits', async () => {
      const { w } = await edit();
      expect((control(w, 'Name').element as HTMLInputElement).value).toBe('with-skill');
      expect((control(w, 'Model').element as HTMLInputElement).value).toBe('openai/gpt-6.1-sol');
      expect(w.text()).toContain('$0.60 in / $2.40 out per 1M tokens');
      expect((control(w, 'Provider').element as HTMLSelectElement).value).toBe('nous');
      const chips = w.findAll('[data-testid="toolsets"] button');
      expect(chips).toHaveLength(17);
      expect(
        chips.filter((c) => c.attributes('aria-pressed') === 'true').map((c) => c.text()),
      ).toEqual(['file', 'terminal']);
      expect(w.text()).toContain('17 toolsets · default on: file, terminal.');
      expect(w.get('[role="switch"]').attributes('aria-checked')).toBe('false');
      expect(w.text()).toContain('Memory disabled');
      expect(w.get('[data-item]').text()).toContain('invoice-method');
      expect((control(w, 'Max turns').element as HTMLInputElement).value).toBe('20');
      expect((control(w, 'Time budget (s)').element as HTMLInputElement).value).toBe('300');
    });

    it('says the limits are what every run uses: task limits are informational (plan 7)', async () => {
      const { w } = await edit();
      expect(norm(w.text())).toContain(
        'Every run uses these unless its experiment sets a time budget. Task limits in task.yaml are informational.',
      );
      expect(w.text()).not.toContain('applies if it is lower');
    });

    it('lists each change and saves it as version 2, then opens the detail', async () => {
      const { w, router } = await edit();
      await control(w, 'Max turns').setValue('30');
      await w.get('[role="switch"]').trigger('click');
      expect(changeRows(w)).toEqual(['memory off → on', 'max_turns 20 → 30']);
      expect(save(w).attributes('disabled')).toBeUndefined();
      expect(hint(w)).toBe('Version 1 stays frozen for the 3 experiments that used it.');
      await save(w).trigger('click');
      await vi.waitFor(
        () =>
          expect(router.currentRoute.value.path).toBe(
            `/configurations/${CONFIG_IDS['with-skill']}`,
          ),
        { timeout: 5000 },
      );
      expect(useConfigurationsStore().lastSaved).toMatchObject({
        version: 2,
        createdNewVersion: true,
      });
    });

    it('checks max turns when the field is left, and Save names the fix', async () => {
      const { w } = await edit();
      const turns = control(w, 'Max turns');
      await turns.setValue('300');
      expect(w.text()).not.toContain('Enter a whole number from 1 to 200');
      await turns.trigger('blur');
      expect(turns.attributes('aria-invalid')).toBe('true');
      expect(w.text()).toContain('Enter a whole number from 1 to 200');
      expect(save(w).attributes('disabled')).toBeDefined();
      expect(hint(w)).toBe('Fix max turns before saving.');
    });

    it('save failed: the server message, changes kept, the button retries', async () => {
      const { w } = await edit();
      await control(w, 'Name').setValue('baseline');
      await control(w, 'Max turns').setValue('30');
      await save(w).trigger('click');
      await flushPromises();
      const alert = w.get('[data-testid="save-error"]');
      expect(alert.text()).toContain('Save failed');
      expect(alert.text()).toContain(
        `PUT /api/configurations/${CONFIG_IDS['with-skill']} → 409 · a configuration named baseline already exists`,
      );
      expect(alert.text()).toContain('Nothing was saved and your changes are kept. Try again.');
      expect(save(w).text()).toBe('Try again: save as version 2');
      expect((control(w, 'Max turns').element as HTMLInputElement).value).toBe('30');
    });
  });

  describe('create (ConfigFormStates › Create mode)', () => {
    it('opens on the new draft: plain Save, disabled until there is a name', async () => {
      const { w } = await create();
      expect(w.get('nav[aria-label="Breadcrumb"]').text()).toBe('Configurations / New');
      expect(w.get('h1').text()).toBe('New configuration');
      expect(w.find('[data-testid="version-banner"]').exists()).toBe(false);
      expect(aside(w).get('h2').text()).toBe('New configuration');
      expect(aside(w).text()).toContain(
        'Saving creates version 1. Fields can be changed later; each saved change used by an experiment becomes a new version.',
      );
      expect(save(w).text()).toBe('Save');
      expect(save(w).attributes('disabled')).toBeDefined();
      expect(hint(w)).toBe('Enter a name, a model and a provider to save.');
      await control(w, 'Name').setValue('or-baseline');
      expect(save(w).attributes('disabled')).toBeUndefined();
      expect(hint(w)).toBe('Creates version 1.');
    });

    it('warns about a model that is not in the price table, without blocking', async () => {
      const { w } = await create();
      const model = control(w, 'Model');
      await model.setValue('anthropic/claude-5.1-sonnet');
      expect(w.text()).toContain('Not in the price table; cost estimates will be unavailable');
      expect(model.classes()).toContain('warn');
      await control(w, 'Name').setValue('or-baseline');
      expect(save(w).attributes('disabled')).toBeUndefined();
    });

    it('missing API key: the server step with Copy and System, Save stays enabled', async () => {
      const { w } = await create();
      await control(w, 'Name').setValue('or-baseline');
      await control(w, 'Provider').setValue('openrouter');
      const notice = w.get('[data-status="missing"]');
      expect(norm(notice.text())).toContain(
        'No API key. OPENROUTER_API_KEY is not set on the server. You can save this configuration now and add the key before you launch.',
      );
      expect(norm(notice.text())).toContain('Add OPENROUTER_API_KEY=… to .env, then run');
      expect(notice.get('button').attributes('aria-label')).toBe('Copy the command');
      expect(notice.get('a').text()).toBe('See System › Model access');
      expect(notice.find('button.linkbtn').exists()).toBe(false);
      expect(save(w).attributes('disabled')).toBeUndefined();
      expect(hint(w)).toBe('You can save now; add the API key before you launch.');
    });

    it('asks for a base URL on the custom provider', async () => {
      const { w } = await create();
      await control(w, 'Name').setValue('mock-arm');
      await control(w, 'Provider').setValue('custom');
      const url = control(w, 'Base URL');
      await url.setValue('not a url');
      await url.trigger('blur');
      expect(w.text()).toContain('Enter an http(s) URL without user:password@.');
      expect(hint(w)).toBe('Fix the base URL before saving.');
      await url.setValue('http://mock-model:8090/v1');
      expect(save(w).attributes('disabled')).toBeUndefined();
    });

    it('saves version 1 and opens the new configuration', async () => {
      const { w, router } = await create();
      await control(w, 'Name').setValue('or-baseline');
      await save(w).trigger('click');
      await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('configuration'), {
        timeout: 5000,
      });
      expect(useConfigurationsStore().lastSaved).toMatchObject({ version: 1 });
    });
  });

  describe('provider notice (LibraryStates › ProviderNotice)', () => {
    it.each([
      [null, 'Connected'],
      [
        'nous-not-connected',
        'Not connected. You can save this configuration now and connect before you launch. Connect now',
      ],
      ['nous-renewal', 'Login needs renewing. Experiments that use it are paused. Reconnect'],
    ])('nous, scenario %s: %s', async (scenario, text) => {
      const { w } = await create(scenario);
      await flushPromises();
      expect(norm(w.get('[data-status], [data-kind="provider"]').text())).toBe(text);
      await control(w, 'Name').setValue('nous-arm');
      expect(save(w).attributes('disabled')).toBeUndefined();
    });
  });

  it('MCP servers: what each one exposes to the run (MCP secrets boards)', async () => {
    const { w } = await create();
    await w.get('select[aria-label="Add MCP server"]').setValue(MCP_INVOICE_DB.versionId);
    await flushPromises();
    expect(w.get(`[data-item="${MCP_INVOICE_DB.versionId}"]`).text()).toContain(
      'invoice-db v1 · stdio',
    );
    const stdio = w.get('[data-testid="mcp-exposure"][data-transport="stdio"]');
    expect(stdio.attributes('role')).toBe('note');
    expect(norm(stdio.text())).toBe(
      "invoice-db runs inside the run's container. The agent can read INVOICE_DB_URL. Use a scoped or throwaway value: anything the server can use, the agent can use too.",
    );
    await w.get('select[aria-label="Add MCP server"]').setValue(MCP_VENDOR_API.versionId);
    expect(norm(w.get('[data-testid="mcp-exposure"][data-transport="http"]').text())).toBe(
      'vendor-api is reached through egress, which adds Authorization on the way to the server. The run never sees its value.',
    );
    await w.get(`button[aria-label="Remove invoice-db"]`).trigger('click');
    expect(w.find('[data-transport="stdio"]').exists()).toBe(false);
  });

  it('duplicate: prefilled under a free name, with the changes from the source', async () => {
    const { w } = await mountPage(
      ConfigurationFormPage,
      `/configurations/new?from=${CONFIG_IDS.baseline}`,
    );
    expect(w.get('h1').text()).toBe('New configuration');
    expect(norm(w.text())).toContain(
      'Duplicated from baseline v1. Nothing is stored until you save.',
    );
    expect((control(w, 'Name').element as HTMLInputElement).value).toBe('baseline-copy');
    expect(aside(w).text()).toContain('Changes from baseline v1');
    expect(aside(w).text()).toContain('No changes yet.');
    expect(save(w).attributes('disabled')).toBeUndefined();
    await w
      .get('select[aria-label="Add skill"]')
      .setValue(useConfigurationsStore().formOptions!.skills[0]!.skillId);
    expect(changeRows(w)).toEqual(['skills none → invoice-method@1.0.0']);
  });

  it('loading and load error', async () => {
    const loading = await create('loading');
    expect(loading.w.find('[data-testid="form-loading"]').exists()).toBe(true);
    unmountAll();
    const failed = await edit('error');
    const banner = failed.w.get('[role="alert"]');
    expect(banner.text()).toContain('Could not load this configuration');
    expect(banner.text()).toContain('→ 502 · upstream api:8080 connection refused');
    expect(failed.w.find('form').exists()).toBe(false);
  });
});
