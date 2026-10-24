import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkSecrets,
  confirmSkillUpload,
  getResourceCounts,
  getSkill,
  getSkillFile,
  listDocuments,
  listMcpServers,
  listSecrets,
  listSkills,
  saveMcpServer,
  testMcpServer,
  uploadDocument,
  validateSkillUpload,
} from '@/api/resources';
import {
  MCP_INVOICE_DB_ID,
  MCP_INVOICE_DB_INPUT,
  MCP_VENDOR_API_ID,
  MCP_VENDOR_API_INPUT,
  SKILL_INVOICE_METHOD_ID,
} from '@/fixtures/resources';
import { setScenario, settledWithin } from './scenario';

const zip = () => new File(['PK'], 'invoice-method.zip', { type: 'application/zip' });

beforeEach(() => setScenario(null));

describe('skills', () => {
  it('lists invoice-method 1.0.0 and opens its detail', async () => {
    const [skill] = await listSkills();
    expect(skill).toMatchObject({
      name: 'invoice-method',
      version: '1.0.0',
      description:
        'Method for reconciling vendor invoices: always check credit notes, duplicates and partial payments before totalling',
      fileCount: 4,
      uploadedAt: '2026-10-22T09:48:21',
      usedBy: [{ name: 'with-skill' }],
    });
    expect(skill!.contentHash.startsWith('9c41e07d')).toBe(true);
    const detail = await getSkill(SKILL_INVOICE_METHOD_ID);
    expect(detail.files.map((f) => f.path)).toEqual([
      'SKILL.md',
      'checklist.md',
      'examples/reconcile.py',
      'examples/sample.csv',
    ]);
    expect(detail.skillMd.body).toContain('Load the whole file with `read_file`.');
    const file = await getSkillFile(SKILL_INVOICE_METHOD_ID, 'checklist.md');
    expect(file.content).toContain('# Columns this method expects');
  });

  it('validates a first upload and confirms it', async () => {
    const result = await validateSkillUpload(zip());
    expect(result.outcome).toBe('valid');
    expect(result.token).not.toBeNull();
    expect(result.checks.map((c) => c.label)).toEqual([
      'SKILL.md',
      'name',
      'version',
      'description',
      'files',
      'content hash',
    ]);
    expect(result.checks[4]!.value).toBe('4 files · 18.2 KB unpacked');
    await expect(confirmSkillUpload(result.token!)).resolves.toMatchObject({
      name: 'invoice-method',
    });
  });

  it('accepts a new version as 1.1.0', async () => {
    setScenario('upload-new-version');
    const result = await validateSkillUpload(zip());
    expect(result).toMatchObject({
      outcome: 'new_version',
      version: '1.1.0',
      existing: { version: '1.0.0' },
    });
    await expect(confirmSkillUpload(result.token!)).resolves.toMatchObject({ version: '1.1.0' });
  });

  it('refuses the same version with a different hash', async () => {
    setScenario('upload-same-version-different-hash');
    const result = await validateSkillUpload(zip());
    expect(result).toMatchObject({ outcome: 'conflict', token: null, version: '1.0.0' });
    expect(result.problems).toEqual([
      {
        title: 'Version 1.0.0 already exists with a different hash.',
        detail: 'Bump version: in SKILL.md.',
      },
    ]);
  });

  it('lists the problems of an invalid zip', async () => {
    setScenario('upload-invalid');
    const result = await validateSkillUpload(zip());
    expect(result).toMatchObject({
      outcome: 'invalid',
      token: null,
      fileName: 'invoice-method-folder.zip',
    });
    expect(result.problems.map((p) => p.title)).toEqual([
      'No SKILL.md at the zip root.',
      'No version in metadata.',
    ]);
  });
});

describe('documents', () => {
  it('lists vendor-policy-v3.pdf and uploads a file', async () => {
    const [doc] = await listDocuments();
    expect(doc).toMatchObject({
      filename: 'vendor-policy-v3.pdf',
      sizeBytes: 219136,
      typeLabel: 'PDF · 6 pages',
    });
    const uploaded = await uploadDocument(
      new File(['# terms'], 'terms.md', { type: 'text/markdown' }),
    );
    expect(uploaded).toMatchObject({
      filename: 'terms.md',
      sizeBytes: 7,
      typeLabel: 'Markdown',
      attachedTo: [],
    });
  });
});

describe('MCP servers', () => {
  it('lists invoice-db and tests it', async () => {
    const [server] = await listMcpServers();
    expect(server).toMatchObject({
      name: 'invoice-db',
      transport: 'stdio',
      command: 'npx',
      args: ['invoice-db-mcp'],
      envNames: ['INVOICE_DB_URL'],
      include: ['list_invoices', 'get_invoice'],
      timeoutS: 30,
      usedBy: [{ name: 'with-mcp' }],
      lastTest: { status: 'passed', startedMs: 1800 },
    });
    const test = await testMcpServer({ id: MCP_INVOICE_DB_ID });
    expect(test).toMatchObject({
      status: 'passed',
      tools: [
        { name: 'list_invoices', included: true },
        { name: 'get_invoice', included: true },
        { name: 'update_invoice', included: false },
        { name: 'delete_invoice', included: false },
      ],
    });
  });

  it('fails Test start when INVOICE_DB_URL is not set', async () => {
    setScenario('mcp-test-failed');
    const test = await testMcpServer(MCP_INVOICE_DB_INPUT);
    expect(test).toMatchObject({
      status: 'failed',
      error: 'Exited with code 1 after 0.6 s · no tools listed',
      missingSecretNames: ['INVOICE_DB_URL'],
    });
    expect((await listSecrets())[0]!.set).toBe(false);
  });

  it('lists vendor-api, an http server whose header egress adds', async () => {
    const servers = await listMcpServers();
    expect(servers.map((s) => s.name)).toEqual(['invoice-db', 'vendor-api']);
    expect(servers[1]).toMatchObject({
      transport: 'http',
      command: null,
      envNames: [],
      url: 'https://vendor-api.example.com/mcp',
      headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }],
      frozen: false,
      usedBy: [],
    });
    const test = await testMcpServer({ id: MCP_VENDOR_API_ID });
    expect(test.status === 'passed' && test.tools.map((t) => t.name)).toEqual([
      'lookup_vendor',
      'list_vendors',
      'get_vendor_terms',
    ]);
    // Not used by a configuration, so an edit changes version 1 in place.
    const edited = await saveMcpServer(
      { ...MCP_VENDOR_API_INPUT, include: ['lookup_vendor'] },
      MCP_VENDOR_API_ID,
    );
    expect([edited.version, edited.include, edited.lastTest.status]).toEqual([
      1,
      ['lookup_vendor'],
      'untested',
    ]);
  });

  it('saves a new server, and refuses a taken name', async () => {
    const saved = await saveMcpServer({ ...MCP_INVOICE_DB_INPUT, name: 'ledger' });
    expect(saved).toMatchObject({ name: 'ledger', version: 1, lastTest: { status: 'untested' } });
    await expect(saveMcpServer(MCP_INVOICE_DB_INPUT)).rejects.toThrow('409');
    await expect(saveMcpServer(MCP_VENDOR_API_INPUT)).rejects.toThrow(
      'an MCP server named vendor-api already exists',
    );
    const edited = await saveMcpServer(
      { ...MCP_INVOICE_DB_INPUT, timeoutS: 60 },
      MCP_INVOICE_DB_ID,
    );
    expect([edited.version, edited.timeoutS]).toEqual([2, 60]);
  });
});

describe('secrets', () => {
  it('shows INVOICE_DB_URL from the worker and VENDOR_API_TOKEN from egress, never a value', async () => {
    const [invoiceDb, vendorApi] = await listSecrets();
    expect(invoiceDb).toEqual({
      name: 'INVOICE_DB_URL',
      set: true,
      source: 'worker',
      exposure: 'readable_by_agent',
      referencedBy: [
        { kind: 'mcp_server', id: MCP_INVOICE_DB_ID, name: 'invoice-db', via: 'env', header: null },
      ],
      lastCheckedAt: '2026-10-23T15:02:00',
      checkedWhen: 'at worker start',
    });
    expect(vendorApi).toEqual({
      name: 'VENDOR_API_TOKEN',
      set: true,
      source: 'egress',
      exposure: 'egress_only',
      referencedBy: [
        {
          kind: 'mcp_server',
          id: MCP_VENDOR_API_ID,
          name: 'vendor-api',
          via: 'header',
          header: 'Authorization',
        },
      ],
      lastCheckedAt: '2026-10-23T15:02:00',
      checkedWhen: 'at worker start',
    });
    expect((await checkSecrets()).map((s) => s.checkedWhen)).toEqual(['on request', 'on request']);
  });

  it('shows the not-set state for the worker secret only', async () => {
    setScenario('secret-not-set');
    expect((await listSecrets()).map((s) => [s.name, s.set])).toEqual([
      ['INVOICE_DB_URL', false],
      ['VENDOR_API_TOKEN', true],
    ]);
  });
});

describe('library states', () => {
  it('counts each kind, and is empty in the empty scenario', async () => {
    expect(await getResourceCounts()).toEqual({
      skills: 1,
      documents: 1,
      mcpServers: 2,
      secrets: 2,
    });
    setScenario('empty');
    expect(await listSkills()).toEqual([]);
    expect(await listDocuments()).toEqual([]);
    expect(await listMcpServers()).toEqual([]);
    expect(await listSecrets()).toEqual([]);
  });

  it('honours loading and error', async () => {
    setScenario('loading');
    expect(await settledWithin(listSkills())).toBe('pending');
    setScenario('error');
    await expect(listSecrets()).rejects.toThrow('GET /api/resources/secrets → 502');
  });
});
