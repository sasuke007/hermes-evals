/**
 * View models for configurations (Configurations section, plan section 6).
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { EXPERIMENT_STATUSES } from '../status.js';
import { MCP_TRANSPORTS, PROVIDERS } from '../vocab.js';
import {
  countView,
  HTTP_URL_PATTERN,
  isoTimeView,
  isUnique,
  sha256View,
  SLUG_PATTERN,
} from './common.js';

/** The fields ConfigDiffTable compares, in its row order. `name` never counts as a difference. */
export const CONFIG_FIELDS = [
  'name',
  'model',
  'provider',
  'toolsets',
  'memory',
  'skills',
  'documents',
  'mcp_servers',
  'max_turns',
  'time_budget_s',
] as const;
export const ConfigFieldSchema = z.enum(CONFIG_FIELDS);
export type ConfigField = z.infer<typeof ConfigFieldSchema>;

const provider = z.enum(PROVIDERS);

export const SkillRefSchema = z.object({
  skillId: z.string(),
  name: z.string(),
  version: z.string(),
  contentHash: sha256View,
});
export type SkillRef = z.infer<typeof SkillRefSchema>;

export const DocumentRefSchema = z.object({
  documentId: z.string(),
  filename: z.string(),
  sizeBytes: countView,
  sha256: sha256View,
});
export type DocumentRef = z.infer<typeof DocumentRefSchema>;

export const McpServerRefSchema = z.object({
  mcpServerId: z.string(),
  versionId: z.string(),
  name: z.string(),
  /** Definition version of the server (frozen once a configuration version uses it). */
  version: z.number().int().positive(),
  transport: z.enum(MCP_TRANSPORTS),
});
export type McpServerRef = z.infer<typeof McpServerRefSchema>;

/** A configuration version as other records refer to it. */
export const ConfigVersionRefSchema = z.object({
  configurationId: z.string(),
  versionId: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
});
export type ConfigVersionRef = z.infer<typeof ConfigVersionRefSchema>;

/** One immutable-once-used version of a configuration: the settings Hermes runs with. */
export const ConfigurationVersionSchema = ConfigVersionRefSchema.extend({
  createdAt: isoTimeView,
  /** Set when an experiment first used this version; it can no longer change. */
  frozenAt: isoTimeView.nullable(),
  latest: z.boolean(),
  configHash: sha256View,
  model: z.string(),
  provider,
  /** Only for provider `custom`. */
  baseUrl: z.string().nullable(),
  toolsets: z.array(z.string()),
  memoryEnabled: z.boolean(),
  skills: z.array(SkillRefSchema),
  documents: z.array(DocumentRefSchema),
  mcpServers: z.array(McpServerRefSchema),
  maxTurns: z.number().int().positive(),
  timeBudgetS: z.number().int().positive(),
  /** History line, e.g. "Duplicated from baseline v1; added skill invoice-method@1.0.0". */
  change: z.string(),
  experimentCount: countView,
});
export type ConfigurationVersion = z.infer<typeof ConfigurationVersionSchema>;

/** One row of the Configuration list. */
export const ConfigurationListRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: isoTimeView,
  latest: ConfigurationVersionSchema,
  /** Experiments that used any version of this configuration. */
  usedInExperiments: countView,
});
export type ConfigurationListRow = z.infer<typeof ConfigurationListRowSchema>;

const rate = z.number().min(0).max(1);

/** An experiment that used a configuration, with this configuration's results in it. */
export const ConfigurationUsageSchema = z.object({
  experimentId: z.string(),
  experimentName: z.string(),
  role: z.enum(['baseline', 'candidate']),
  status: z.enum(EXPERIMENT_STATUSES),
  version: z.number().int().positive(),
  repetitions: z.number().int().positive(),
  passRate: rate.nullable(),
  scored: countView,
  total: countView,
  /**
   * The candidate's verdict against the baseline (its last verdict entry once
   * completed, `provisional` while running); null for the baseline role.
   */
  verdict: z.enum(['better', 'worse', 'inconclusive', 'provisional', 'not_computable']).nullable(),
  /** Pass rate of the baseline in the same experiment, for "vs baseline 0.633". */
  baselinePassRate: rate.nullable(),
});
export type ConfigurationUsage = z.infer<typeof ConfigurationUsageSchema>;

export const ConfigurationDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: isoTimeView,
  /** The version shown: the latest unless ?version= asked for an older, frozen one. */
  shown: ConfigurationVersionSchema,
  latest: ConfigurationVersionSchema,
  versions: z.array(ConfigurationVersionSchema),
  /** Set when this configuration was made by duplicating another. */
  duplicatedFrom: ConfigVersionRefSchema.nullable(),
  /** Fields that differ from `duplicatedFrom`, for the "differs from baseline" tag. */
  differsFromSource: z.array(ConfigFieldSchema),
  usedIn: z.array(ConfigurationUsageSchema),
});
export type ConfigurationDetail = z.infer<typeof ConfigurationDetailSchema>;

/** One row of ConfigDiffTable: display values in column order. */
export const ConfigDiffRowSchema = z.object({
  field: ConfigFieldSchema,
  /** Display strings, e.g. "file, terminal", "off", "—", "invoice-method@1.0.0", "invoice-db (stdio)". */
  values: z.array(z.string()),
  differs: z.boolean(),
});
export type ConfigDiffRow = z.infer<typeof ConfigDiffRowSchema>;

export const ConfigDiffSchema = z.object({
  columns: z.array(ConfigVersionRefSchema),
  /** Every field in ConfigField order, `name` first (never `differs`). */
  rows: z.array(ConfigDiffRowSchema),
  /** Fields that differ, in row order, for "1 field differs: skills". */
  differing: z.array(ConfigFieldSchema),
});
export type ConfigDiff = z.infer<typeof ConfigDiffSchema>;

export const ModelOptionSchema = z.object({
  id: z.string(),
  /** Present when the model is in config/prices.yaml. */
  price: z
    .object({
      inputPer1M: z.number().nonnegative(),
      outputPer1M: z.number().nonnegative(),
      checkedAt: z.string(),
    })
    .nullable(),
});
export type ModelOption = z.infer<typeof ModelOptionSchema>;

export const ProviderOptionSchema = z.object({
  id: provider,
  label: z.string(),
});
export type ProviderOption = z.infer<typeof ProviderOptionSchema>;

export const ToolsetOptionSchema = z.object({
  name: z.string(),
  defaultOn: z.boolean(),
});
export type ToolsetOption = z.infer<typeof ToolsetOptionSchema>;

/** Everything the configuration form offers. Toolsets come from the runtime, in its order. */
export const ConfigurationFormOptionsSchema = z.object({
  models: z.array(ModelOptionSchema),
  providers: z.array(ProviderOptionSchema),
  toolsets: z.array(ToolsetOptionSchema),
  skills: z.array(SkillRefSchema.extend({ description: z.string() })),
  documents: z.array(DocumentRefSchema.extend({ typeLabel: z.string() })),
  /**
   * Each server's latest version, plus every older version a configuration
   * still pins, so every id an edit or duplicate draft holds has an option.
   * Ordered by name, then version, newest first. `latest` marks the version
   * "Add MCP server…" offers; an older one shows as "invoice-db v1 (v2
   * available)", and the form swaps a pin per mcpServerId.
   */
  mcpServers: z.array(McpServerRefSchema.extend({ endpoint: z.string(), latest: z.boolean() })),
});
export type ConfigurationFormOptions = z.infer<typeof ConfigurationFormOptionsSchema>;

/**
 * The values the form edits, unchecked: a new draft starts with an empty
 * name, so drafts use this and saves use ConfigurationInputSchema.
 */
export const ConfigurationFieldsSchema = z.object({
  name: z.string(),
  model: z.string(),
  provider,
  baseUrl: z.string().nullable(),
  toolsets: z.array(z.string()),
  memoryEnabled: z.boolean(),
  /** Skill version ids (each skill row is one name and version). */
  skillIds: z.array(z.string()),
  documentIds: z.array(z.string()),
  mcpServerVersionIds: z.array(z.string()),
  maxTurns: z.number().int(),
  timeBudgetS: z.number().int(),
  /**
   * The version a duplicate was made from, so the detail page can say
   * "Duplicated from baseline v1". Set by the duplicate draft and saved with
   * the new configuration; a configuration's origin never changes, so an
   * edit (PUT) ignores it.
   */
  duplicatedFromVersionId: z.string().nullable(),
});

/**
 * Field rules beyond the types, as the configuration_versions CHECKs and
 * plan section 6 state them. Ids are checked against the database on save.
 */
function checkConfiguration(c: z.infer<typeof ConfigurationFieldsSchema>, ctx: z.RefinementCtx) {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (!SLUG_PATTERN.test(c.name)) {
    issue('name', 'use lowercase letters, digits, - and _ (at most 63 characters)');
  }
  if (c.model.trim() === '') issue('model', 'a model is required');
  if (c.provider === 'custom') {
    if (c.baseUrl === null || !HTTP_URL_PATTERN.test(c.baseUrl)) {
      issue('baseUrl', 'the custom provider needs an http(s) base URL without user:password@');
    }
  } else if (c.baseUrl !== null) {
    issue('baseUrl', 'only the custom provider takes a base URL');
  }
  for (const key of ['toolsets', 'skillIds', 'documentIds', 'mcpServerVersionIds'] as const) {
    if (c[key].some((v) => v === '')) issue(key, 'entries must not be empty');
    if (!isUnique(c[key])) issue(key, 'entries must not repeat');
  }
  if (c.maxTurns < 1 || c.maxTurns > 200) issue('maxTurns', 'max turns must be 1 to 200');
  if (c.timeBudgetS < 30 || c.timeBudgetS > 3600) {
    issue('timeBudgetS', 'the time budget must be 30 to 3600 seconds');
  }
}

/** Body of POST /configurations and PUT /configurations/:id. */
export const ConfigurationInputSchema = ConfigurationFieldsSchema.superRefine(checkConfiguration);
export type ConfigurationInput = z.infer<typeof ConfigurationInputSchema>;

/** What the form opens with: new, edit or duplicate. */
export const ConfigurationDraftSchema = z.object({
  mode: z.enum(['new', 'edit', 'duplicate']),
  /** The configuration being edited or duplicated. */
  source: ConfigVersionRefSchema.nullable(),
  values: ConfigurationFieldsSchema,
  /** Edit of a version experiments already used: saving creates `nextVersion`. */
  createsNewVersion: z.boolean(),
  nextVersion: z.number().int().positive().nullable(),
  /** Experiments that keep the current version when a new one is saved. */
  experimentsKeepingVersion: z.array(z.object({ id: z.string(), name: z.string() })),
});
export type ConfigurationDraft = z.infer<typeof ConfigurationDraftSchema>;

export const ConfigurationSaveResultSchema = z.object({
  configurationId: z.string(),
  versionId: z.string(),
  version: z.number().int().positive(),
  createdNewVersion: z.boolean(),
});
export type ConfigurationSaveResult = z.infer<typeof ConfigurationSaveResultSchema>;
