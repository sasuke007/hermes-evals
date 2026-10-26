/**
 * View models for configurations (Configurations section, plan section 6).
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { EXPERIMENT_STATUSES, NOT_COMPUTABLE_REASONS } from '../status.js';
import { McpHeaderSchema } from '../records.js';
import { MCP_TRANSPORTS, PROVIDERS, SKILL_LOADING_MODES, type SkillLoadingMode } from '../vocab.js';
import {
  countView,
  deltaView,
  HTTP_URL_PATTERN,
  isoTimeView,
  isUnique,
  sha256View,
  SLUG_PATTERN,
} from './common.js';

/**
 * The fields ConfigDiffTable compares, in its row order. `name` never counts
 * as a difference. `skill_loading` (Phase 6 P5, "Skill loading") follows the
 * skills it applies to; a version without skills shows `preload`, the only
 * mode it can have, so it differs from a skilled version only in `skills`.
 */
export const CONFIG_FIELDS = [
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
] as const;
export const ConfigFieldSchema = z.enum(CONFIG_FIELDS);
export type ConfigField = z.infer<typeof ConfigFieldSchema>;

const provider = z.enum(PROVIDERS);

export const SkillLoadingSchema = z.enum(SKILL_LOADING_MODES);

/**
 * How each mode reads wherever a configuration is shown: the diff table's
 * values, the detail's field, the form's choice and New experiment's
 * configuration cards.
 */
export const SKILL_LOADING_LABELS = {
  preload: 'preload',
  on_demand: 'on demand',
} as const satisfies Record<SkillLoadingMode, string>;

/** Why a configuration with on_demand loading and no skills is refused at save (400). */
export const SKILL_LOADING_NEEDS_SKILLS =
  'Skill loading applies only when the configuration has skills';

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
  /**
   * The secret names of this very version (Phase 5 section 6.1), so a
   * configuration pinned to an older definition names its own: stdio
   * environment variable names (readable by the agent), and http header and
   * variable pairs (added by egress). Names only, never a value.
   */
  envNames: z.array(z.string()),
  headers: z.array(McpHeaderSchema),
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
  /** `preload` for every version stored before Phase 6, and for any version without skills. */
  skillLoading: SkillLoadingSchema,
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
  /**
   * Why there is no verdict, when `verdict` is not_computable, so the row
   * can say it ("No interval (1 rep)"); null otherwise.
   */
  verdictReason: z.enum(NOT_COMPUTABLE_REASONS).nullable(),
  /** Pass rate of the baseline in the same experiment, for "vs baseline 0.633". */
  baselinePassRate: rate.nullable(),
  /** Tasks the experiment ran, for "No interval (2 tasks)" (Phase 5 question 1). */
  taskCount: countView,
  /**
   * The candidate's observed difference from the baseline in its verdict
   * ("Δ +0.056"): the last verdict entry's once completed, the provisional
   * one while running. Null for the baseline role and when there is none.
   */
  delta: deltaView.nullable(),
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

/** One skill loading mode as the form offers it (Phase 6 P5). */
export const SkillLoadingOptionSchema = z.object({
  id: SkillLoadingSchema,
  /** SKILL_LOADING_LABELS[id]. */
  label: z.string(),
  /** One line under the choice, e.g. "Loaded into the prompt at start (-s per skill)." */
  description: z.string(),
});
export type SkillLoadingOption = z.infer<typeof SkillLoadingOptionSchema>;

/** The form's skill loading choices, `preload` (the default) first. */
export const SKILL_LOADING_OPTIONS: readonly SkillLoadingOption[] = [
  {
    id: 'preload',
    label: SKILL_LOADING_LABELS.preload,
    description: 'Each skill is loaded into the prompt at start (-s per skill).',
  },
  {
    id: 'on_demand',
    label: SKILL_LOADING_LABELS.on_demand,
    description:
      'Skills are installed but not loaded; the agent lists and opens them with the skills toolset.',
  },
];

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
  /** SKILL_LOADING_OPTIONS: the choice is offered once the configuration has a skill. */
  skillLoading: z.array(SkillLoadingOptionSchema),
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
  /**
   * Phase 6 P5. Defaults to `preload` when a body leaves it out, so a client
   * written before Phase 6 still saves what it always ran; `on_demand` needs
   * at least one skill.
   */
  skillLoading: SkillLoadingSchema.default('preload'),
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
  // The configuration_versions_skill_loading_skills_ck rule (migration 0008).
  if (c.skillLoading === 'on_demand' && c.skillIds.length === 0) {
    issue('skillLoading', SKILL_LOADING_NEEDS_SKILLS);
  }
  if (c.maxTurns < 1 || c.maxTurns > 200) issue('maxTurns', 'max turns must be 1 to 200');
  if (c.timeBudgetS < 30 || c.timeBudgetS > 3600) {
    issue('timeBudgetS', 'the time budget must be 30 to 3600 seconds');
  }
}

/** Body of POST /configurations and PUT /configurations/:id. */
export const ConfigurationInputSchema = ConfigurationFieldsSchema.superRefine(checkConfiguration);
export type ConfigurationInput = z.infer<typeof ConfigurationInputSchema>;

/**
 * What a new configuration starts with besides its model and toolsets
 * (GET /configurations/new-draft): the ConfigForm artboard's limits, the
 * Nous Portal route, and no resources.
 */
export const NEW_CONFIGURATION_DEFAULTS = {
  provider: 'nous',
  maxTurns: 20,
  timeBudgetS: 300,
  memoryEnabled: false,
  skillLoading: 'preload',
} as const;

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
