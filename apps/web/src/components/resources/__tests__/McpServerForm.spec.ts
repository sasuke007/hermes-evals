import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import McpServerForm from '../McpServerForm.vue';
import type { McpServerRow } from '@/api/types/resources';
import { MCP_INVOICE_DB, MCP_INVOICE_DB_ID, MCP_VENDOR_API } from '@/fixtures/resources';
import { mountResources } from './mountResources';

let w: VueWrapper | null = null;
afterEach(() => {
  w?.unmount();
  w = null;
});

async function form(server: McpServerRow | null, scenario: string | null = null) {
  const mounted = await mountResources(McpServerForm, {
    path: '/resources/mcp',
    props: { server },
    scenario,
  });
  w = mounted.w;
  await mounted.store.loadTab('mcp');
  await flushPromises();
  return mounted;
}
const text = (testid: string) => w!.get(`[data-testid="${testid}"]`).text();
const nameInput = () => w!.get('input[autocomplete="off"]');
async function type(selector: string, value: string, enter = true) {
  const input = w!.get(selector);
  await input.setValue(value);
  if (enter) await input.trigger('keydown', { key: 'Enter' });
}

describe('McpServerForm, create', () => {
  it('defines a stdio server: transport cards, the caution, names only', async () => {
    await form(null);
    expect(w!.get('h2').text()).toBe('Define MCP server');
    expect(w!.find('[data-testid="version-notice"]').exists()).toBe(false);
    const cards = w!.get('[role="radiogroup"]').findAll('label');
    expect(cards.map((c) => c.find('b').text())).toEqual(['stdio', 'http']);
    expect(cards[0]!.text()).toContain(
      "Started fresh for every run, inside that run's sandboxed container, and stopped when the run ends. No state carries between runs.",
    );
    expect(cards[1]!.text()).toContain(
      "Hosted by you and reached over the network. It is not reset between runs, so runs can see each other's writes.",
    );
    expect(text('stdio-caution')).toContain(
      "This server runs inside each run's container. The agent can read these values. Use scoped or throwaway values. Values stay in .env and are never typed, stored or shown here; see Resources › Secrets to check or set one.",
    );
    // A known name says whether the worker has it.
    await type('input[aria-label="Add variable name"]', 'invoice_db_url');
    expect(w!.findAll('[data-testid="chip"]').map((c) => c.text())).toEqual(['INVOICE_DB_URL ×']);
    expect(text('stdio-caution')).toMatch(/INVOICE_DB_URL is set\.$/);
    expect(w!.get('[data-testid="save-mcp"]').text()).toBe('Save MCP server');
    expect(w!.find('input[type="password"]').exists()).toBe(false);
  });

  it('switches to http: the URL, header pairs and the egress note', async () => {
    await form(null);
    await w!.findAll('input[type="radio"]')[1]!.setValue(true);
    expect(w!.find('[data-testid="stdio-caution"]').exists()).toBe(false);
    expect(text('http-note')).toBe(
      'Egress adds these headers to each request on the way to the server. The run never sees their values. Values stay in .env; see Resources › Secrets.',
    );
    await type('input[aria-label="Add header name"]', 'Authorization', false);
    await type('input[aria-label="Variable egress reads the value from"]', 'vendor_api_token');
    expect(w!.findAll('[data-testid="chip"]').map((c) => c.text())).toEqual([
      'Authorization ← VENDOR_API_TOKEN ×',
    ]);
    expect(w!.text()).toContain(
      'Connects once through egress, as a run would, and lists its tools.',
    );
  });

  it('adds a header with a prefix, so .env holds the raw token (Phase 6 question 6)', async () => {
    await form(null);
    await w!.findAll('input[type="radio"]')[1]!.setValue(true);
    expect(text('prefix-hint')).toBe(
      'An optional prefix, such as Bearer, is written before the value, so .env holds the raw token.',
    );
    // Enter moves from the header to the prefix, then to the variable.
    await type('input[aria-label="Add header name"]', 'Authorization');
    const prefix = w!.get('input[aria-label="Prefix egress writes before the value (optional)"]');
    expect(document.activeElement).toBe(prefix.element);
    await type('input[aria-label="Prefix egress writes before the value (optional)"]', 'Bearer');
    await type(
      'input[aria-label="Variable egress reads the value from"]',
      'vendor_directory_token',
    );
    await type('input[aria-label="Add header name"]', 'X-Team', false);
    await type('input[aria-label="Variable egress reads the value from"]', 'team_id');
    expect(w!.findAll('[data-testid="chip"]').map((c) => c.text())).toEqual([
      'Authorization ← "Bearer " + VENDOR_DIRECTORY_TOKEN ×',
      'X-Team ← TEAM_ID ×',
    ]);
  });

  it('refuses a prefix the shared schema refuses', async () => {
    await form(null);
    await nameInput().setValue('vendor-directory');
    await w!.findAll('input[type="radio"]')[1]!.setValue(true);
    await w!.findAll('input.input')[1]!.setValue('http://vendor-directory:8000/mcp');
    await type('input[aria-label="Add header name"]', 'Authorization', false);
    await type(
      'input[aria-label="Prefix egress writes before the value (optional)"]',
      'Bearér',
      false,
    );
    await type('input[aria-label="Variable egress reads the value from"]', 'token');
    await w!.get('form').trigger('submit');
    await flushPromises();
    expect(w!.text()).toContain(
      'a prefix is 1 to 64 printable ASCII characters, such as "Bearer "',
    );
    expect(w!.emitted('saved')).toBeUndefined();
  });

  it('checks the form with the shared schema before saving', async () => {
    const { store } = await form(null);
    await nameInput().setValue('Invoice DB');
    await w!.get('form').trigger('submit');
    await flushPromises();
    expect(w!.text()).toContain('use lowercase letters, digits, - and _ (at most 63 characters)');
    expect(w!.text()).toContain('a stdio server needs a command');
    expect(nameInput().attributes('aria-invalid')).toBe('true');
    expect(store.mcpServerRows).toHaveLength(2);
  });

  it('puts a taken name (409) under the Name field', async () => {
    await form(null);
    await nameInput().setValue('vendor-api');
    await w!.findAll('input.input')[1]!.setValue('npx');
    await w!.get('form').trigger('submit');
    await flushPromises();
    expect(w!.text()).toContain('an MCP server named vendor-api already exists');
    expect(w!.emitted('saved')).toBeUndefined();
  });

  it('saves a new server', async () => {
    const { store } = await form(null);
    await nameInput().setValue('ledger');
    const [, command, args] = w!.findAll('input.input');
    await command!.setValue('npx');
    await args!.setValue('ledger-mcp --db "my file.db"');
    await w!.get('form').trigger('submit');
    await flushPromises();
    const [saved] = w!.emitted('saved')![0] as [McpServerRow];
    expect(saved).toMatchObject({
      name: 'ledger',
      command: 'npx',
      args: ['ledger-mcp', '--db', 'my file.db'],
    });
    expect(store.flashId).toBe(saved.id);
  });

  it('tests what the form holds and lists the tools', async () => {
    await form(null);
    await nameInput().setValue('invoice-db-copy');
    await w!.findAll('input.input')[1]!.setValue('npx');
    await type('input[aria-label="Add included tool"]', 'list_invoices, get_invoice');
    await w!.get('[data-testid="test-start"]').trigger('click');
    await flushPromises();
    const result = w!.get('[data-testid="mcp-test-result"]');
    expect(result.attributes('data-status')).toBe('passed');
    expect(result.find('b').text()).toBe('Started in 1.8 s · exposes 4 tools · 2 included');
    expect(result.findAll('.tag').map((t) => t.text())).toEqual([
      'list_invoices ✓',
      'get_invoice ✓',
      'update_invoice',
      'delete_invoice',
    ]);
    expect(result.text()).toContain('The excluded tools will not be offered to the agent.');
  });

  it('keeps a passing test of the unsaved form on its save (Phase 5 question 14)', async () => {
    const { store } = await form(null);
    await nameInput().setValue('invoice-db-copy');
    await w!.findAll('input.input')[1]!.setValue('npx');
    await w!.get('[data-testid="test-start"]').trigger('click');
    await flushPromises();
    expect(w!.get('[data-testid="mcp-test-result"]').attributes('data-status')).toBe('passed');
    await w!.get('form').trigger('submit');
    await flushPromises();
    const [saved] = w!.emitted('saved')![0] as [McpServerRow];
    expect(saved.lastTest).toMatchObject({ status: 'passed', startedMs: 1800 });
    expect(saved.lastTest).not.toHaveProperty('definitionHash');
    expect(store.mcpServers.byId[saved.id]!.lastTest.status).toBe('passed');
  });

  it('reads untested after saving a definition other than the one tested', async () => {
    await form(null);
    await nameInput().setValue('invoice-db-other');
    await w!.findAll('input.input')[1]!.setValue('npx');
    await w!.get('[data-testid="test-start"]').trigger('click');
    await flushPromises();
    await w!.findAll('input.input')[1]!.setValue('npx-changed');
    await w!.get('form').trigger('submit');
    await flushPromises();
    const [saved] = w!.emitted('saved')![0] as [McpServerRow];
    expect(saved.lastTest).toEqual({ status: 'untested' });
  });

  it('shows a failed start with stderr and where to set the variable', async () => {
    await form(null, 'mcp-test-failed');
    await nameInput().setValue('invoice-db-copy');
    await w!.findAll('input.input')[1]!.setValue('npx');
    await type('input[aria-label="Add variable name"]', 'INVOICE_DB_URL');
    expect(text('stdio-caution')).toMatch(/INVOICE_DB_URL is not set\.$/);
    await w!.get('[data-testid="test-start"]').trigger('click');
    await flushPromises();
    const result = w!.get('[data-testid="mcp-test-result"]');
    expect(result.attributes('role')).toBe('alert');
    expect(result.find('b').text()).toBe('Exited with code 1 after 0.6 s · no tools listed');
    expect(result.get('[data-testid="code-block"]').text()).toContain(
      'Error: INVOICE_DB_URL is not set',
    );
    expect(result.text()).toContain(
      'The variable name is declared, but the worker environment has no value for it. Resources › Secrets shows it as not set and explains how to add it; then test again.',
    );
    expect(w!.text()).toContain(
      'Saving is still allowed, because the server may only work inside a full run. The row then carries an "untested" tag.',
    );
  });
});

describe('McpServerForm, edit', () => {
  it('warns that saving a server in use creates version 2', async () => {
    await form(MCP_INVOICE_DB);
    expect(w!.get('h2').text()).toBe('Edit MCP server');
    expect(w!.text()).toContain('invoice-db · v1');
    expect(text('version-notice')).toBe(
      'Saving creates version 2. Configurations that use version 1 keep it. invoice-db v1 is used by with-mcp.',
    );
    expect(w!.get('[data-testid="save-mcp"]').text()).toBe('Save as version 2');
    // The saved definition's last test is shown until the form changes.
    expect(w!.get('[data-testid="mcp-test-result"]').find('b').text()).toBe(
      'Started in 1.8 s · exposes 4 tools · 2 included',
    );
    await w!.get('input[inputmode="numeric"]').setValue('45');
    expect(w!.find('[data-testid="mcp-test-result"]').exists()).toBe(false);
  });

  it('tests an unchanged server by id, so its row records the result', async () => {
    const { store } = await form(MCP_INVOICE_DB, 'mcp-test-failed');
    expect(w!.get('[data-testid="mcp-test-result"]').attributes('data-status')).toBe('failed');
    expect(w!.text()).not.toContain('Saving is still allowed');
    await w!.get('[data-testid="test-start"]').trigger('click');
    await flushPromises();
    expect(store.mcpServers.byId[MCP_INVOICE_DB_ID]?.lastTest.status).toBe('failed');
  });

  it('edits a server nobody uses in place', async () => {
    await form(MCP_VENDOR_API);
    expect(text('version-notice')).toBe(
      'Saving changes version 1 in place. vendor-api v1 is not used by any configuration yet.',
    );
    expect(w!.get('[data-testid="save-mcp"]').text()).toBe('Save changes');
    expect(w!.findAll('[data-testid="chip"]').map((c) => c.text())).toEqual([
      'Authorization ← "Bearer " + VENDOR_API_TOKEN ×',
    ]);
    expect(w!.get('[data-testid="mcp-test-result"]').find('b').text()).toBe(
      'Connected through egress in 0.9 s · exposes 3 tools · all included',
    );
    await w!.get('[data-testid="save-mcp"]').trigger('click');
    await flushPromises();
    expect((w!.emitted('saved')![0] as [McpServerRow])[0].version).toBe(1);
  });

  it('cancels', async () => {
    await form(MCP_INVOICE_DB);
    await w!
      .findAll('button')
      .find((b) => b.text() === 'Cancel')!
      .trigger('click');
    expect(w!.emitted('cancel')).toHaveLength(1);
  });
});
