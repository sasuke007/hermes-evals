/**
 * Configuration fixtures: baseline, with-skill and with-mcp, each at v1
 * (UI design brief section 7; ConfigList, ConfigForm and ConfigDetail
 * artboards). Usage in experiments is filled in by the API layer from the
 * experiment fixtures, which import this file.
 *
 * Scenarios handled here (see scenarios.ts): empty.
 */
import { CONFIG_FIELDS, PROVIDERS, type Provider } from '@hermes-evals/shared';
import type {
  ConfigDiff,
  ConfigDiffRow,
  ConfigField,
  ConfigurationDraft,
  ConfigurationFormOptions,
  ConfigurationInput,
  ConfigurationVersion,
  ConfigVersionRef,
} from '@/api/types/configurations';
import {
  CONFIG_IDS,
  DOCUMENT_POLICY,
  MCP_INVOICE_DB,
  MCP_VENDOR_API,
  SKILL_INVOICE_METHOD,
} from './resources';
import { at, sha } from './suites';

export { CONFIG_FIELDS, CONFIG_IDS };

export type ConfigName = keyof typeof CONFIG_IDS;

export const CONFIG_VERSION_IDS: Record<ConfigName, string> = {
  baseline: 'cfgv_01JAX7BASE1',
  'with-skill': 'cfgv_01JAX9SKIL1',
  'with-mcp': 'cfgv_01JAYMCPDB1',
};

export const MODEL = 'openai/gpt-6.1-sol';

/** config/prices.yaml as the fixtures know it: one priced model. */
export const PRICE_TABLE = [
  { model: MODEL, inputPer1M: 0.6, outputPer1M: 2.4, checkedAt: '2026-10-20' },
];

/** The 17 toolsets the runtime reports, in its order. Default on: file, terminal. */
export const TOOLSETS = [
  'file',
  'terminal',
  'code_execution',
  'web',
  'browser',
  'vision',
  'image_gen',
  'tts',
  'skills',
  'todo',
  'memory',
  'session_search',
  'connections',
  'clarify',
  'delegation',
  'cronjob',
  'computer_use',
];

const PROVIDER_LABELS: Record<Provider, string> = {
  nous: 'nous · Nous Portal',
  'nous-api': 'nous-api · Nous API key',
  openrouter: 'openrouter · OpenRouter',
  openai: 'openai · OpenAI',
  anthropic: 'anthropic · Anthropic',
  custom: 'custom · OpenAI-compatible URL',
};

const skillRef = {
  skillId: SKILL_INVOICE_METHOD.id,
  name: SKILL_INVOICE_METHOD.name,
  version: SKILL_INVOICE_METHOD.version,
  contentHash: SKILL_INVOICE_METHOD.contentHash,
};

const mcpRef = {
  mcpServerId: MCP_INVOICE_DB.id,
  versionId: MCP_INVOICE_DB.versionId,
  name: MCP_INVOICE_DB.name,
  version: MCP_INVOICE_DB.version,
  transport: MCP_INVOICE_DB.transport,
};

const common = {
  latest: true,
  model: MODEL,
  provider: 'nous' as Provider,
  baseUrl: null,
  toolsets: ['file', 'terminal'],
  memoryEnabled: false,
  documents: [],
  maxTurns: 20,
  timeBudgetS: 300,
};

export const CONFIG_VERSIONS: Record<ConfigName, ConfigurationVersion> = {
  baseline: {
    ...common,
    configurationId: CONFIG_IDS.baseline,
    versionId: CONFIG_VERSION_IDS.baseline,
    name: 'baseline',
    version: 1,
    createdAt: at(22, '09:40:03'),
    frozenAt: at(22, '09:58:10'),
    configHash: sha('cfg-baseline-v1', 'b5d03f71'),
    skills: [],
    mcpServers: [],
    change: 'Created',
    experimentCount: 6,
  },
  'with-skill': {
    ...common,
    configurationId: CONFIG_IDS['with-skill'],
    versionId: CONFIG_VERSION_IDS['with-skill'],
    name: 'with-skill',
    version: 1,
    createdAt: at(22, '09:52:16'),
    frozenAt: at(22, '09:58:10'),
    configHash: sha('cfg-with-skill-v1', 'e81b44a0', '2c9f'),
    skills: [skillRef],
    mcpServers: [],
    change: 'Duplicated from baseline v1; added skill invoice-method@1.0.0',
    experimentCount: 3,
  },
  'with-mcp': {
    ...common,
    configurationId: CONFIG_IDS['with-mcp'],
    versionId: CONFIG_VERSION_IDS['with-mcp'],
    name: 'with-mcp',
    version: 1,
    createdAt: at(22, '17:15:40'),
    frozenAt: at(22, '17:40:02'),
    configHash: sha('cfg-with-mcp-v1', '6a0f9d22'),
    skills: [],
    mcpServers: [mcpRef],
    change: 'Duplicated from baseline v1; added MCP server invoice-db',
    experimentCount: 4,
  },
};

export const CONFIG_NAMES = Object.keys(CONFIG_VERSIONS) as ConfigName[];

/** Finds a configuration version by version id, configuration id or name. */
export function findConfigVersion(idOrName: string): ConfigurationVersion | undefined {
  return Object.values(CONFIG_VERSIONS).find(
    (c) => c.versionId === idOrName || c.configurationId === idOrName || c.name === idOrName,
  );
}

export function versionRef(c: ConfigurationVersion): ConfigVersionRef {
  return {
    configurationId: c.configurationId,
    versionId: c.versionId,
    name: c.name,
    version: c.version,
  };
}

/** Which configuration each was duplicated from. */
export const DUPLICATED_FROM: Partial<Record<ConfigName, ConfigName>> = {
  'with-skill': 'baseline',
  'with-mcp': 'baseline',
};

/** Display value of one field, as ConfigDiffTable shows it. */
export function fieldValue(c: ConfigurationVersion, field: ConfigField): string {
  switch (field) {
    case 'name':
      return c.name;
    case 'model':
      return c.model;
    case 'provider':
      return c.provider;
    case 'toolsets':
      return c.toolsets.join(', ') || '—';
    case 'memory':
      return c.memoryEnabled ? 'on' : 'off';
    case 'skills':
      return c.skills.map((s) => `${s.name}@${s.version}`).join(', ') || '—';
    case 'documents':
      return c.documents.map((d) => d.filename).join(', ') || '—';
    case 'mcp_servers':
      return c.mcpServers.map((m) => `${m.name} (${m.transport})`).join(', ') || '—';
    case 'max_turns':
      return String(c.maxTurns);
    case 'time_budget_s':
      return String(c.timeBudgetS);
  }
}

/** ConfigDiffTable data: the first column is the reference. */
export function configDiffFixture(versions: ConfigurationVersion[]): ConfigDiff {
  const rows: ConfigDiffRow[] = CONFIG_FIELDS.map((field) => {
    const values = versions.map((v) => fieldValue(v, field));
    const differs = field !== 'name' && values.some((v) => v !== values[0]);
    return { field, values, differs };
  });
  return {
    columns: versions.map(versionRef),
    rows,
    differing: rows.filter((r) => r.differs).map((r) => r.field),
  };
}

export function configurationsFixture(empty: boolean): ConfigurationVersion[] {
  return empty ? [] : CONFIG_NAMES.map((n) => CONFIG_VERSIONS[n]);
}

export function formOptionsFixture(empty: boolean): ConfigurationFormOptions {
  return {
    models: PRICE_TABLE.map((p) => ({
      id: p.model,
      price: { inputPer1M: p.inputPer1M, outputPer1M: p.outputPer1M, checkedAt: p.checkedAt },
    })),
    providers: PROVIDERS.map((id) => ({ id, label: PROVIDER_LABELS[id] })),
    toolsets: TOOLSETS.map((name) => ({ name, defaultOn: name === 'file' || name === 'terminal' })),
    skills: empty ? [] : [{ ...skillRef, description: SKILL_INVOICE_METHOD.description }],
    documents: empty
      ? []
      : [
          {
            documentId: DOCUMENT_POLICY.id,
            filename: DOCUMENT_POLICY.filename,
            sizeBytes: DOCUMENT_POLICY.sizeBytes,
            sha256: DOCUMENT_POLICY.sha256,
            typeLabel: '214 KB',
          },
        ],
    mcpServers: empty
      ? []
      : [
          { ...mcpRef, endpoint: 'npx invoice-db-mcp', latest: true },
          {
            mcpServerId: MCP_VENDOR_API.id,
            versionId: MCP_VENDOR_API.versionId,
            name: MCP_VENDOR_API.name,
            version: MCP_VENDOR_API.version,
            transport: MCP_VENDOR_API.transport,
            endpoint: MCP_VENDOR_API.url ?? '',
            latest: true,
          },
        ],
  };
}

function inputFrom(
  c: ConfigurationVersion,
  duplicatedFromVersionId: string | null,
): ConfigurationInput {
  return {
    name: c.name,
    model: c.model,
    provider: c.provider,
    baseUrl: c.baseUrl,
    toolsets: [...c.toolsets],
    memoryEnabled: c.memoryEnabled,
    skillIds: c.skills.map((s) => s.skillId),
    documentIds: c.documents.map((d) => d.documentId),
    mcpServerVersionIds: c.mcpServers.map((m) => m.versionId),
    maxTurns: c.maxTurns,
    timeBudgetS: c.timeBudgetS,
    duplicatedFromVersionId,
  };
}

export const NEW_CONFIGURATION_INPUT: ConfigurationInput = {
  name: '',
  model: MODEL,
  provider: 'nous',
  baseUrl: null,
  toolsets: ['file', 'terminal'],
  memoryEnabled: false,
  skillIds: [],
  documentIds: [],
  mcpServerVersionIds: [],
  maxTurns: 20,
  timeBudgetS: 300,
  duplicatedFromVersionId: null,
};

/** The version a configuration was duplicated from, or null. */
function originOf(c: ConfigurationVersion): string | null {
  const from = DUPLICATED_FROM[c.name as ConfigName];
  return from ? CONFIG_VERSIONS[from].versionId : null;
}

/**
 * The form's starting point. Experiments that keep the current version are
 * filled in by the API layer from the experiment fixtures.
 */
export function draftFixture(
  mode: ConfigurationDraft['mode'],
  source: ConfigurationVersion | null,
): ConfigurationDraft {
  if (mode === 'new' || !source) {
    return {
      mode: 'new',
      source: null,
      values: { ...NEW_CONFIGURATION_INPUT, toolsets: [...NEW_CONFIGURATION_INPUT.toolsets] },
      createsNewVersion: false,
      nextVersion: null,
      experimentsKeepingVersion: [],
    };
  }
  if (mode === 'duplicate') {
    return {
      mode,
      source: versionRef(source),
      // A duplicate records where it came from; the copy's own origin does not carry over.
      values: { ...inputFrom(source, source.versionId), name: `${source.name}-copy` },
      createsNewVersion: false,
      nextVersion: null,
      experimentsKeepingVersion: [],
    };
  }
  const frozen = source.frozenAt !== null;
  return {
    mode,
    source: versionRef(source),
    values: inputFrom(source, originOf(source)),
    createsNewVersion: frozen,
    nextVersion: frozen ? source.version + 1 : null,
    experimentsKeepingVersion: [],
  };
}
