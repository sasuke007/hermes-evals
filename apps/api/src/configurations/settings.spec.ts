/**
 * The pure configuration rules: canonical order, the config hash, display
 * values, the diff table and history lines. Expected strings are the ones
 * the web fixtures (apps/web/src/fixtures/configurations.ts) show.
 */
import { describe, expect, it } from 'vitest';
import { ConfigDiffSchema, type ConfigVersionRef } from '@hermes-evals/shared';
import {
  changeNote,
  changeParts,
  configDiff,
  configHash,
  copyName,
  differingFields,
  fieldValue,
  normaliseToolsets,
  orderSettings,
  sameSettings,
  type ResolvedSettings,
} from './settings.js';

const hex = (c: string) => c.repeat(64);

const skill = (name: string, version: string, id = `skl_${name}_${version}`, hash = hex('a')) => ({
  skillId: id,
  name,
  version,
  contentHash: hash,
});

const doc = (filename: string, id = `doc_${filename}`, sha256 = hex('b')) => ({
  documentId: id,
  filename,
  sizeBytes: 219_136,
  sha256,
});

const mcp = (
  name: string,
  version = 1,
  transport: 'stdio' | 'http' = 'stdio',
  hash = hex('c'),
) => ({
  mcpServerId: `mcp_${name}`,
  versionId: `mcpv_${name}_${version}`,
  name,
  version,
  transport,
  definitionHash: hash,
});

const baseline: ResolvedSettings = {
  model: 'openai/gpt-6.1-sol',
  provider: 'nous',
  baseUrl: null,
  toolsets: ['file', 'terminal'],
  memoryEnabled: false,
  skills: [],
  skillLoading: 'preload',
  documents: [],
  mcpServers: [],
  maxTurns: 20,
  timeBudgetS: 300,
};

const ref = (name: string, version = 1): ConfigVersionRef => ({
  configurationId: `cfg_${name}`,
  versionId: `cfgv_${name}_${version}`,
  name,
  version,
});

describe('canonical order', () => {
  it('sorts and de-duplicates toolsets', () => {
    expect(normaliseToolsets(['terminal', 'file', 'terminal', 'web'])).toEqual([
      'file',
      'terminal',
      'web',
    ]);
  });

  it('orders resources by name, so the order the form sent does not matter', () => {
    const s = orderSettings({
      ...baseline,
      skills: [skill('zeta', '1.0.0'), skill('alpha', '2.0.0')],
      documents: [doc('b.pdf'), doc('a.md')],
      mcpServers: [mcp('vendor-api'), mcp('invoice-db')],
    });
    expect(s.skills.map((k) => k.name)).toEqual(['alpha', 'zeta']);
    expect(s.documents.map((d) => d.filename)).toEqual(['a.md', 'b.pdf']);
    expect(s.mcpServers.map((m) => m.name)).toEqual(['invoice-db', 'vendor-api']);
  });
});

describe('configHash', () => {
  it('is a sha256 that ignores list order but not content', () => {
    const a = configHash({ ...baseline, toolsets: ['terminal', 'file'] });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(configHash(baseline)).toBe(a);
    expect(configHash({ ...baseline, maxTurns: 21 })).not.toBe(a);
    expect(configHash({ ...baseline, memoryEnabled: true })).not.toBe(a);
  });

  it('follows the content of the resources, not their ids', () => {
    const withSkill = configHash({ ...baseline, skills: [skill('invoice-method', '1.0.0')] });
    // The same skill content re-uploaded under another id hashes the same...
    expect(
      configHash({ ...baseline, skills: [skill('invoice-method', '1.0.0', 'skl_other')] }),
    ).toBe(withSkill);
    // ...new content does not.
    expect(
      configHash({
        ...baseline,
        skills: [skill('invoice-method', '1.0.0', 'skl_x', hex('d'))],
      }),
    ).not.toBe(withSkill);
    const withDoc = configHash({ ...baseline, documents: [doc('policy.pdf')] });
    expect(configHash({ ...baseline, documents: [doc('policy.pdf', 'doc_2', hex('e'))] })).not.toBe(
      withDoc,
    );
    // The filename is what the agent sees in workspace/docs/, so it counts.
    expect(configHash({ ...baseline, documents: [doc('other.pdf')] })).not.toBe(withDoc);
    const withMcp = configHash({ ...baseline, mcpServers: [mcp('invoice-db')] });
    expect(
      configHash({ ...baseline, mcpServers: [mcp('invoice-db', 2, 'stdio', hex('f'))] }),
    ).not.toBe(withMcp);
  });

  // Computed with the configHash of Phase 5 (commit 660fff1), before skill
  // loading existed: every stored version holds such a hash, and estimates
  // from its attempts match on it, so `preload` must leave it unchanged.
  const skilled: ResolvedSettings = {
    ...baseline,
    skills: [skill('invoice-method', '1.0.0')],
    documents: [doc('policy.pdf')],
    mcpServers: [mcp('invoice-db')],
  };

  it('hashes a preload version exactly as before Phase 6', () => {
    expect(configHash(baseline)).toBe(
      'd9312275194154d6dfdd5288000d8cfc1676616755c3a71f11f0eedd3b55e71c',
    );
    expect(configHash(skilled)).toBe(
      '61ba05a085a5c5e1c17ccab1fc26e7b97813f39f1f2b61c0612bc04b8554aa56',
    );
  });

  it('hashes on demand loading differently from preload', () => {
    const onDemand = configHash({ ...skilled, skillLoading: 'on_demand' });
    expect(onDemand).toMatch(/^[0-9a-f]{64}$/);
    expect(onDemand).not.toBe(configHash(skilled));
    // Still a function of the settings alone.
    expect(configHash({ ...skilled, skillLoading: 'on_demand' })).toBe(onDemand);
  });
});

describe('sameSettings', () => {
  it('compares settings and resource ids, ignoring order', () => {
    expect(sameSettings(baseline, { ...baseline, toolsets: ['terminal', 'file'] })).toBe(true);
    expect(sameSettings(baseline, { ...baseline, model: 'other' })).toBe(false);
    expect(
      sameSettings(
        { ...baseline, skills: [skill('a', '1')] },
        { ...baseline, skills: [skill('a', '1', 'skl_other')] },
      ),
    ).toBe(false);
    const skilled = { ...baseline, skills: [skill('a', '1')] };
    expect(sameSettings(skilled, { ...skilled, skillLoading: 'on_demand' })).toBe(false);
  });
});

describe('fieldValue', () => {
  const withEverything: ResolvedSettings = {
    ...baseline,
    skills: [skill('invoice-method', '1.0.0')],
    documents: [doc('vendor-policy-v3.pdf')],
    mcpServers: [mcp('invoice-db')],
  };

  it('renders the strings ConfigDiffTable shows', () => {
    expect(fieldValue('baseline', baseline, 'name')).toBe('baseline');
    expect(fieldValue('baseline', baseline, 'toolsets')).toBe('file, terminal');
    expect(fieldValue('baseline', baseline, 'memory')).toBe('off');
    expect(fieldValue('baseline', baseline, 'skills')).toBe('—');
    expect(fieldValue('baseline', baseline, 'documents')).toBe('—');
    expect(fieldValue('baseline', baseline, 'mcp_servers')).toBe('—');
    expect(fieldValue('baseline', baseline, 'max_turns')).toBe('20');
    expect(fieldValue('baseline', baseline, 'time_budget_s')).toBe('300');
    expect(fieldValue('x', withEverything, 'skills')).toBe('invoice-method@1.0.0');
    expect(fieldValue('x', withEverything, 'documents')).toBe('vendor-policy-v3.pdf');
    expect(fieldValue('x', withEverything, 'mcp_servers')).toBe('invoice-db (stdio)');
    expect(fieldValue('x', { ...baseline, memoryEnabled: true, toolsets: [] }, 'memory')).toBe(
      'on',
    );
    expect(fieldValue('x', { ...baseline, toolsets: [] }, 'toolsets')).toBe('—');
  });

  it('shows skill loading as preload or on demand, preload without skills', () => {
    expect(fieldValue('x', baseline, 'skill_loading')).toBe('preload');
    expect(fieldValue('x', withEverything, 'skill_loading')).toBe('preload');
    expect(fieldValue('x', { ...withEverything, skillLoading: 'on_demand' }, 'skill_loading')).toBe(
      'on demand',
    );
  });

  it('shows where a custom provider points', () => {
    expect(fieldValue('x', baseline, 'provider')).toBe('nous');
    expect(
      fieldValue(
        'x',
        { ...baseline, provider: 'custom', baseUrl: 'https://llm.lan/v1' },
        'provider',
      ),
    ).toBe('custom (https://llm.lan/v1)');
  });
});

describe('configDiff', () => {
  it('has every field in order, name first and never differing', () => {
    const diff = configDiff([
      { ref: ref('baseline'), settings: baseline },
      {
        ref: ref('with-skill'),
        settings: { ...baseline, skills: [skill('invoice-method', '1.0.0')] },
      },
    ]);
    expect(ConfigDiffSchema.parse(diff)).toEqual(diff);
    expect(diff.rows.map((r) => r.field)).toEqual([
      'name',
      'model',
      'provider',
      'toolsets',
      'memory',
      'skills',
      'skill_loading',
      'documents',
      'mcp_servers',
      'max_turns',
      'time_budget_s',
    ]);
    expect(diff.rows[0]).toEqual({
      field: 'name',
      values: ['baseline', 'with-skill'],
      differs: false,
    });
    expect(diff.differing).toEqual(['skills']);
    expect(diff.rows.find((r) => r.field === 'skills')!.values).toEqual([
      '—',
      'invoice-method@1.0.0',
    ]);
    expect(diff.columns.map((c) => c.name)).toEqual(['baseline', 'with-skill']);
    // Adding a skill that preloads changes the skills alone, not their loading.
    expect(diff.rows.find((r) => r.field === 'skill_loading')).toEqual({
      field: 'skill_loading',
      values: ['preload', 'preload'],
      differs: false,
    });
  });

  it('has a Skill loading row that differs when only the mode does', () => {
    const skilled = { ...baseline, skills: [skill('invoice-method', '1.0.0')] };
    const diff = configDiff([
      { ref: ref('with-skill'), settings: skilled },
      { ref: ref('on-demand'), settings: { ...skilled, skillLoading: 'on_demand' } },
    ]);
    expect(diff.differing).toEqual(['skill_loading']);
    expect(diff.rows.find((r) => r.field === 'skill_loading')!.values).toEqual([
      'preload',
      'on demand',
    ]);
    // Against a version without skills, both the skills and their loading differ.
    expect(differingFields(baseline, { ...skilled, skillLoading: 'on_demand' })).toEqual([
      'skills',
      'skill_loading',
    ]);
  });

  it('marks a field that differs between any two of three columns', () => {
    const diff = configDiff([
      { ref: ref('a'), settings: baseline },
      { ref: ref('b'), settings: baseline },
      { ref: ref('c'), settings: { ...baseline, maxTurns: 40 } },
    ]);
    expect(diff.differing).toEqual(['max_turns']);
  });

  it('lists differing fields between two versions', () => {
    expect(differingFields(baseline, { ...baseline, mcpServers: [mcp('invoice-db')] })).toEqual([
      'mcp_servers',
    ]);
    expect(differingFields(baseline, baseline)).toEqual([]);
  });
});

describe('history lines', () => {
  it('reads like the fixtures', () => {
    expect(changeNote({ kind: 'created' }, baseline)).toBe('Created');
    expect(
      changeNote(
        { kind: 'duplicated', source: ref('baseline'), settings: baseline },
        { ...baseline, skills: [skill('invoice-method', '1.0.0')] },
      ),
    ).toBe('Duplicated from baseline v1; added skill invoice-method@1.0.0');
    expect(
      changeNote(
        { kind: 'duplicated', source: ref('baseline'), settings: baseline },
        { ...baseline, mcpServers: [mcp('invoice-db')] },
      ),
    ).toBe('Duplicated from baseline v1; added MCP server invoice-db');
    expect(
      changeNote({ kind: 'duplicated', source: ref('baseline', 3), settings: baseline }, baseline),
    ).toBe('Duplicated from baseline v3');
  });

  it('summarises an edit in field order', () => {
    expect(
      changeNote(
        { kind: 'next', previous: baseline },
        { ...baseline, model: 'anthropic/claude', skills: [skill('x', '1.0.0')] },
      ),
    ).toBe('changed model; added skill x@1.0.0');
    expect(changeNote({ kind: 'next', previous: baseline }, baseline)).toBe('No setting changes');
  });

  it('names every kind of change', () => {
    const prev: ResolvedSettings = {
      ...baseline,
      skills: [skill('invoice-method', '1.0.0'), skill('gone', '1.0.0')],
      documents: [doc('policy.pdf'), doc('old.md')],
      mcpServers: [mcp('invoice-db', 1)],
    };
    const next: ResolvedSettings = {
      ...baseline,
      provider: 'custom',
      baseUrl: 'https://llm.lan/v1',
      toolsets: ['file', 'web', 'browser'],
      memoryEnabled: true,
      skills: [skill('invoice-method', '1.1.0'), skill('new-a', '1.0.0'), skill('new-b', '2.0.0')],
      documents: [doc('policy.pdf', 'doc_policy_2', hex('9'))],
      mcpServers: [mcp('invoice-db', 2), mcp('vendor-api', 1, 'http')],
      maxTurns: 40,
      timeBudgetS: 600,
    };
    expect(changeParts(prev, next)).toEqual([
      'changed provider',
      'added toolsets browser, web',
      'removed toolset terminal',
      'turned memory on',
      'added skills new-a@1.0.0, new-b@2.0.0',
      'removed skill gone@1.0.0',
      'updated skill invoice-method to 1.1.0',
      'removed document old.md',
      'replaced document policy.pdf',
      'added MCP server vendor-api',
      'updated MCP server invoice-db to v2',
      'changed max turns',
      'changed time budget',
    ]);
    expect(
      changeParts(
        { ...baseline, provider: 'custom', baseUrl: 'https://a.lan' },
        { ...baseline, provider: 'custom', baseUrl: 'https://b.lan' },
      ),
    ).toEqual(['changed base URL']);
    expect(changeParts({ ...baseline, memoryEnabled: true }, baseline)).toEqual([
      'turned memory off',
    ]);
  });

  it('names a change of skill loading after the skills', () => {
    const skilled = { ...baseline, skills: [skill('invoice-method', '1.0.0')] };
    const onDemand = { ...skilled, skillLoading: 'on_demand' as const };
    expect(
      changeNote({ kind: 'duplicated', source: ref('with-skill'), settings: skilled }, onDemand),
    ).toBe('Duplicated from with-skill v1; set skill loading to on demand');
    expect(changeParts(baseline, { ...onDemand, documents: [doc('policy.pdf')] })).toEqual([
      'added skill invoice-method@1.0.0',
      'set skill loading to on demand',
      'added document policy.pdf',
    ]);
    expect(changeParts(onDemand, baseline)).toEqual([
      'removed skill invoice-method@1.0.0',
      'set skill loading to preload',
    ]);
  });
});

describe('copyName', () => {
  it('adds -copy, then a number when taken', () => {
    expect(copyName('baseline', new Set(['baseline']))).toBe('baseline-copy');
    expect(copyName('baseline', new Set(['baseline', 'baseline-copy']))).toBe('baseline-copy-2');
    expect(
      copyName('baseline', new Set(['baseline-copy', 'baseline-copy-2', 'baseline-copy-3'])),
    ).toBe('baseline-copy-4');
  });

  it('stays within the 63-character slug rule', () => {
    const long = 'a'.repeat(63);
    const copy = copyName(long, new Set([long]));
    expect(copy).toHaveLength(63);
    expect(copy.endsWith('-copy')).toBe(true);
    expect(copy).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/);
  });
});
