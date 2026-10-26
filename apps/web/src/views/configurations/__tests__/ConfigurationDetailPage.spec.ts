import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import ConfigurationDetailPage from '@/views/configurations/ConfigurationDetailPage.vue';
import * as configurationsApi from '@/api/configurations';
import { CONFIG_IDS, CONFIG_VERSION_IDS } from '@/fixtures/configurations';
import { useConfigurationsStore } from '@/stores/configurations';
import { useProvidersStore } from '@/stores/providers';
import { useResourcesStore } from '@/stores/resources';
import { mountPage, unmountAll } from './mountPage';

afterEach(() => {
  unmountAll();
  useProvidersStore().dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const norm = (text: string) => text.replace(/\s+/g, ' ').trim();
/** An element's text as words: each text node is one piece, as the flex gaps show them. */
function words(el: { element: Element }): string {
  const walker = document.createTreeWalker(el.element, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    if (text) parts.push(text);
  }
  return norm(parts.join(' '));
}
const open = (id: string, scenario: string | null = null, query = '') =>
  mountPage(ConfigurationDetailPage, `/configurations/${id}${query}`, scenario);
const row = (w: VueWrapper, key: string) => w.get(`dl [data-key="${key}"]`);

describe('ConfigurationDetailPage', () => {
  it('heads the page with the name, its version and where it came from', async () => {
    const { w } = await open(CONFIG_IDS['with-skill']);
    expect(w.get('nav[aria-label="Breadcrumb"]').text()).toBe('Configurations / with-skill');
    expect(w.get('h1').text()).toBe('with-skill');
    expect(w.get('h1').classes()).toContain('font-mono');
    expect(w.get('.tag').text()).toBe('v1 · latest');
    expect(norm(w.get('[data-testid="detail-meta"]').text())).toBe(
      'Created 22 Oct 09:52 by duplicating baseline v1 · used in 3 experiments',
    );
    expect(w.findAll('button').map((b) => b.text())).toContain('Compare with…');
    const links = w.findAll('a.btn');
    expect(links.map((a) => [a.text(), a.attributes('href')])).toEqual([
      ['Duplicate', `/configurations/new?from=${CONFIG_IDS['with-skill']}`],
      ['Edit', `/configurations/${CONFIG_IDS['with-skill']}/edit`],
    ]);
  });

  it('lists the fields as written into config.yaml, marking what differs from the source', async () => {
    const { w } = await open(CONFIG_IDS['with-skill']);
    const fields = w.get('section[aria-labelledby]');
    expect(fields.get('h2').text()).toBe('Fields');
    expect(fields.text()).toContain("as written into each run's config.yaml");
    expect(row(w, 'model').text()).toContain('openai/gpt-6.1-sol');
    expect(
      row(w, 'toolsets')
        .findAll('.tag')
        .map((t) => t.text()),
    ).toEqual(['file', 'terminal']);
    expect(words(row(w, 'memory'))).toBe('Memory off (runtime default is on)');
    const skills = row(w, 'skills');
    expect(skills.classes()).toContain('bg-accent-soft');
    expect(words(skills)).toMatch(
      /^Skills invoice-method 1\.0\.0 sha256:[0-9a-f]{8} differs from baseline$/,
    );
    expect(words(row(w, 'documents'))).toBe('Documents None');
    expect(words(row(w, 'mcp_servers'))).toBe('MCP servers None');
    expect(words(row(w, 'time_budget_s'))).toBe('Time budget 300 s');
    expect(words(row(w, 'hash'))).toMatch(/^Config hash sha256:e81b44a0…[0-9a-f]{4}$/);
  });

  it('with-mcp: the MCP server and what the agent can read', async () => {
    const { w } = await open(CONFIG_IDS['with-mcp']);
    await flushPromises();
    const mcp = row(w, 'mcp_servers');
    expect(mcp.classes()).toContain('bg-accent-soft');
    expect(words(mcp)).toContain('invoice-db v1 stdio env INVOICE_DB_URL · differs from baseline');
    expect(norm(mcp.get('[role="note"]').text())).toBe(
      "invoice-db runs inside the run's container. The agent can read INVOICE_DB_URL.",
    );
    expect(words(row(w, 'skills'))).toBe('Skills No added skills');
  });

  it('names the variables of the very definition version the configuration pins', async () => {
    // The names come with the version's McpServerRef (Phase 5 section 6.1), not from the
    // resource library's latest definitions, which this page no longer reads.
    const real = configurationsApi.getConfiguration;
    vi.spyOn(configurationsApi, 'getConfiguration').mockImplementation(async (id, version) => {
      const detail = await real(id, version);
      const shown = {
        ...detail.shown,
        mcpServers: detail.shown.mcpServers.map((m) => ({
          ...m,
          envNames: ['INVOICE_DB_URL', 'INVOICE_DB_READONLY_TOKEN'],
        })),
      };
      return { ...detail, shown, latest: shown };
    });
    const { w } = await open(CONFIG_IDS['with-mcp']);
    await flushPromises();
    expect(norm(row(w, 'mcp_servers').get('[role="note"]').text())).toBe(
      "invoice-db runs inside the run's container. The agent can read INVOICE_DB_URL and INVOICE_DB_READONLY_TOKEN.",
    );
    expect(useResourcesStore().mcpServers.loaded).toBe(false);
  });

  it('version history and every experiment that used it, with pass rate and verdict', async () => {
    const { w } = await open(CONFIG_IDS['with-skill']);
    const history = w.get('table[aria-label="Version history"]');
    expect(history.findAll('tbody tr').map((tr) => words(tr))).toEqual([
      'v1 latest 22 Oct 09:52 Duplicated from baseline v1; added skill invoice-method@1.0.0 3',
    ]);
    expect(w.text()).toContain(
      'Selecting a version shows its fields as frozen. Experiments link here with "view as of this experiment", which opens that version.',
    );
    const used = w.get('table[aria-label="Used in experiments"]');
    expect(used.findAll('thead th').map((th) => th.text())).toEqual([
      'Experiment',
      'Role',
      'Status',
      'Pass rate',
      'Verdict',
    ]);
    expect(used.findAll('tbody tr').map((tr) => tr.findAll('td').map((td) => words(td)))).toEqual([
      // The candidate's Δ whenever there is one: provisional while running (Phase 5 question 1).
      [
        'Skill + MCP, invoices-v1',
        'candidate',
        'running',
        '0.85 13 of 60 scored',
        'Provisional · Δ +0.208',
      ],
      [
        'Skill vs no skill, invoices-v1',
        'candidate',
        'completed',
        '0.850',
        'better Δ +0.217 · vs baseline 0.633',
      ],
      [
        'Skill vs no skill, quick check',
        'candidate',
        'paused',
        '0.80 5 of 12 scored',
        'No interval (1 rep)',
      ],
    ]);
    const completed = used.findAll('tbody tr')[1]!;
    expect(completed.get('[data-testid="pass-rate"] span span').classes()).toContain(
      'font-semibold',
    );
    // ConfigDetail draws the completed chip without a dot; the others keep theirs.
    const dots = used
      .findAll('tbody tr')
      .map((tr) => tr.findAll('td')[2]!.find('[data-dot]').exists());
    expect(dots).toEqual([true, false, true]);
    // The verdict cell wraps its caption in a half-width panel (1440px page).
    expect(completed.get('[data-testid="verdict"]').classes()).toContain('whitespace-normal');
    expect(completed.get('[data-kind="verdict"]').attributes('data-status')).toBe('better');
    expect(used.get('a').attributes('href')).toMatch(/^\/experiments\/exp_/);
  });

  it('Compare with…: the version it was duplicated from, field by field', async () => {
    const { w } = await open(CONFIG_IDS['with-skill']);
    await w
      .findAll('button')
      .find((b) => b.text() === 'Compare with…')!
      .trigger('click');
    await flushPromises();
    const panel = w.get('section[aria-labelledby^="diff-title"]');
    expect((panel.get('select').element as HTMLSelectElement).value).toBe(
      CONFIG_VERSION_IDS.baseline,
    );
    expect(panel.get('[data-testid="diff-line"]').text()).toBe('1 field differs: skills');
    expect(panel.findAll('thead th').map((th) => th.text())).toEqual([
      'Field',
      'baseline v1',
      'with-skill v1',
    ]);
    await panel.get('select').setValue(CONFIG_VERSION_IDS['with-mcp']);
    await flushPromises();
    expect(w.get('[data-testid="diff-line"]').text()).toBe('2 fields differ: skills, mcp_servers');
    await panel
      .findAll('button')
      .find((b) => b.text() === 'Close')!
      .trigger('click');
    expect(w.find('section[aria-labelledby^="diff-title"]').exists()).toBe(false);
  });

  it('says "Saved as version 2" once after the form routes here', async () => {
    const { w } = await mountPage(
      ConfigurationDetailPage,
      `/configurations/${CONFIG_IDS['with-skill']}`,
      null,
      () => {
        useConfigurationsStore().lastSaved = {
          configurationId: CONFIG_IDS['with-skill'],
          versionId: 'cfgv_x',
          version: 2,
          createdNewVersion: true,
        };
      },
    );
    const notice = w.get('[data-testid="saved-notice"]');
    expect(notice.attributes('role')).toBe('status');
    expect(notice.text()).toBe('Saved as version 2.');
    expect(useConfigurationsStore().lastSaved).toBeNull();
  });

  it('loading, a version that does not exist, and a load error', async () => {
    const loading = await open(CONFIG_IDS['with-skill'], 'loading');
    expect(loading.w.find('[data-testid="detail-loading"]').exists()).toBe(true);
    unmountAll();
    const missing = await open(CONFIG_IDS.baseline, null, '?version=7');
    expect(norm(missing.w.get('[role="alert"]').text())).toContain(
      `GET /api/configurations/${CONFIG_IDS.baseline}/versions/7 → 404 · configuration ${CONFIG_IDS.baseline} v7 not found`,
    );
    unmountAll();
    const failed = await open(CONFIG_IDS['with-skill'], 'error');
    const banner = failed.w.get('[role="alert"]');
    expect(banner.text()).toContain('Could not load this configuration');
    expect(banner.text()).toContain('→ 502 · upstream api:8080 connection refused');
    expect(banner.get('button').text()).toBe('Retry');
  });
});
