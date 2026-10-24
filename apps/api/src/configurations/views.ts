/**
 * Stored configuration versions as the view models of
 * packages/shared/src/contracts/configurations.ts. Every list of versions is
 * built in a fixed number of queries (resources, experiment counts), never
 * one per version.
 */
import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { ConfigurationVersion, ConfigVersionRef } from '@hermes-evals/shared';
import { configurations, configurationVersions, experiments } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import { loadResources, pickResources, type ResolvedResources } from './references.js';
import { orderSettings, type ResolvedSettings } from './settings.js';

export type ConfigurationRow = typeof configurations.$inferSelect;
export type VersionRow = typeof configurationVersions.$inferSelect;

/** A version with the configuration it belongs to. */
export interface VersionPair {
  configuration: ConfigurationRow;
  row: VersionRow;
}

/** A version resolved for display and comparison. */
export interface VersionRecord extends VersionPair {
  settings: ResolvedSettings;
  view: ConfigurationVersion;
}

export const versionRef = (configuration: ConfigurationRow, row: VersionRow): ConfigVersionRef => ({
  configurationId: configuration.id,
  versionId: row.id,
  name: configuration.name,
  version: row.version,
});

/** The settings a stored row runs with, its resources resolved. */
export const settingsOf = (row: VersionRow, resources: ResolvedResources): ResolvedSettings =>
  orderSettings({
    model: row.model,
    provider: row.provider,
    baseUrl: row.baseUrl,
    toolsets: row.toolsets,
    memoryEnabled: row.memoryEnabled,
    skills: resources.skills,
    documents: resources.documents,
    mcpServers: resources.mcpServers,
    maxTurns: row.maxTurns,
    timeBudgetS: row.timeBudgetS,
  });

/** Experiments that test each version, as baseline or candidate (a version is never both). */
export async function experimentCounts(
  db: AppDb,
  versionIds: readonly string[],
): Promise<Map<string, number>> {
  if (versionIds.length === 0) return new Map();
  const rows = await db
    .select({
      versionId: configurationVersions.id,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(configurationVersions)
    .innerJoin(
      experiments,
      or(
        eq(experiments.baselineVersionId, configurationVersions.id),
        sql`${configurationVersions.id} = any(${experiments.candidateVersionIds})`,
      ),
    )
    .where(inArray(configurationVersions.id, [...versionIds]))
    .groupBy(configurationVersions.id);
  return new Map(rows.map((r) => [r.versionId, r.n]));
}

/** Resolves versions for display, in the order given. */
export async function buildVersions(
  db: AppDb,
  pairs: readonly VersionPair[],
): Promise<VersionRecord[]> {
  const index = await loadResources(
    db,
    pairs.map((p) => p.row),
  );
  const counts = await experimentCounts(
    db,
    pairs.map((p) => p.row.id),
  );
  return pairs.map(({ configuration, row }) => {
    const settings = settingsOf(row, pickResources(index, row));
    const view: ConfigurationVersion = {
      ...versionRef(configuration, row),
      createdAt: row.createdAt.toISOString(),
      frozenAt: row.frozenAt?.toISOString() ?? null,
      latest: row.version === configuration.latestVersion,
      configHash: row.configHash,
      model: settings.model,
      provider: settings.provider,
      baseUrl: settings.baseUrl,
      toolsets: settings.toolsets,
      memoryEnabled: settings.memoryEnabled,
      skills: settings.skills.map(({ skillId, name, version, contentHash }) => ({
        skillId,
        name,
        version,
        contentHash,
      })),
      documents: settings.documents.map(({ documentId, filename, sizeBytes, sha256 }) => ({
        documentId,
        filename,
        sizeBytes,
        sha256,
      })),
      mcpServers: settings.mcpServers.map(
        ({ mcpServerId, versionId, name, version, transport }) => ({
          mcpServerId,
          versionId,
          name,
          version,
          transport,
        }),
      ),
      maxTurns: settings.maxTurns,
      timeBudgetS: settings.timeBudgetS,
      change: row.changeNote ?? 'Created',
      experimentCount: counts.get(row.id) ?? 0,
    };
    return { configuration, row, settings, view };
  });
}

/** Versions by id with their configurations; ids that do not exist are left out. */
export async function loadVersionPairs(db: AppDb, ids: readonly string[]): Promise<VersionPair[]> {
  if (ids.length === 0) return [];
  return db
    .select({ configuration: configurations, row: configurationVersions })
    .from(configurationVersions)
    .innerJoin(configurations, eq(configurations.id, configurationVersions.configurationId))
    .where(inArray(configurationVersions.id, [...ids]));
}

/** Every configuration at its latest version, in creation order. */
export function loadLatestPairs(db: AppDb): Promise<VersionPair[]> {
  return db
    .select({ configuration: configurations, row: configurationVersions })
    .from(configurations)
    .innerJoin(
      configurationVersions,
      and(
        eq(configurationVersions.configurationId, configurations.id),
        eq(configurationVersions.version, configurations.latestVersion),
      ),
    )
    .orderBy(asc(configurations.createdAt), asc(configurations.id));
}
