/**
 * The resources store on fixtures: per-tab loads and their errors, and every write put into
 * the records at once (in the API's order), flashed, and followed by fresh counts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  MCP_INVOICE_DB_ID,
  MCP_INVOICE_DB_INPUT,
  SKILL_INVOICE_METHOD_110_ID,
  SKILL_INVOICE_METHOD_ID,
} from '@/fixtures/resources';
import { FLASH_MS, secretKey, useResourcesStore } from '@/stores/resources';
import { useScenario } from './scenarioEnv';

function store() {
  setActivePinia(createPinia());
  return useResourcesStore();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('resources store', () => {
  beforeEach(() => useScenario(null));

  it('loads what each tab shows, and the counts', async () => {
    const s = store();
    await s.loadTab('skills');
    expect(s.counts).toEqual({ skills: 1, documents: 1, mcpServers: 2, secrets: 2 });
    expect(s.skillRows.map((r) => r.name)).toEqual(['invoice-method']);
    expect(s.skills.loaded).toBe(true);
    expect(s.documents.loaded).toBe(false);
    await s.loadTab('mcp');
    expect(s.mcpServerRows.map((r) => r.name)).toEqual(['invoice-db', 'vendor-api']);
    // The MCP form says whether a variable is set, so the tab reads secrets too.
    expect(s.secretFor('INVOICE_DB_URL', 'worker')?.set).toBe(true);
    expect(s.secretFor('INVOICE_DB_URL', 'egress')).toBeNull();
    expect(Object.keys(s.secrets.byId)).toEqual([
      secretKey({ name: 'INVOICE_DB_URL', source: 'worker' }),
      secretKey({ name: 'VENDOR_API_TOKEN', source: 'egress' }),
    ]);
  });

  it('adds a confirmed skill in the API order and flashes it', async () => {
    vi.useFakeTimers();
    useScenario('upload-new-version');
    const s = store();
    await s.loadSkills();
    const validation = await s.validateSkill(new File(['PK'], 'invoice-method.zip'));
    const row = await s.confirmSkill(validation.token!);
    expect(row.id).toBe(SKILL_INVOICE_METHOD_110_ID);
    // Same name: the newer upload first.
    expect(s.skillRows.map((r) => r.id)).toEqual([
      SKILL_INVOICE_METHOD_110_ID,
      SKILL_INVOICE_METHOD_ID,
    ]);
    expect(s.flashId).toBe(row.id);
    await vi.advanceTimersByTimeAsync(FLASH_MS);
    expect(s.flashId).toBeNull();
  });

  it('adds an uploaded document', async () => {
    const s = store();
    await s.loadDocuments();
    const row = await s.uploadDocument(
      new File(['# terms'], 'terms.md', { type: 'text/markdown' }),
    );
    expect(s.documentRows.map((r) => r.filename)).toEqual(['terms.md', 'vendor-policy-v3.pdf']);
    expect(s.flashId).toBe(row.id);
  });

  it('saves a frozen server as its next version in place, and records a saved test', async () => {
    const s = store();
    await s.loadMcpServers();
    const saved = await s.saveMcpServer(
      { ...MCP_INVOICE_DB_INPUT, timeoutS: 45 },
      MCP_INVOICE_DB_ID,
    );
    expect(saved.version).toBe(2);
    expect(s.mcpServerRows).toHaveLength(2);
    expect(s.mcpServers.byId[MCP_INVOICE_DB_ID]).toMatchObject({ version: 2, timeoutS: 45 });
    expect(s.mcpServers.byId[MCP_INVOICE_DB_ID]?.lastTest.status).toBe('untested');
    const result = await s.testMcpServer({ id: MCP_INVOICE_DB_ID });
    expect(result.status).toBe('passed');
    expect(s.mcpServers.byId[MCP_INVOICE_DB_ID]?.lastTest).toEqual(result);
    // A new server lands in name order.
    await s.saveMcpServer({ ...MCP_INVOICE_DB_INPUT, name: 'ledger' });
    expect(s.mcpServerRows.map((r) => r.name)).toEqual(['invoice-db', 'ledger', 'vendor-api']);
  });

  it('does not record a test of an unsaved definition on any row', async () => {
    useScenario('mcp-test-failed');
    const s = store();
    await s.loadMcpServers();
    const before = s.mcpServers.byId[MCP_INVOICE_DB_ID]?.lastTest;
    const result = await s.testMcpServer({ ...MCP_INVOICE_DB_INPUT, name: 'scratch' });
    expect(result.status).toBe('failed');
    expect(s.mcpServers.byId[MCP_INVOICE_DB_ID]?.lastTest).toEqual(before);
  });

  it('checks secrets again on request', async () => {
    useScenario('secret-not-set');
    const s = store();
    await s.loadSecrets();
    expect(s.secretRows.map((r) => [r.name, r.set, r.checkedWhen])).toEqual([
      ['INVOICE_DB_URL', false, 'at worker start'],
      ['VENDOR_API_TOKEN', true, 'at worker start'],
    ]);
    const checking = s.checkSecrets();
    expect(s.checking).toBe(true);
    await checking;
    expect(s.checking).toBe(false);
    expect(s.secretRows.map((r) => r.checkedWhen)).toEqual(['on request', 'on request']);
  });

  it('keeps a load error per kind, with the request verbatim', async () => {
    useScenario('error');
    const s = store();
    await s.loadTab('documents');
    expect(s.documents.error).toBe(
      'GET /api/resources/documents → 502 · upstream api:8080 connection refused',
    );
    expect(s.documents.loaded).toBe(false);
    expect(s.skills.error).toBeNull();
    expect(s.counts).toBeNull();
  });

  it('loads a skill and its files once', async () => {
    const s = store();
    await s.loadSkillDetail(SKILL_INVOICE_METHOD_ID);
    expect(s.skillDetails[SKILL_INVOICE_METHOD_ID]?.value?.files).toHaveLength(4);
    await s.loadSkillFile(SKILL_INVOICE_METHOD_ID, 'checklist.md');
    expect(s.skillFile(SKILL_INVOICE_METHOD_ID, 'checklist.md')?.value?.content).toContain(
      '# Columns this method expects',
    );
    await s.loadSkillDetail('skill_missing');
    expect(s.skillDetails.skill_missing?.error).toBe(
      'GET /api/resources/skills/skill_missing → 404 · skill skill_missing not found',
    );
  });
});
