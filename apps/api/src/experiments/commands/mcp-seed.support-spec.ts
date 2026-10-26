/**
 * The two sample MCP servers as definitions (plan 18.2 P4), pinned to
 * configuration versions, and the env names a worker row reports, for the
 * tests of the unset-variable check (Phase 6 S7). Rows as the MCP and
 * configuration services store them. Test-only (see
 * commands-seed.support-spec.ts).
 */
import { eq } from 'drizzle-orm';
import type { McpHeader } from '@hermes-evals/shared';
import {
  configurationVersions,
  mcpServers,
  mcpServerVersions,
  workers,
} from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { sha } from './commands-seed.support-spec.js';

export type McpSeed =
  { transport: 'stdio'; envNames: string[] } | { transport: 'http'; headers: McpHeader[] };

/** An MCP server and its version 1; returns the version id. */
export async function seedMcpServer(db: AppDb, name: string, seed: McpSeed): Promise<string> {
  return db.transaction(async (tx) => {
    const [server] = await tx.insert(mcpServers).values({ name }).returning({ id: mcpServers.id });
    const [version] = await tx
      .insert(mcpServerVersions)
      .values({
        mcpServerId: server!.id,
        version: 1,
        definitionHash: sha(`${name} v1`),
        ...(seed.transport === 'stdio'
          ? { transport: 'stdio', command: `${name}-mcp`, envNames: seed.envNames }
          : { transport: 'http', url: `http://${name}:8000/mcp`, headers: seed.headers }),
      })
      .returning({ id: mcpServerVersions.id });
    return version!.id;
  });
}

/** invoice-db (stdio, INVOICE_DB_URL) and vendor-directory (http, Authorization ← VENDOR_DIRECTORY_TOKEN). */
export async function seedSampleServers(
  db: AppDb,
): Promise<{ invoiceDb: string; vendorDirectory: string }> {
  return {
    invoiceDb: await seedMcpServer(db, 'invoice-db', {
      transport: 'stdio',
      envNames: ['INVOICE_DB_URL'],
    }),
    vendorDirectory: await seedMcpServer(db, 'vendor-directory', {
      transport: 'http',
      headers: [{ header: 'Authorization', env: 'VENDOR_DIRECTORY_TOKEN' }],
    }),
  };
}

/** An unfrozen configuration version now uses these MCP server versions, as an in-place edit saves it. */
export async function pinMcpServers(
  db: AppDb,
  configurationVersionId: string,
  serverVersionIds: string[],
): Promise<void> {
  await db
    .update(configurationVersions)
    .set({ mcpServerVersionIds: serverVersionIds })
    .where(eq(configurationVersions.id, configurationVersionId));
}

/** The names a worker reported: its own environment's and egress's. */
export async function reportEnvNames(
  db: AppDb,
  workerId: string,
  names: { envNames: string[]; egressEnvNames: string[] },
): Promise<void> {
  await db.update(workers).set(names).where(eq(workers.id, workerId));
}
