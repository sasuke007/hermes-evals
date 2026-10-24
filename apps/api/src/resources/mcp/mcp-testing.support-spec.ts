/**
 * Test data shared by the MCP, secrets and test-handler specs. The name ends
 * in `-spec.ts` so the build leaves it out, but not in `.spec.ts`, so vitest
 * does not run it as a test file.
 */
import { createHash } from 'node:crypto';
import { HERMES_REVISION, type McpServerInput } from '@hermes-evals/shared';
import { configurations, configurationVersions, workers } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';

/** The sample stdio server baked into the trial image (docker/mcp/invoice-db). */
export const INVOICE_DB: McpServerInput = {
  name: 'invoice-db',
  transport: 'stdio',
  command: 'invoice-db-mcp',
  args: [],
  envNames: ['INVOICE_DB_URL'],
  url: null,
  headers: [],
  include: [],
  exclude: ['delete_*'],
  timeoutS: 30,
};

export const VENDOR_API: McpServerInput = {
  name: 'vendor-api',
  transport: 'http',
  command: null,
  args: [],
  envNames: [],
  url: 'https://vendor-api.example.com/mcp',
  headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }],
  include: [],
  exclude: [],
  timeoutS: 60,
};

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

/**
 * Saves configuration `name` whose versions use the given MCP server
 * versions, one array per configuration version; the last is its latest.
 * The configuration trigger freezes every MCP version it references.
 */
export async function useInConfiguration(
  db: AppDb,
  name: string,
  ...versions: string[][]
): Promise<string> {
  return db.transaction(async (tx) => {
    const [configuration] = await tx
      .insert(configurations)
      .values({ name, latestVersion: versions.length })
      .returning();
    for (const [i, mcpServerVersionIds] of versions.entries()) {
      await tx.insert(configurationVersions).values({
        configurationId: configuration!.id,
        version: i + 1,
        model: 'openai/gpt-6.1-sol',
        provider: 'nous',
        toolsets: ['file', 'terminal'],
        mcpServerVersionIds,
        maxTurns: 20,
        timeBudgetS: 300,
        configHash: sha(`${name} ${i}`),
      });
    }
    return configuration!.id;
  });
}

/** A live worker row that reports these env names (its own and egress's). */
export async function insertWorker(
  db: AppDb,
  names: { env?: string[]; egress?: string[] } = {},
): Promise<string> {
  const [row] = await db
    .insert(workers)
    .values({
      hostname: 'worker-1',
      concurrency: 2,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      envNames: names.env ?? [],
      egressEnvNames: names.egress ?? [],
    })
    .returning({ id: workers.id });
  return row!.id;
}
