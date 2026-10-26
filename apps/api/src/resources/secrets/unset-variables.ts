/**
 * The MCP variables a configuration needs that are not set (Phase 5
 * decision #13, Phase 6 S7). New experiment shows them per configuration
 * before Launch (NewExperimentConfigOption.missingSecrets) and launch
 * answers 409 for them (MissingSecretsConflictSchema), so a run no longer
 * starts only to fail at setup.
 *
 * The same data as GET /resources/secrets (presence.ts): a stdio env name is
 * checked against the live worker's own environment names, an http header
 * variable against egress's, as the worker reported them on its row. With no
 * live worker every name is unset, as the Secrets page says. Names only;
 * values never reach here.
 */
import { eq, inArray } from 'drizzle-orm';
import type { MissingMcpSecret } from '@hermes-evals/shared';
import {
  configurationVersions,
  mcpServers,
  mcpServerVersions,
} from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { findLiveWorker } from '../../queue/live-worker.js';
import type { SecretReferencingServer, WorkerPresence } from './presence.js';

const byServerThenName = (a: MissingMcpSecret, b: MissingMcpSecret): number => {
  if (a.server !== b.server) return a.server < b.server ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

/**
 * The variables `servers` name that the service reading each lacks: env
 * names of stdio servers missing from `worker.envNames`, header variables
 * of http servers missing from `worker.egressEnvNames`, all of them when
 * `worker` is null. Sorted by server name, then variable name; a variable a
 * server names twice is listed once.
 */
export function unsetMcpVariables(
  servers: readonly SecretReferencingServer[],
  worker: WorkerPresence | null,
): MissingMcpSecret[] {
  const has = {
    stdio: new Set(worker?.envNames ?? []),
    http: new Set(worker?.egressEnvNames ?? []),
  };
  const missing = new Map<string, MissingMcpSecret>();
  for (const s of servers) {
    const names = s.transport === 'stdio' ? s.envNames : s.headers.map((h) => h.env);
    for (const name of names) {
      if (has[s.transport].has(name)) continue;
      missing.set(`${s.name}\u0000${name}`, { server: s.name, name, transport: s.transport });
    }
  }
  return [...missing.values()].sort(byServerThenName);
}

/**
 * unsetMcpVariables for each configuration version, over the MCP server
 * versions it pins (configuration_versions.mcp_server_version_ids), against
 * the live worker (findLiveWorker). Every id given is a key; a version
 * without MCP servers, or with every variable set, maps to []. Three
 * queries whatever the number of versions.
 */
export async function unsetMcpVariablesByVersion(
  db: AppDb,
  versionIds: readonly string[],
): Promise<Map<string, MissingMcpSecret[]>> {
  const result = new Map<string, MissingMcpSecret[]>(versionIds.map((id) => [id, []]));
  if (versionIds.length === 0) return result;
  // Sequential: the reads share one client.
  const pins = await db
    .select({
      id: configurationVersions.id,
      serverVersionIds: configurationVersions.mcpServerVersionIds,
    })
    .from(configurationVersions)
    .where(inArray(configurationVersions.id, [...new Set(versionIds)]));
  const serverVersionIds = [...new Set(pins.flatMap((p) => p.serverVersionIds))];
  if (serverVersionIds.length === 0) return result;
  const rows = await db
    .select({
      versionId: mcpServerVersions.id,
      id: mcpServers.id,
      name: mcpServers.name,
      transport: mcpServerVersions.transport,
      envNames: mcpServerVersions.envNames,
      headers: mcpServerVersions.headers,
    })
    .from(mcpServerVersions)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpServerVersions.mcpServerId))
    .where(inArray(mcpServerVersions.id, serverVersionIds));
  const worker = await findLiveWorker(db);
  const byVersionId = new Map<string, SecretReferencingServer>(rows.map((r) => [r.versionId, r]));
  for (const { id, serverVersionIds: pinned } of pins) {
    const servers = pinned.flatMap((v) => byVersionId.get(v) ?? []);
    result.set(id, unsetMcpVariables(servers, worker));
  }
  return result;
}
