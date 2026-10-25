import { afterEach, describe, expect, it, vi } from 'vitest';
// Loaded up front, so the lazy route a save or a row opens resolves at once, even under load.
import '@/views/configurations/ConfigurationDetailPage.vue';
import { flushPromises } from '@vue/test-utils';
import ConfigurationListPage from '@/views/configurations/ConfigurationListPage.vue';
import { CONFIG_IDS } from '@/fixtures/configurations';
import { useProvidersStore } from '@/stores/providers';
import { mountPage, unmountAll } from './mountPage';

afterEach(() => {
  unmountAll();
  useProvidersStore().dispose();
  vi.unstubAllGlobals();
});

const open = (scenario: string | null = null) =>
  mountPage(ConfigurationListPage, '/configurations', scenario);

describe('ConfigurationListPage', () => {
  it('lists every configuration at its latest version (ConfigList board)', async () => {
    const { w } = await open();
    expect(w.get('h1').text()).toBe('Configurations');
    expect(w.text()).toContain('3 configurations');
    expect(w.findAll('thead th').map((th) => th.text())).toEqual([
      'Select',
      'Name',
      'Model',
      'Provider',
      'Toolsets',
      'Memory',
      'Skills',
      'MCP servers',
      'Docs',
      'Created',
      'Used in',
    ]);
    const rows = w.findAll('tbody tr');
    expect(rows.map((r) => r.findAll('td')[1]!.text())).toEqual([
      'baseline v1',
      'with-skill v1',
      'with-mcp v1',
    ]);
    const skill = rows[1]!.findAll('td').map((td) => td.text());
    expect(skill.slice(2)).toEqual([
      'openai/gpt-6.1-sol',
      'nous',
      'fileterminal',
      'off',
      'invoice-method',
      '—',
      '0',
      '22 Oct 09:52',
      '3 experiments',
    ]);
    expect(
      rows[1]!
        .findAll('td')[4]!
        .findAll('.tag')
        .map((t) => t.text()),
    ).toEqual(['file', 'terminal']);
    expect(rows[2]!.findAll('td')[7]!.text()).toBe('invoice-db');
  });

  it('opens a configuration from its row', async () => {
    const { w, router } = await open();
    await w.findAll('tbody tr')[1]!.findAll('td')[3]!.trigger('click');
    await vi.waitFor(
      () =>
        expect(router.currentRoute.value.path).toBe(`/configurations/${CONFIG_IDS['with-skill']}`),
      { timeout: 5000 },
    );
  });

  it('compares two picked configurations field by field, and only the differences', async () => {
    const { w } = await open();
    const compare = () => w.get('[data-testid="compare"]');
    expect(compare().text()).toBe('Compare (0)');
    expect(compare().attributes('disabled')).toBeDefined();
    expect(compare().attributes('title')).toBe('Select two or more configurations');

    await w.get('input[aria-label="Select baseline for comparison"]').setValue(true);
    await w.get('input[aria-label="Select with-skill for comparison"]').setValue(true);
    expect(w.findAll('tbody tr[data-selected="true"]')).toHaveLength(2);
    expect(compare().text()).toBe('Compare (2)');
    expect(compare().attributes('title')).toBe('Open the side-by-side comparison');
    await compare().trigger('click');
    await flushPromises();

    const panel = w.get('section[aria-labelledby^="diff-title"]');
    expect(panel.get('h2').text()).toBe('Compare configurations');
    expect(panel.get('[data-testid="diff-line"]').text()).toBe('1 field differs: skills');
    expect(panel.findAll('thead th').map((th) => th.text())).toEqual([
      'Field',
      'baseline v1',
      'with-skill v1',
    ]);
    expect(panel.get('[data-field="skills"]').attributes('data-differs')).toBe('true');
    await panel.get('input[type="checkbox"]').setValue(true);
    expect(panel.findAll('tbody tr').map((tr) => tr.attributes('data-field'))).toEqual(['skills']);

    // The comparison follows the picks while it is open.
    await w.get('input[aria-label="Select with-mcp for comparison"]').setValue(true);
    await flushPromises();
    expect(w.get('[data-testid="diff-line"]').text()).toBe('2 fields differ: skills, mcp_servers');

    await panel.get('button').trigger('click');
    expect(w.find('section[aria-labelledby^="diff-title"]').exists()).toBe(false);
  });

  it('Compare brings the comparison into view: it opens under the whole list', async () => {
    const scrolled: Element[] = [];
    const scrollIntoView = vi.fn<(this: Element, options?: ScrollIntoViewOptions) => void>(
      function (this: Element) {
        scrolled.push(this);
      },
    );
    const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    try {
      const { w } = await open();
      await w.get('input[aria-label="Select baseline for comparison"]').setValue(true);
      await w.get('input[aria-label="Select with-skill for comparison"]').setValue(true);
      await w.get('[data-testid="compare"]').trigger('click');
      await flushPromises();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrolled[0]?.matches('section[aria-labelledby^="diff-title"]')).toBe(true);
    } finally {
      if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('loading: skeleton rows at the real columns', async () => {
    const { w } = await open('loading');
    expect(w.get('table').attributes('aria-busy')).toBe('true');
    expect(w.findAll('[data-testid="skeleton-row"]')).toHaveLength(3);
    expect(w.text()).not.toContain('configurations ');
  });

  it('empty: explains what a configuration is, with New configuration', async () => {
    const { w } = await open('empty');
    const empty = w.get('[data-testid="empty-state"]');
    expect(empty.text()).toContain('No configurations yet');
    expect(empty.text()).toContain(
      'A configuration records how the agent is set up: model, provider, toolsets, memory, skills, documents and MCP servers. An experiment compares two or more of them.',
    );
    expect(empty.get('a').attributes('href')).toBe('/configurations/new');
    expect(w.findAll('thead th')).toHaveLength(11);
  });

  it('error: the failed request verbatim where the table would be, with Retry', async () => {
    const { w } = await open('error');
    const banner = w.get('[role="alert"]');
    expect(banner.text()).toContain('Could not load configurations');
    expect(banner.text()).toContain(
      'GET /api/configurations → 502 · upstream api:8080 connection refused',
    );
    expect(w.find('table').exists()).toBe(false);
    expect(banner.get('button').text()).toBe('Retry');
  });
});
