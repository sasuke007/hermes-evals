/**
 * samples/configurations.yaml: the recommended configurations of the sample
 * suites (Phase 8 G3), each arm in two families, `real` (Nous) and `mock`
 * (the scripted mock model). This file reads it and turns each arm into the
 * body POST /configurations takes, given where the seed found the skills,
 * documents and MCP servers it names. The seed then saves each one through
 * ConfigurationWritesService, the same path as the form.
 *
 * The file is strict: an unknown key is an error, so a typo cannot quietly
 * drop a setting from every sample configuration.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  ConfigurationInputSchema,
  PROVIDERS,
  SAMPLE_CONFIGURATION_FAMILIES,
  SKILL_LOADING_MODES,
  sampleConfigurationName,
  type ConfigurationInput,
  type SampleConfigurationFamily,
} from '@hermes-evals/shared';

/** The file's name under SAMPLES_DIR. */
export const SAMPLE_CONFIGURATIONS_FILE = 'configurations.yaml';

const LimitsSchema = z.strictObject({
  max_turns: z.number().int().min(1).max(200),
  time_budget_s: z.number().int().min(30).max(3600),
});

const FamilySchema = LimitsSchema.extend({
  provider: z.enum(PROVIDERS),
  model: z.string().min(1),
  /** Only for provider `custom`, as on the form. */
  base_url: z.string().min(1).optional(),
});

const ArmSchema = z.strictObject({
  toolsets: z.array(z.string().min(1)).min(1),
  memory: z.boolean().default(false),
  /** Skill names, as SKILL.md gives them: the samples/skills folders. */
  skills: z.array(z.string().min(1)).default([]),
  skill_loading: z.enum(SKILL_LOADING_MODES).default('preload'),
  /** `<suite>/<file>` under samples/documents, the seed's name for a document. */
  documents: z.array(z.string().regex(/^[^/]+\/[^/]+$/, 'use <suite>/<file>')).default([]),
  /** Names of the sample MCP servers. */
  mcp_servers: z.array(z.string().min(1)).default([]),
  /** Per family, limits that replace the family's own. */
  limits: z.partialRecord(z.enum(SAMPLE_CONFIGURATION_FAMILIES), LimitsSchema).default({}),
});
export type SampleArm = z.infer<typeof ArmSchema>;

export const SampleConfigurationsSchema = z.strictObject({
  families: z.strictObject({ real: FamilySchema, mock: FamilySchema }),
  /** Suite name to arm name to arm, in file order. */
  suites: z.record(z.string().min(1), z.record(z.string().min(1), ArmSchema)),
});
export type SampleConfigurations = z.infer<typeof SampleConfigurationsSchema>;

/** Parses the file's text; throws with the first problem's path and message. */
export function parseSampleConfigurations(text: string): SampleConfigurations {
  const result = SampleConfigurationsSchema.safeParse(parse(text) ?? {});
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const where = first && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
  throw new Error(`${SAMPLE_CONFIGURATIONS_FILE}${where}: ${first?.message ?? 'invalid'}`);
}

export async function readSampleConfigurations(samplesDir: string): Promise<SampleConfigurations> {
  return parseSampleConfigurations(
    await readFile(join(samplesDir, SAMPLE_CONFIGURATIONS_FILE), 'utf8'),
  );
}

/** One configuration the file asks for: an arm in a family. */
export interface SampleConfigurationSpec {
  name: string;
  suite: string;
  arm: string;
  family: SampleConfigurationFamily;
  settings: SampleArm;
}

/** Every arm in every family, suite by suite in file order, the real family first. */
export function sampleConfigurationSpecs(file: SampleConfigurations): SampleConfigurationSpec[] {
  return Object.entries(file.suites).flatMap(([suite, arms]) =>
    Object.entries(arms).flatMap(([arm, settings]) =>
      SAMPLE_CONFIGURATION_FAMILIES.map((family) => ({
        name: sampleConfigurationName(suite, arm, family),
        suite,
        arm,
        family,
        settings,
      })),
    ),
  );
}

/** Where the seed found what the arms name: ids by skill name, document `<suite>/<file>` and server name. */
export interface SampleResourceIds {
  skills: ReadonlyMap<string, string>;
  documents: ReadonlyMap<string, string>;
  /** The latest version of each MCP server. */
  mcpServerVersions: ReadonlyMap<string, string>;
}

/** What an arm names and the seed could not find, as the seed reports it. */
export function missingResources(spec: SampleConfigurationSpec, ids: SampleResourceIds): string[] {
  const { skills, documents, mcp_servers: servers } = spec.settings;
  return [
    ...skills.filter((n) => !ids.skills.has(n)).map((n) => `skill ${n}`),
    ...documents.filter((n) => !ids.documents.has(n)).map((n) => `document ${n}`),
    ...servers.filter((n) => !ids.mcpServerVersions.has(n)).map((n) => `MCP server ${n}`),
  ];
}

/**
 * The POST /configurations body of one spec, checked by the schema the
 * endpoint uses. Every resource it names must be in `ids` (missingResources
 * first); a missing one throws.
 */
export function configurationInputOf(
  file: SampleConfigurations,
  spec: SampleConfigurationSpec,
  ids: SampleResourceIds,
): ConfigurationInput {
  const family = file.families[spec.family];
  const limits = spec.settings.limits[spec.family] ?? family;
  const pick = (map: ReadonlyMap<string, string>, names: readonly string[], what: string) =>
    names.map((name) => {
      const id = map.get(name);
      if (id === undefined) throw new Error(`${spec.name}: no ${what} ${name}`);
      return id;
    });
  return ConfigurationInputSchema.parse({
    name: spec.name,
    model: family.model,
    provider: family.provider,
    baseUrl: family.base_url ?? null,
    toolsets: spec.settings.toolsets,
    memoryEnabled: spec.settings.memory,
    skillIds: pick(ids.skills, spec.settings.skills, 'skill'),
    skillLoading: spec.settings.skill_loading,
    documentIds: pick(ids.documents, spec.settings.documents, 'document'),
    mcpServerVersionIds: pick(ids.mcpServerVersions, spec.settings.mcp_servers, 'MCP server'),
    maxTurns: limits.max_turns,
    timeBudgetS: limits.time_budget_s,
    duplicatedFromVersionId: null,
  });
}
