/**
 * "Used by" for skills and "Attached to" for documents: the configurations
 * whose latest version references a resource. Older versions are history;
 * a configuration that dropped a skill in its latest version no longer uses
 * it, even if an experiment ran on the version that had it.
 */
import type { ConfigurationLink } from '@hermes-evals/shared';
import { and, arrayOverlaps, asc, eq, sql } from 'drizzle-orm';
import { configurations, configurationVersions } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';

export type ResourceIdColumn = 'skillIds' | 'documentIds';

/**
 * Maps each resource id to the configurations whose latest version lists it
 * in `column`, sorted by configuration name. With `ids`, only those resources
 * are looked up.
 */
export async function latestConfigurationLinks(
  db: AppDb,
  column: ResourceIdColumn,
  ids?: readonly string[],
): Promise<Map<string, ConfigurationLink[]>> {
  const links = new Map<string, ConfigurationLink[]>();
  if (ids?.length === 0) return links;
  const referenced = configurationVersions[column];
  const rows = await db
    .select({ id: configurations.id, name: configurations.name, ids: referenced })
    .from(configurations)
    .innerJoin(
      configurationVersions,
      and(
        eq(configurationVersions.configurationId, configurations.id),
        eq(configurationVersions.version, configurations.latestVersion),
      ),
    )
    .where(ids ? arrayOverlaps(referenced, [...ids]) : sql`cardinality(${referenced}) > 0`)
    .orderBy(asc(configurations.name));
  for (const row of rows) {
    for (const id of new Set(row.ids)) {
      const list = links.get(id) ?? [];
      list.push({ configurationId: row.id, name: row.name });
      links.set(id, list);
    }
  }
  return links;
}
