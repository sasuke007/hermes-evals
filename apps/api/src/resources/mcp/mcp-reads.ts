/**
 * Reads of MCP servers: each server with its latest version, the versions
 * configurations still pin, the configurations that use each server, and
 * where a variable name is used. Shared by the list endpoint, the save
 * endpoints (which answer with the saved row), the secrets page, the
 * configuration form and the worker's MCP test.
 */
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ConfigurationLink, McpServerRow } from '@hermes-evals/shared';
import {
  configurations,
  configurationVersions,
  mcpServers,
  mcpServerVersions,
} from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { toMcpServerRow } from './views.js';

/** Every server (or only `ids`) joined to its latest version, by name. */
export function latestVersions(db: AppDb, ids?: readonly string[]) {
  const latest = and(
    eq(mcpServerVersions.mcpServerId, mcpServers.id),
    eq(mcpServerVersions.version, mcpServers.latestVersion),
  );
  return db
    .select({ server: mcpServers, version: mcpServerVersions })
    .from(mcpServers)
    .innerJoin(mcpServerVersions, latest)
    .where(ids ? inArray(mcpServers.id, [...ids]) : undefined)
    .orderBy(asc(mcpServers.name));
}

/**
 * Configurations whose latest version references any version of each server,
 * by server id. A configuration still on version 1 of a server that is now at
 * version 2 uses the server, so it counts.
 */
export async function usedByServer(
  db: AppDb,
  ids?: readonly string[],
): Promise<Map<string, ConfigurationLink[]>> {
  const rows = await db
    .selectDistinct({
      serverId: mcpServerVersions.mcpServerId,
      configurationId: configurations.id,
      name: configurations.name,
    })
    .from(configurations)
    .innerJoin(
      configurationVersions,
      and(
        eq(configurationVersions.configurationId, configurations.id),
        eq(configurationVersions.version, configurations.latestVersion),
      ),
    )
    .innerJoin(
      mcpServerVersions,
      sql`${mcpServerVersions.id} = any(${configurationVersions.mcpServerVersionIds})`,
    )
    .where(ids ? inArray(mcpServerVersions.mcpServerId, [...ids]) : undefined)
    .orderBy(asc(configurations.name), asc(configurations.id));
  const byServer = new Map<string, ConfigurationLink[]>();
  for (const { serverId, configurationId, name } of rows) {
    const links = byServer.get(serverId) ?? [];
    links.push({ configurationId, name });
    byServer.set(serverId, links);
  }
  return byServer;
}

/** The rows GET /resources/mcp-servers returns, for every server or only `ids`. */
export async function loadMcpServerRows(
  db: AppDb,
  ids?: readonly string[],
): Promise<McpServerRow[]> {
  const [latest, usedBy] = await Promise.all([latestVersions(db, ids), usedByServer(db, ids)]);
  return latest.map(({ server, version }) =>
    toMcpServerRow(server, version, usedBy.get(server.id) ?? []),
  );
}

/**
 * Every version some configuration's latest version pins, joined to its
 * server, by name then version (newest first). A frozen version stays pinned
 * after its server moves on to a newer one (UI_FLOWS 9.3), and the next run
 * of that configuration starts it: the secrets page and the form need these
 * as well as the latest versions. Same join as usedByServer.
 */
export function referencedVersions(db: AppDb) {
  return db
    .selectDistinct({ server: mcpServers, version: mcpServerVersions })
    .from(configurations)
    .innerJoin(
      configurationVersions,
      and(
        eq(configurationVersions.configurationId, configurations.id),
        eq(configurationVersions.version, configurations.latestVersion),
      ),
    )
    .innerJoin(
      mcpServerVersions,
      sql`${mcpServerVersions.id} = any(${configurationVersions.mcpServerVersionIds})`,
    )
    .innerJoin(mcpServers, eq(mcpServers.id, mcpServerVersions.mcpServerId))
    .orderBy(asc(mcpServers.name), desc(mcpServerVersions.version));
}

/** One definition's use of a variable name. */
export interface VariableUse {
  env: string;
  /** The server's name. */
  server: string;
}

/**
 * Where http definitions (any version) use one of `names` as a header
 * variable, by server name. Egress holds those values, so no stdio
 * definition may name them: its values enter the trial.
 */
export async function headerVariableUses(
  db: AppDb,
  names: readonly string[],
  exceptVersionId?: string,
): Promise<VariableUse[]> {
  if (names.length === 0) return [];
  const wanted = new Set(names);
  const rows = await db
    .select({ server: mcpServers.name, headers: mcpServerVersions.headers })
    .from(mcpServerVersions)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpServerVersions.mcpServerId))
    .where(
      and(
        eq(mcpServerVersions.transport, 'http'),
        exceptVersionId ? ne(mcpServerVersions.id, exceptVersionId) : undefined,
      ),
    )
    .orderBy(asc(mcpServers.name), asc(mcpServerVersions.version));
  return rows.flatMap(({ server, headers }) =>
    headers.filter((h) => wanted.has(h.env)).map((h) => ({ env: h.env, server })),
  );
}

/** Where stdio definitions (any version) use one of `names` as an env name, by server name. */
export async function stdioEnvUses(
  db: AppDb,
  names: readonly string[],
  exceptVersionId?: string,
): Promise<VariableUse[]> {
  if (names.length === 0) return [];
  const wanted = new Set(names);
  const rows = await db
    .select({ server: mcpServers.name, envNames: mcpServerVersions.envNames })
    .from(mcpServerVersions)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpServerVersions.mcpServerId))
    .where(
      and(
        eq(mcpServerVersions.transport, 'stdio'),
        exceptVersionId ? ne(mcpServerVersions.id, exceptVersionId) : undefined,
      ),
    )
    .orderBy(asc(mcpServers.name), asc(mcpServerVersions.version));
  return rows.flatMap(({ server, envNames }) =>
    envNames.filter((n) => wanted.has(n)).map((env) => ({ env, server })),
  );
}
