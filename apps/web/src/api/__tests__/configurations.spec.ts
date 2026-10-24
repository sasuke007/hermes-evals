import { beforeEach, describe, expect, it } from 'vitest';
import {
  diffConfigurations,
  getConfiguration,
  getConfigurationDraft,
  getConfigurationFormOptions,
  listConfigurations,
  saveConfiguration,
} from '@/api/configurations';
import { CONFIG_IDS, CONFIG_VERSION_IDS } from '@/fixtures/configurations';
import { setScenario, settledWithin } from './scenario';

beforeEach(() => setScenario(null));

describe('configurations', () => {
  it('lists baseline, with-skill and with-mcp at v1 with their usage', async () => {
    const rows = await listConfigurations();
    expect(rows.map((r) => [r.name, r.latest.version, r.usedInExperiments])).toEqual([
      ['baseline', 1, 6],
      ['with-skill', 1, 3],
      ['with-mcp', 1, 4],
    ]);
    expect(rows[0]!.latest).toMatchObject({
      model: 'openai/gpt-6.1-sol',
      provider: 'nous',
      toolsets: ['file', 'terminal'],
      memoryEnabled: false,
      skills: [],
      mcpServers: [],
      maxTurns: 20,
      timeBudgetS: 300,
    });
    expect(rows[1]!.latest.skills.map((s) => `${s.name}@${s.version}`)).toEqual([
      'invoice-method@1.0.0',
    ]);
    expect(rows[2]!.latest.mcpServers.map((m) => `${m.name} (${m.transport})`)).toEqual([
      'invoice-db (stdio)',
    ]);
  });

  it('gives with-skill detail as the Configuration detail board draws it', async () => {
    const detail = await getConfiguration(CONFIG_IDS['with-skill']);
    expect(detail.duplicatedFrom).toMatchObject({ name: 'baseline', version: 1 });
    expect(detail.differsFromSource).toEqual(['skills']);
    expect(detail.shown.change).toBe(
      'Duplicated from baseline v1; added skill invoice-method@1.0.0',
    );
    expect(detail.shown.configHash.startsWith('e81b44a0')).toBe(true);
    expect(
      detail.usedIn.map((u) => [
        u.experimentName,
        u.status,
        u.passRate,
        u.scored,
        u.total,
        u.verdict,
      ]),
    ).toEqual([
      ['Skill + MCP, invoices-v1', 'running', 0.846, 13, 60, 'provisional'],
      ['Skill vs no skill, invoices-v1', 'completed', 0.85, 60, 60, 'better'],
      ['Skill vs no skill, quick check', 'paused', 0.8, 5, 12, 'not_computable'],
    ]);
    expect(detail.usedIn[1]!.baselinePassRate).toBe(0.633);
  });

  it('opens a frozen version and rejects one that does not exist', async () => {
    await expect(getConfiguration(CONFIG_IDS.baseline, 1)).resolves.toMatchObject({
      name: 'baseline',
    });
    await expect(getConfiguration(CONFIG_IDS.baseline, 7)).rejects.toThrow('→ 404');
  });

  it('diffs versions: 1 field differs: skills', async () => {
    const diff = await diffConfigurations([
      CONFIG_VERSION_IDS.baseline,
      CONFIG_VERSION_IDS['with-skill'],
    ]);
    expect(diff.differing).toEqual(['skills']);
    expect(diff.rows.find((r) => r.field === 'skills')).toEqual({
      field: 'skills',
      values: ['—', 'invoice-method@1.0.0'],
      differs: true,
    });
    expect(diff.rows[0]).toMatchObject({ field: 'name', differs: false });
    const three = await diffConfigurations(Object.values(CONFIG_VERSION_IDS));
    expect(three.differing).toEqual(['skills', 'mcp_servers']);
  });

  it('offers the form its models, providers and the 17 runtime toolsets', async () => {
    const options = await getConfigurationFormOptions();
    expect(options.toolsets).toHaveLength(17);
    expect(options.toolsets.filter((t) => t.defaultOn).map((t) => t.name)).toEqual([
      'file',
      'terminal',
    ]);
    expect(options.models).toEqual([
      {
        id: 'openai/gpt-6.1-sol',
        price: { inputPer1M: 0.6, outputPer1M: 2.4, checkedAt: '2026-10-20' },
      },
    ]);
    expect(options.providers.map((p) => p.id)).toEqual([
      'nous',
      'nous-api',
      'openrouter',
      'openai',
      'anthropic',
      'custom',
    ]);
    expect(options.skills.map((s) => s.name)).toEqual(['invoice-method']);
    expect(options.mcpServers.map((m) => `${m.name} (${m.transport})`)).toEqual([
      'invoice-db (stdio)',
      'vendor-api (http)',
    ]);
  });

  it('drafts an edit of a used version as version 2', async () => {
    const draft = await getConfigurationDraft('edit', CONFIG_IDS['with-skill']);
    expect([draft.createsNewVersion, draft.nextVersion]).toEqual([true, 2]);
    expect(draft.experimentsKeepingVersion.map((e) => e.name)).toEqual([
      'Skill + MCP, invoices-v1',
      'Skill vs no skill, invoices-v1',
      'Skill vs no skill, quick check',
    ]);
    // with-skill was duplicated from baseline v1; editing keeps that origin.
    expect(draft.values.duplicatedFromVersionId).toBe(CONFIG_VERSION_IDS.baseline);
    const duplicate = await getConfigurationDraft('duplicate', CONFIG_IDS.baseline);
    expect(duplicate.values.name).toBe('baseline-copy');
    expect(duplicate.values.duplicatedFromVersionId).toBe(CONFIG_VERSION_IDS.baseline);
    const fresh = await getConfigurationDraft('new');
    expect(fresh.values).toMatchObject({
      name: '',
      toolsets: ['file', 'terminal'],
      memoryEnabled: false,
      duplicatedFromVersionId: null,
    });
  });

  it('saves: a new version for a used configuration, 409 for a taken name', async () => {
    const draft = await getConfigurationDraft('edit', CONFIG_IDS['with-skill']);
    await expect(
      saveConfiguration({ ...draft.values, memoryEnabled: true }, CONFIG_IDS['with-skill']),
    ).resolves.toMatchObject({ version: 2, createdNewVersion: true });
    await expect(saveConfiguration({ ...draft.values, name: 'baseline' })).rejects.toThrow(
      'POST /api/configurations → 409 · a configuration named baseline already exists',
    );
  });

  it('is empty in the empty scenario and honours loading', async () => {
    setScenario('empty');
    expect(await listConfigurations()).toEqual([]);
    setScenario('loading');
    expect(await settledWithin(listConfigurations())).toBe('pending');
  });
});
