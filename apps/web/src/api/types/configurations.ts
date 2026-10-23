/**
 * View models for configurations (Configurations section, plan section 6).
 * See src/api/types/suites.ts for the conventions shared by every types file.
 */
import type { McpTransport, Provider } from '@hermes-evals/shared';

/** The fields ConfigDiffTable compares, in its row order. `name` never counts as a difference. */
export type ConfigField =
  | 'name'
  | 'model'
  | 'provider'
  | 'toolsets'
  | 'memory'
  | 'skills'
  | 'documents'
  | 'mcp_servers'
  | 'max_turns'
  | 'time_budget_s';

export interface SkillRef {
  skillId: string;
  name: string;
  version: string;
  contentHash: string;
}

export interface DocumentRef {
  documentId: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
}

export interface McpServerRef {
  mcpServerId: string;
  versionId: string;
  name: string;
  /** Definition version of the server (frozen once a configuration version uses it). */
  version: number;
  transport: McpTransport;
}

/** A configuration version as other records refer to it. */
export interface ConfigVersionRef {
  configurationId: string;
  versionId: string;
  name: string;
  version: number;
}

/** One immutable-once-used version of a configuration: the settings Hermes runs with. */
export interface ConfigurationVersion extends ConfigVersionRef {
  createdAt: string;
  /** Set when an experiment first used this version; it can no longer change. */
  frozenAt: string | null;
  latest: boolean;
  configHash: string;
  model: string;
  provider: Provider;
  /** Only for provider `custom`. */
  baseUrl: string | null;
  toolsets: string[];
  memoryEnabled: boolean;
  skills: SkillRef[];
  documents: DocumentRef[];
  mcpServers: McpServerRef[];
  maxTurns: number;
  timeBudgetS: number;
  /** History line, e.g. "Duplicated from baseline v1; added skill invoice-method@1.0.0". */
  change: string;
  experimentCount: number;
}

/** One row of the Configuration list. */
export interface ConfigurationListRow {
  id: string;
  name: string;
  createdAt: string;
  latest: ConfigurationVersion;
  /** Experiments that used any version of this configuration. */
  usedInExperiments: number;
}

/** An experiment that used a configuration, with this configuration's results in it. */
export interface ConfigurationUsage {
  experimentId: string;
  experimentName: string;
  role: 'baseline' | 'candidate';
  status: 'running' | 'paused' | 'completed' | 'failed';
  version: number;
  repetitions: number;
  passRate: number | null;
  scored: number;
  total: number;
  /** The candidate's verdict against the baseline; null for the baseline role or while running. */
  verdict: 'better' | 'worse' | 'inconclusive' | 'provisional' | 'not_computable' | null;
  /** Pass rate of the baseline in the same experiment, for "vs baseline 0.633". */
  baselinePassRate: number | null;
}

export interface ConfigurationDetail {
  id: string;
  name: string;
  createdAt: string;
  /** The version shown: the latest unless ?version= asked for an older, frozen one. */
  shown: ConfigurationVersion;
  latest: ConfigurationVersion;
  versions: ConfigurationVersion[];
  /** Set when this configuration was made by duplicating another. */
  duplicatedFrom: ConfigVersionRef | null;
  /** Fields that differ from `duplicatedFrom`, for the "differs from baseline" tag. */
  differsFromSource: ConfigField[];
  usedIn: ConfigurationUsage[];
}

/** One row of ConfigDiffTable: display values in column order. */
export interface ConfigDiffRow {
  field: ConfigField;
  /** Display strings, e.g. "file, terminal", "off", "—", "invoice-method@1.0.0", "invoice-db (stdio)". */
  values: string[];
  differs: boolean;
}

export interface ConfigDiff {
  columns: ConfigVersionRef[];
  /** Every field in ConfigField order, `name` first (never `differs`). */
  rows: ConfigDiffRow[];
  /** Fields that differ, in row order, for "1 field differs: skills". */
  differing: ConfigField[];
}

export interface ModelOption {
  id: string;
  /** Present when the model is in config/prices.yaml. */
  price: { inputPer1M: number; outputPer1M: number; checkedAt: string } | null;
}

export interface ProviderOption {
  id: Provider;
  label: string;
}

export interface ToolsetOption {
  name: string;
  defaultOn: boolean;
}

/** Everything the configuration form offers. Toolsets come from the runtime, in its order. */
export interface ConfigurationFormOptions {
  models: ModelOption[];
  providers: ProviderOption[];
  toolsets: ToolsetOption[];
  skills: (SkillRef & { description: string })[];
  documents: (DocumentRef & { typeLabel: string })[];
  mcpServers: (McpServerRef & { endpoint: string })[];
}

/** Values the form edits and saves. */
export interface ConfigurationInput {
  name: string;
  model: string;
  provider: Provider;
  baseUrl: string | null;
  toolsets: string[];
  memoryEnabled: boolean;
  /** Skill version ids (each skill row is one name and version). */
  skillIds: string[];
  documentIds: string[];
  mcpServerVersionIds: string[];
  maxTurns: number;
  timeBudgetS: number;
}

/** What the form opens with: new, edit or duplicate. */
export interface ConfigurationDraft {
  mode: 'new' | 'edit' | 'duplicate';
  /** The configuration being edited or duplicated. */
  source: ConfigVersionRef | null;
  values: ConfigurationInput;
  /** Edit of a version experiments already used: saving creates `nextVersion`. */
  createsNewVersion: boolean;
  nextVersion: number | null;
  /** Experiments that keep the current version when a new one is saved. */
  experimentsKeepingVersion: { id: string; name: string }[];
}

export interface ConfigurationSaveResult {
  configurationId: string;
  versionId: string;
  version: number;
  createdNewVersion: boolean;
}
