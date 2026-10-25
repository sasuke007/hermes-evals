/**
 * Rows the configuration tests build on: a skill, a document and MCP
 * servers, inserted the way the resource services store them. Test-only:
 * the name ends in `spec.ts` so the build leaves it out, but not in
 * `.spec.ts`, so vitest does not run it as a test file.
 */
import { HttpException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { ConfigurationInputSchema, type ConfigurationInput } from '@hermes-evals/shared';
import { blob, sha } from '../../test/support/seed.js';
import {
  configurationVersions,
  documents,
  mcpServers,
  mcpServerVersions,
  skills,
} from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';

export interface Library {
  skillId: string;
  documentId: string;
  mcpServerId: string;
  mcpV1: string;
  mcpV2: string;
  httpMcpV1: string;
}

/** invoice-method@1.0.0, vendor-policy-v3.pdf, invoice-db v1 and v2 (stdio), vendor-api v1 (http). */
export async function seedLibrary(db: AppDb): Promise<Library> {
  const [skill] = await db
    .insert(skills)
    .values({
      name: 'invoice-method',
      version: '1.0.0',
      description: 'Reconcile invoices against the ledger before answering.',
      contentHash: sha('skill invoice-method 1.0.0'),
      fileCount: 3,
      sizeBytes: 4096,
    })
    .returning({ id: skills.id });
  const [document] = await db
    .insert(documents)
    .values({
      filename: 'vendor-policy-v3.pdf',
      mime: 'application/pdf',
      size: 219_136,
      sha256: await blob(db, 'vendor policy v3'),
    })
    .returning({ id: documents.id });
  const invoiceDb = await db.transaction(async (tx) => {
    const [server] = await tx
      .insert(mcpServers)
      .values({ name: 'invoice-db', latestVersion: 2 })
      .returning({ id: mcpServers.id });
    const versions = await tx
      .insert(mcpServerVersions)
      .values(
        [1, 2].map((version) => ({
          mcpServerId: server!.id,
          version,
          transport: 'stdio' as const,
          command: 'invoice-db-mcp',
          args: version === 2 ? ['--read-only'] : [],
          envNames: ['INVOICE_DB_URL'],
          definitionHash: sha(`invoice-db v${version}`),
        })),
      )
      .returning({ id: mcpServerVersions.id, version: mcpServerVersions.version });
    return {
      id: server!.id,
      v1: versions.find((v) => v.version === 1)!.id,
      v2: versions.find((v) => v.version === 2)!.id,
    };
  });
  const vendorApi = await db.transaction(async (tx) => {
    const [server] = await tx
      .insert(mcpServers)
      .values({ name: 'vendor-api' })
      .returning({ id: mcpServers.id });
    const [version] = await tx
      .insert(mcpServerVersions)
      .values({
        mcpServerId: server!.id,
        version: 1,
        transport: 'http',
        url: 'https://vendor-api.example.com/mcp',
        headers: [{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }],
        definitionHash: sha('vendor-api v1'),
      })
      .returning({ id: mcpServerVersions.id });
    return version!.id;
  });
  return {
    skillId: skill!.id,
    documentId: document!.id,
    mcpServerId: invoiceDb.id,
    mcpV1: invoiceDb.v1,
    mcpV2: invoiceDb.v2,
    httpMcpV1: vendorApi,
  };
}

/** A valid save body, parsed the way the controller's pipe parses it. */
export const configurationInput = (
  overrides: Partial<ConfigurationInput> = {},
): ConfigurationInput =>
  ConfigurationInputSchema.parse({
    name: 'baseline',
    model: 'openai/gpt-6.1-sol',
    provider: 'nous',
    baseUrl: null,
    toolsets: ['terminal', 'file'],
    memoryEnabled: false,
    skillIds: [],
    documentIds: [],
    mcpServerVersionIds: [],
    maxTurns: 20,
    timeBudgetS: 300,
    duplicatedFromVersionId: null,
    ...overrides,
  });

/** Awaits a call that must fail with an HttpException and returns its status and body. */
export async function httpError(
  call: Promise<unknown>,
): Promise<{ status: number; body: { statusCode?: number; message?: string; issues?: unknown } }> {
  try {
    await call;
  } catch (err) {
    if (err instanceof HttpException) {
      return { status: err.getStatus(), body: err.getResponse() as { message?: string } };
    }
    throw err;
  }
  throw new Error('expected an HttpException');
}

/** frozen_at of an MCP definition. */
export async function mcpFrozenAt(db: AppDb, versionId: string): Promise<Date | null> {
  const [row] = await db
    .select({ frozenAt: mcpServerVersions.frozenAt })
    .from(mcpServerVersions)
    .where(eq(mcpServerVersions.id, versionId));
  return row!.frozenAt;
}

/** Marks a configuration version used, as an experiment launch would. */
export const freezeVersion = (db: AppDb, versionId: string) =>
  db
    .update(configurationVersions)
    .set({ frozenAt: new Date() })
    .where(eq(configurationVersions.id, versionId));

/** The stored row of a configuration version. */
export async function versionRow(db: AppDb, versionId: string) {
  const [row] = await db
    .select()
    .from(configurationVersions)
    .where(eq(configurationVersions.id, versionId));
  return row!;
}

/** One more stdio MCP server with a version 1, e.g. `invoice_db` beside the library's `invoice-db`. */
export async function seedStdioMcpServer(db: AppDb, name: string): Promise<string> {
  return db.transaction(async (tx) => {
    const [server] = await tx.insert(mcpServers).values({ name }).returning({ id: mcpServers.id });
    const [version] = await tx
      .insert(mcpServerVersions)
      .values({
        mcpServerId: server!.id,
        version: 1,
        transport: 'stdio',
        command: `${name}-mcp`,
        definitionHash: sha(`${name} v1`),
      })
      .returning({ id: mcpServerVersions.id });
    return version!.id;
  });
}
