/**
 * The samples seed (Phase 8 G3): what SAMPLES_DIR holds and the database
 * lacks, so a fresh clone has skills, documents, the two sample MCP servers
 * and every sample suite's recommended configurations, real and mock, the
 * moment the stack is up. In SEED_ITEM_KINDS order, since configurations
 * name the rest.
 *
 * Idempotent: a second run finds everything and skips it. It never deletes
 * or changes what exists, so a configuration the user edited keeps their
 * edit; a skill whose sample changed is stored as its next version.
 */
import { stat } from 'node:fs/promises';
import type { SeedItem } from '@hermes-evals/shared';
import { configurations } from '../database/schema/index.js';
import type { ConfigurationWritesService } from '../configurations/configuration-writes.service.js';
import {
  configurationInputOf,
  missingResources,
  readSampleConfigurations,
  sampleConfigurationSpecs,
  type SampleConfigurations,
  type SampleResourceIds,
} from './sample-configurations.js';
import {
  reasonOf,
  seedDocuments,
  seedMcpServers,
  seedSkills,
  type ResourceSeedDeps,
} from './seed-resources.js';

export interface SeedDeps extends ResourceSeedDeps {
  configurations: ConfigurationWritesService;
}

/** Each recommended configuration whose name is free, from the resources found or made. */
export async function seedConfigurations(
  deps: SeedDeps,
  file: SampleConfigurations,
  ids: SampleResourceIds,
): Promise<void> {
  const taken = new Set(
    (await deps.db.select({ name: configurations.name }).from(configurations)).map((r) => r.name),
  );
  for (const spec of sampleConfigurationSpecs(file)) {
    const item = (outcome: SeedItem['outcome'], detail: string | null): void =>
      deps.report({ kind: 'configuration', name: spec.name, outcome, detail });
    if (taken.has(spec.name)) {
      item('skipped', 'a configuration with this name exists');
      continue;
    }
    const missing = missingResources(spec, ids);
    if (missing.length > 0) {
      item('failed', `needs ${missing.join(', ')}, which the seed could not find or store`);
      continue;
    }
    try {
      await deps.configurations.create(configurationInputOf(file, spec, ids));
      item('created', null);
    } catch (err) {
      item('failed', reasonOf(err));
    }
  }
}

/**
 * Runs the whole seed over `samplesDir`. Throws only when it cannot go on:
 * no samples folder, a configurations.yaml it cannot read, or a database
 * error outside one sample. Each sample's own failure is reported instead.
 */
export async function seedSamples(deps: SeedDeps, samplesDir: string): Promise<void> {
  const found = await stat(samplesDir).catch(() => null);
  if (!found?.isDirectory()) throw new Error(`no samples folder at ${samplesDir} (SAMPLES_DIR)`);
  // Read first, so a broken file stops the seed before it adds anything.
  const file = await readSampleConfigurations(samplesDir);
  const skills = await seedSkills(deps, samplesDir);
  const documents = await seedDocuments(deps, samplesDir);
  const mcpServerVersions = await seedMcpServers(deps);
  await seedConfigurations(deps, file, { skills, documents, mcpServerVersions });
}
