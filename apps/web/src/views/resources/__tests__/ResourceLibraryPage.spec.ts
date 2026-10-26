/**
 * Resources on fixtures, tab by tab, in every state the boards draw: the default data, loading
 * (skeleton rows), the load error (the request verbatim, with Retry, under the page chrome),
 * empty, and the library scenarios (upload outcomes are in SkillUploadDialog.spec, the MCP
 * form's in McpServerForm.spec).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import type { Router } from 'vue-router';
import { ApiError } from '@/api/client';
import * as resourcesApi from '@/api/resources';
import type { ResourceTab } from '@/api/types/resources';
import { MCP_INVOICE_DB_ID, SKILL_INVOICE_METHOD_ID } from '@/fixtures/resources';
import ResourceLibraryPage from '@/views/resources/ResourceLibraryPage.vue';
import { mountResources } from '@/components/resources/__tests__/mountResources';

let w: VueWrapper | null = null;
let router: Router;
afterEach(() => {
  w?.unmount();
  w = null;
  vi.restoreAllMocks();
});

async function page(tab: ResourceTab, scenario: string | null = null, query = '') {
  const mounted = await mountResources(ResourceLibraryPage, {
    path: `/resources/${tab}${query}`,
    props: { tab },
    scenario,
  });
  w = mounted.w;
  router = mounted.router;
  await flushPromises();
  return mounted;
}
const cells = (row: number) =>
  w!
    .findAll('tbody tr')
    [row]!.findAll('td')
    .map((td) => td.text().replace(/\s+/g, ' '));
/** The page header's one action (its first button). */
const headerButton = (): HTMLButtonElement =>
  w!.get('main').element.firstElementChild!.querySelector('button')!;
/** Text with runs of whitespace as one space. */
const flat = (selector: string) => w!.get(selector).text().replace(/\s+/g, ' ');

/** The elements Element.scrollIntoView was called on (jsdom draws nothing, so it has none). */
const scrolledIntoView: Element[] = [];
const jsdomScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
beforeEach(() => {
  scrolledIntoView.length = 0;
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value(this: Element) {
      scrolledIntoView.push(this);
    },
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  if (jsdomScrollIntoView)
    Object.defineProperty(Element.prototype, 'scrollIntoView', jsdomScrollIntoView);
  else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe('Resources page frame', () => {
  it('heads every tab with Resources and the tab counts', async () => {
    await page('skills');
    expect(w!.get('h1').text()).toBe('Resources');
    expect(w!.text()).toContain(
      'Things a configuration can include. Each upload is content-hashed, so a configuration always points at exact bytes.',
    );
    const tabs = w!.get('nav[aria-label="Resource kinds"]').findAll('a');
    expect(tabs.map((t) => t.text().replace(/\s+/g, ' '))).toEqual([
      'Skills 1',
      'Documents 1',
      'MCP servers 2',
      'Secrets 2',
    ]);
    expect(tabs[0]!.attributes('aria-current')).toBe('page');
    expect(tabs[2]!.attributes('href')).toBe('/resources/mcp');
  });

  it.each([
    ['skills', 'Could not load skills', 'GET /api/resources/skills'],
    ['documents', 'Could not load documents', 'GET /api/resources/documents'],
    ['mcp', 'Could not load MCP servers', 'GET /api/resources/mcp-servers'],
    ['secrets', 'Could not load secrets', 'GET /api/resources/secrets'],
  ] as const)('keeps the chrome and quotes a failed load on %s', async (tab, title, request) => {
    await page(tab, 'error');
    expect(w!.get('h1').text()).toBe('Resources');
    expect(w!.find('nav[aria-label="Resource kinds"]').exists()).toBe(true);
    const alert = w!.get('[role="alert"]');
    expect(alert.get('[data-testid="error-banner-title"]').text()).toBe(title);
    expect(alert.text()).toContain(`${request} → 502 · upstream api:8080 connection refused`);
    expect(alert.get('button').text()).toBe('Retry');
  });

  it.each(['skills', 'documents', 'mcp', 'secrets'] as const)(
    'draws skeleton rows while %s loads',
    async (tab) => {
      await page(tab, 'loading');
      expect(w!.get('table').attributes('aria-busy')).toBe('true');
      expect(w!.findAll('[data-testid="skeleton-row"]').length).toBeGreaterThan(0);
    },
  );
});

describe('Skills tab', () => {
  it('lists invoice-method 1.0.0', async () => {
    await page('skills');
    expect(w!.findAll('thead th').map((th) => th.text())).toEqual([
      'Name',
      'Version',
      'Description',
      'Hash',
      'Uploaded',
      'Used by',
    ]);
    expect(cells(0)).toEqual([
      'invoice-method',
      '1.0.0',
      'Method for reconciling vendor invoices: always check credit notes, duplicates and partial payments before totalling',
      '9c41e07d',
      '22 Oct 09:48',
      '1 configuration',
    ]);
    expect(w!.get('[data-testid="used-by"]').attributes('href')).toBe(
      '/configurations/cfg_01JAX9SKILL',
    );
  });

  it('opens the skill drawer from its row, route-backed', async () => {
    await page('skills');
    await w!.findAll('tbody tr')[0]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.skill).toBe(SKILL_INVOICE_METHOD_ID);
    expect(w!.get('[data-testid="skill-drawer"]').text()).toContain('Invoice method');
    await w!.get('button[aria-label="Close"]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.skill).toBeUndefined();
    expect(w!.find('[data-testid="skill-drawer"]').exists()).toBe(false);
  });

  it('opens a file of the skill from the URL', async () => {
    await page('skills', null, `?skill=${SKILL_INVOICE_METHOD_ID}&file=checklist.md`);
    expect(w!.get('[data-testid="skill-content"] h3').text()).toBe('Columns this method expects');
  });

  it('opens the upload dialog from the header', async () => {
    await page('skills');
    expect(headerButton().textContent?.trim()).toBe('Upload skill');
    headerButton().click();
    await flushPromises();
    expect(w!.get('[data-testid="skill-upload-dialog"]').text()).toContain(
      'Step 1 of 2 · choose file',
    );
  });

  it('explains skills when there are none', async () => {
    await page('skills', 'empty');
    const empty = w!.get('[data-testid="empty-state"]');
    expect(flat('[data-testid="empty-state"]')).toBe(
      'No skills uploaded A skill is a folder with a SKILL.md and any files it references, uploaded as a zip. Configurations can include skills to test whether they help. Upload skill',
    );
    await empty.get('button').trigger('click');
    expect(w!.find('[data-testid="skill-upload-dialog"]').exists()).toBe(true);
  });
});

describe('Documents tab', () => {
  it('lists vendor-policy-v3.pdf with its hash and a download', async () => {
    await page('documents');
    expect(w!.findAll('thead th').map((th) => th.text())).toEqual([
      'Filename',
      'Size',
      'Type',
      'Hash',
      'Uploaded',
      'Attached to',
      'Download and delete',
    ]);
    expect(cells(0)).toEqual([
      'vendor-policy-v3.pdf',
      '214 KB',
      'PDF · 6 pages',
      'sha256:3be7d1f0…91ac',
      '22 Oct 09:30',
      'None not attached to any configuration',
      'Download Delete',
    ]);
    expect(w!.get('tbody a.btn').attributes('href')).toMatch(
      /^\/api\/resources\/documents\/.+\/content$/,
    );
    expect(w!.get('[data-testid="drop-strip"]').text()).toBe(
      'Drop files anywhere on this tab to upload · PDF, Markdown, text or CSV up to 50 MB',
    );
  });

  it('opens the dialog at step 2 for a file dropped on the tab, and flashes the stored row', async () => {
    const { store } = await page('documents');
    const file = new File(['# terms'], 'terms.md', { type: 'text/markdown' });
    await w!.get('[data-testid="documents-tab"]').trigger('drop', {
      dataTransfer: { files: [file], types: ['Files'] },
    });
    await flushPromises();
    const dialog = w!.get('[data-testid="document-upload-dialog"]');
    expect(dialog.text()).toContain('Step 2 of 2 · review');
    expect(dialog.text()).toContain('terms.md');
    await dialog.get('[data-testid="confirm-upload"]').trigger('click');
    await flushPromises();
    expect(w!.find('[data-testid="document-upload-dialog"]').exists()).toBe(false);
    const rows = w!.findAll('[data-testid="document-row"]');
    expect(rows.map((r) => r.find('td').text())).toEqual(['terms.md', 'vendor-policy-v3.pdf']);
    expect(rows[0]!.classes()).toContain('animate-flash');
    // A long list can put the new row below the fold: it is brought into view.
    expect(scrolledIntoView).toEqual([rows[0]!.element]);
    expect(store.counts?.documents).toBe(1);
  });

  it('deletes a document no configuration uses, after confirming in a row under it', async () => {
    const { store } = await page('documents');
    const del = w!.get('button[aria-label="Delete vendor-policy-v3.pdf"]');
    expect(del.attributes('disabled')).toBeUndefined();
    await del.trigger('click');
    await flushPromises();
    const row = w!.get('[data-testid="document-delete-row"]');
    expect(flat('[data-testid="document-delete-row"]')).toBe(
      'Delete vendor-policy-v3.pdf? It leaves the library. No configuration uses it, so no run or experiment changes. Delete documentKeep it',
    );
    expect(document.activeElement?.textContent?.trim()).toBe('Keep it');
    await row
      .findAll('button')
      .find((b) => b.text() === 'Delete document')!
      .trigger('click');
    await flushPromises();
    expect(w!.findAll('[data-testid="document-row"]')).toHaveLength(0);
    expect(store.documentRows).toEqual([]);
  });

  it('backs out with Keep it, focus back on Delete', async () => {
    await page('documents');
    await w!.get('button[aria-label="Delete vendor-policy-v3.pdf"]').trigger('click');
    await flushPromises();
    await w!
      .get('[data-testid="document-delete-row"]')
      .findAll('button')
      .find((b) => b.text() === 'Keep it')!
      .trigger('click');
    await flushPromises();
    expect(w!.find('[data-testid="document-delete-row"]').exists()).toBe(false);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Delete vendor-policy-v3.pdf');
  });

  it('disables Delete while a configuration version has the document, and quotes a 409', async () => {
    const { store } = await page('documents');
    const [doc] = store.documentRows;
    const links = [{ configurationId: 'cfg_1', name: 'with-docs' }];
    store.documents.byId = {
      [doc!.id]: { ...doc!, attachedTo: links, inUse: true, inUseBy: links },
    };
    await flushPromises();
    const del = w!.get('button[aria-label="Delete vendor-policy-v3.pdf"]');
    expect(del.attributes('disabled')).toBeDefined();
    expect(del.attributes('title')).toBe(
      'Part of a saved version of with-docs. A configuration version keeps the document it was saved with, so it cannot be deleted.',
    );

    // A row read before a configuration saved it: the API refuses all the same.
    store.documents.byId = { [doc!.id]: doc! };
    const refusal =
      'document vendor-policy-v3.pdf is part of a saved version of with-docs, and a configuration version keeps what it was saved with, so it cannot be deleted';
    vi.spyOn(resourcesApi, 'deleteDocument').mockRejectedValue(
      new ApiError(409, `DELETE /api/resources/documents/${doc!.id}`, refusal),
    );
    await flushPromises();
    await w!.get('button[aria-label="Delete vendor-policy-v3.pdf"]').trigger('click');
    await flushPromises();
    await w!
      .get('[data-testid="document-delete-row"]')
      .findAll('button')
      .find((b) => b.text() === 'Delete document')!
      .trigger('click');
    await flushPromises();
    const alert = w!.get('[data-testid="document-delete-row"] [data-testid="confirm-error"]');
    expect(alert.text()).toContain('Could not delete. The document is kept.');
    expect(alert.text()).toContain(refusal);
    expect(w!.findAll('[data-testid="document-row"]')).toHaveLength(1);
  });

  it('keeps Delete disabled when only an older configuration version has it (Phase 5b #8)', async () => {
    await page('documents', 'document-in-older-version');
    const row = w!.get('[data-testid="document-row"]');
    expect(flat('[data-testid="kept-by"]')).toBe('kept by an older version of with-skill');
    expect(row.text()).toContain('None now');
    const del = w!.get('button[aria-label="Delete vendor-policy-v3.pdf"]');
    expect(del.attributes('disabled')).toBeDefined();
    expect(del.attributes('aria-description')).toBe(
      'Part of a saved version of with-skill. A configuration version keeps the document it was saved with, so it cannot be deleted.',
    );
  });

  it('is one drop target when empty', async () => {
    await page('documents', 'empty');
    expect(flat('[data-testid="empty-state"]')).toBe(
      'No documents Documents are reference files a configuration can give the agent in every run, such as a policy PDF. Drop files here or choose them. Upload document',
    );
    expect(w!.find('table').exists()).toBe(false);
  });
});

describe('MCP servers tab', () => {
  it('lists invoice-db and vendor-api', async () => {
    await page('mcp');
    expect(w!.findAll('thead th').map((th) => th.text())).toEqual([
      'Name',
      'Transport',
      'Endpoint or command',
      'Tool filter',
      'Defined',
      'Used by',
    ]);
    expect(cells(0)).toEqual([
      'invoice-db',
      'stdio',
      'npx invoice-db-mcp',
      'include list_invoices, get_invoice · 2 of 4 tools',
      '22 Oct 17:05',
      '1 configuration',
    ]);
    expect(cells(1)).toEqual([
      'vendor-api',
      'http',
      'https://vendor-api.example.com/mcp · header Authorization ("Bearer " + value)',
      'all tools',
      '23 Oct 10:12',
      '0',
    ]);
  });

  it('opens the form from the header, and an edit from a row', async () => {
    await page('mcp');
    expect(headerButton().textContent?.trim()).toBe('Define MCP server');
    headerButton().click();
    await flushPromises();
    expect(router.currentRoute.value.query.mcp).toBe('new');
    expect(w!.get('[data-testid="mcp-form"] h2').text()).toBe('Define MCP server');

    await w!.findAll('tbody tr')[0]!.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.mcp).toBe(MCP_INVOICE_DB_ID);
    expect(w!.get('[data-testid="mcp-form"] h2').text()).toBe('Edit MCP server');
    expect(w!.get('[data-testid="version-notice"]').text()).toContain('Saving creates version 2.');
    await w!
      .findAll('button')
      .find((b) => b.text() === 'Cancel')!
      .trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.mcp).toBeUndefined();
    expect(w!.find('[data-testid="mcp-form"]').exists()).toBe(false);
  });

  it('saves a new version under the same row and flashes it', async () => {
    const { store } = await page('mcp', null, `?mcp=${MCP_INVOICE_DB_ID}`);
    await w!.get('input[inputmode="numeric"]').setValue('45');
    await w!.get('[data-testid="save-mcp"]').trigger('click');
    await flushPromises();
    expect(w!.find('[data-testid="mcp-form"]').exists()).toBe(false);
    expect(w!.findAll('tbody tr')).toHaveLength(2);
    expect(store.mcpServers.byId[MCP_INVOICE_DB_ID]?.version).toBe(2);
    expect(w!.findAll('tbody tr')[0]!.classes()).toContain('animate-flash');
    // The form scrolled itself into view when it opened; the saved row comes last.
    expect(scrolledIntoView[scrolledIntoView.length - 1]).toBe(w!.findAll('tbody tr')[0]!.element);
    // Saved without a test: the row says so.
    expect(cells(0)[0]).toBe('invoice-db untested');
  });

  it('marks a server whose last test failed', async () => {
    await page('mcp', 'mcp-test-failed');
    const chip = w!.findAll('tbody tr')[0]!.get('[data-kind="mcpTest"]');
    expect(chip.text()).toBe('failed');
  });

  it('explains MCP servers when there are none', async () => {
    await page('mcp', 'empty');
    const empty = w!.get('[data-testid="empty-state"]');
    expect(flat('[data-testid="empty-state"]')).toBe(
      'No MCP servers defined Define a server once, then include it in configurations. Use stdio for servers that should start fresh in every run, or http for servers you host. Define MCP server',
    );
    expect(empty.get('a').attributes('href')).toBe('/resources/mcp?mcp=new');
  });
});

describe('Secrets tab', () => {
  it('shows each name, who reads it and who can read it, never a value', async () => {
    await page('secrets');
    expect(w!.text()).toContain(
      'Secret values never pass through this app. It only shows which names are set for the worker and egress.',
    );
    expect(headerButton().textContent?.trim()).toBe('Check again');
    expect(cells(0)).toEqual([
      'INVOICE_DB_URL',
      'set',
      'worker environment',
      'invoice-db stdio MCP server · env',
      'Readable by the agent',
      '23 Oct 15:02 at worker start',
    ]);
    expect(cells(1)).toEqual([
      'VENDOR_API_TOKEN',
      'set',
      'egress environment',
      'vendor-api http MCP server · header Authorization',
      'Added by egress · never in the run',
      '23 Oct 15:02 at worker start',
    ]);
    expect(w!.findAll('tbody a')[0]!.attributes('href')).toBe(
      `/resources/mcp?mcp=${MCP_INVOICE_DB_ID}`,
    );
    expect(w!.find('[data-testid="not-set-warning"]').exists()).toBe(false);
    const how = w!.get('aside');
    expect(how.get('h2').text()).toBe('How to set a secret');
    expect(how.findAll('[data-testid="code-block"]').map((c) => c.text())).toEqual([
      'INVOICE_DB_URL=[YOUR VALUE]',
      'docker compose up -d egress worker',
    ]);
    expect(how.text()).toContain('they show <from env INVOICE_DB_URL>.');
    expect(w!.find('input').exists()).toBe(false);
  });

  it('checks again on request', async () => {
    await page('secrets');
    headerButton().click();
    await flushPromises();
    expect(cells(0)[5]).toBe('23 Oct 15:50 on request');
  });

  it('warns about a name that is not set', async () => {
    await page('secrets', 'secret-not-set');
    expect(cells(0)[1]).toBe('not set');
    expect(w!.findAll('tbody tr')[0]!.get('[data-kind="secret"]').attributes('data-tone')).toBe(
      'ung',
    );
    const warning = w!.get('[data-testid="not-set-warning"]');
    expect(warning.attributes('role')).toBe('status');
    expect(warning.text()).toBe(
      'INVOICE_DB_URL is not set. Runs of configurations that include invoice-db will fail at setup until it is.',
    );
  });

  it('explains secrets when no server references one', async () => {
    await page('secrets', 'empty');
    expect(w!.findAll('thead th').map((th) => th.text())).toEqual([
      'Name',
      'Value',
      'Source',
      'Referenced by',
      'Last checked',
    ]);
    expect(flat('[data-testid="empty-state"]')).toBe(
      'No secrets referenced A name appears here when an MCP server lists it as an environment variable or header. The app then shows whether it is set, never its value. Define MCP server',
    );
  });
});
