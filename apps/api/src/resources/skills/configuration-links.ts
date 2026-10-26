/**
 * "Used by" for skills and "Attached to" for documents: the configurations
 * whose latest version references a resource. Older versions are history;
 * a configuration that dropped a skill in its latest version no longer uses
 * it, even if an experiment ran on the version that had it.
 *
 * Deleting one (Phase 5 section 6.1) looks at every version instead: a
 * version keeps what it was saved with, so a skill or document any version
 * names stays, and migration 0009's guard refuses its deletion too. The
 * rows say so up front (`inUse` and `inUseBy`, Phase 7), so the pages
 * disable Delete with the same list the 409 would name.
 */
import { ConflictException } from '@nestjs/common';
import type { ConfigurationLink, ResourceInUseBody } from '@hermes-evals/shared';
import { and, arrayOverlaps, asc, eq, sql } from 'drizzle-orm';
import { configurations, configurationVersions } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { notFound } from './http.js';

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

/**
 * Maps each resource id to the configurations any of whose versions lists it
 * in `column` (the row's `inUseBy`, Phase 7), sorted by configuration name.
 * With `ids`, only those resources are looked up. A configuration appears
 * once however many of its versions name the resource.
 */
export async function anyVersionConfigurationLinks(
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
    .innerJoin(configurationVersions, eq(configurationVersions.configurationId, configurations.id))
    .where(ids ? arrayOverlaps(referenced, [...ids]) : sql`cardinality(${referenced}) > 0`)
    .orderBy(asc(configurations.name), asc(configurations.id));
  for (const row of rows) {
    for (const id of new Set(row.ids)) {
      const list = links.get(id) ?? [];
      if (!list.some((link) => link.configurationId === row.id)) {
        list.push({ configurationId: row.id, name: row.name });
      }
      links.set(id, list);
    }
  }
  return links;
}

/** The fields every skill and document row carries: whether any configuration version names it. */
export function inUseFields(inUseBy: ConfigurationLink[]): {
  inUse: boolean;
  inUseBy: ConfigurationLink[];
} {
  return { inUse: inUseBy.length > 0, inUseBy };
}

/** The configurations any version of which lists the resource in `column`, by name. */
export async function configurationsNaming(
  db: AppDb,
  column: ResourceIdColumn,
  id: string,
): Promise<ConfigurationLink[]> {
  const referenced = configurationVersions[column];
  return db
    .selectDistinct({ configurationId: configurations.id, name: configurations.name })
    .from(configurations)
    .innerJoin(configurationVersions, eq(configurationVersions.configurationId, configurations.id))
    .where(sql`${id} = any(${referenced})`)
    .orderBy(asc(configurations.name), asc(configurations.id));
}

/** `a`, `a and b`, `a, b and c`. */
const listed = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** The 409 of a delete refused because configurations still name the resource (ResourceInUseBody). */
export function resourceInUse(what: string, usedBy: ConfigurationLink[]): ConflictException {
  const body: ResourceInUseBody = {
    statusCode: 409,
    message:
      `${what} is part of a saved version of ${listed(usedBy.map((c) => c.name))}, ` +
      'and a configuration version keeps what it was saved with, so it cannot be deleted',
    usedBy,
  };
  return new ConflictException(body);
}

/** Postgres's foreign_key_violation, as node-postgres or PGlite report it under Drizzle's wrapper. */
const isForeignKeyViolation = (err: unknown): boolean => {
  const code = (e: unknown) => (e as { code?: string } | null)?.code;
  return code(err) === '23503' || code((err as { cause?: unknown }).cause) === '23503';
};

/**
 * Deletes a skill or document no configuration version names: 409 naming
 * the configurations that do, checked first and again through the database
 * guard when a configuration was saved with it meanwhile; 404 when `remove`
 * finds the row already gone.
 */
export async function deleteUnused(
  db: AppDb,
  resource: { column: ResourceIdColumn; id: string; what: string },
  remove: () => Promise<boolean>,
): Promise<void> {
  const refusal = async (): Promise<ConflictException | null> => {
    const usedBy = await configurationsNaming(db, resource.column, resource.id);
    return usedBy.length > 0 ? resourceInUse(resource.what, usedBy) : null;
  };
  const before = await refusal();
  if (before) throw before;
  let removed: boolean;
  try {
    removed = await remove();
  } catch (err) {
    if (!isForeignKeyViolation(err)) throw err;
    throw (await refusal()) ?? err;
  }
  if (!removed) throw notFound(`${resource.what} was deleted meanwhile`);
}
