/**
 * The unset-variable check of Phase 6 S7: which MCP variables a
 * configuration names that the service reading them lacks, by the rule of
 * the Secrets page (presence.ts), and per configuration version on PGlite.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissingMcpSecretSchema } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { workers } from '../../database/schema/index.js';
import {
  seedConfiguration,
  seedWorker,
} from '../../experiments/commands/commands-seed.support-spec.js';
import {
  pinMcpServers,
  reportEnvNames,
  seedMcpServer,
  seedSampleServers,
} from '../../experiments/commands/mcp-seed.support-spec.js';
import type { SecretReferencingServer, WorkerPresence } from './presence.js';
import { unsetMcpVariables, unsetMcpVariablesByVersion } from './unset-variables.js';

const invoiceDb: SecretReferencingServer = {
  id: 'mcp_invoice',
  name: 'invoice-db',
  transport: 'stdio',
  envNames: ['INVOICE_DB_URL', 'INVOICE_DB_TENANT'],
  headers: [],
};
const vendorDirectory: SecretReferencingServer = {
  id: 'mcp_vendor',
  name: 'vendor-directory',
  transport: 'http',
  envNames: [],
  headers: [
    { header: 'Authorization', env: 'VENDOR_DIRECTORY_TOKEN' },
    { header: 'X-Tenant', env: 'VENDOR_TENANT' },
  ],
};

const worker = (over: Partial<WorkerPresence> = {}): WorkerPresence => ({
  envNames: ['INVOICE_DB_URL', 'PATH'],
  egressEnvNames: ['VENDOR_TENANT'],
  startedAt: new Date('2026-10-26T09:00:00.000Z'),
  lastHeartbeatAt: new Date('2026-10-26T09:00:10.000Z'),
  ...over,
});

describe('unsetMcpVariables', () => {
  it('checks stdio env names against the worker and header variables against egress', () => {
    const missing = unsetMcpVariables([vendorDirectory, invoiceDb], worker());
    expect(missing).toEqual([
      { server: 'invoice-db', name: 'INVOICE_DB_TENANT', transport: 'stdio' },
      { server: 'vendor-directory', name: 'VENDOR_DIRECTORY_TOKEN', transport: 'http' },
    ]);
    for (const m of missing) MissingMcpSecretSchema.parse(m);
  });

  it('does not count a name the wrong service has', () => {
    // The worker has the token and egress has the URL: each server still lacks its variable.
    const swapped = worker({
      envNames: ['VENDOR_DIRECTORY_TOKEN', 'INVOICE_DB_TENANT'],
      egressEnvNames: ['INVOICE_DB_URL', 'VENDOR_TENANT'],
    });
    expect(unsetMcpVariables([invoiceDb, vendorDirectory], swapped)).toEqual([
      { server: 'invoice-db', name: 'INVOICE_DB_URL', transport: 'stdio' },
      { server: 'vendor-directory', name: 'VENDOR_DIRECTORY_TOKEN', transport: 'http' },
    ]);
  });

  it('lists every variable when no worker is connected, each once per server, sorted', () => {
    const twice: SecretReferencingServer = {
      ...vendorDirectory,
      headers: [
        { header: 'X-Tenant', env: 'VENDOR_TENANT' },
        { header: 'X-Account', env: 'VENDOR_TENANT' },
        { header: 'Authorization', env: 'VENDOR_DIRECTORY_TOKEN' },
      ],
    };
    const ledger: SecretReferencingServer = { ...invoiceDb, id: 'mcp_ledger', name: 'ledger' };
    expect(unsetMcpVariables([twice, ledger, invoiceDb, twice], null)).toEqual([
      { server: 'invoice-db', name: 'INVOICE_DB_TENANT', transport: 'stdio' },
      { server: 'invoice-db', name: 'INVOICE_DB_URL', transport: 'stdio' },
      { server: 'ledger', name: 'INVOICE_DB_TENANT', transport: 'stdio' },
      { server: 'ledger', name: 'INVOICE_DB_URL', transport: 'stdio' },
      { server: 'vendor-directory', name: 'VENDOR_DIRECTORY_TOKEN', transport: 'http' },
      { server: 'vendor-directory', name: 'VENDOR_TENANT', transport: 'http' },
    ]);
  });

  it('is empty when every variable is set, or nothing is referenced', () => {
    const all = worker({
      envNames: ['INVOICE_DB_URL', 'INVOICE_DB_TENANT'],
      egressEnvNames: ['VENDOR_DIRECTORY_TOKEN', 'VENDOR_TENANT'],
    });
    expect(unsetMcpVariables([invoiceDb, vendorDirectory], all)).toEqual([]);
    expect(unsetMcpVariables([], null)).toEqual([]);
  });
});

describe('unsetMcpVariablesByVersion', () => {
  let t: TestDatabase;
  beforeEach(async () => {
    t = await createTestDatabase();
  });
  afterEach(() => t.close());

  it('maps every version id given to what its pinned MCP server versions lack on the live worker', async () => {
    const servers = await seedSampleServers(t.db);
    const plain = await seedConfiguration(t.db, 'baseline');
    const withMcp = await seedConfiguration(t.db, 'with-mcp');
    const stdioOnly = await seedConfiguration(t.db, 'stdio-only');
    await pinMcpServers(t.db, withMcp.versionId, [servers.invoiceDb, servers.vendorDirectory]);
    await pinMcpServers(t.db, stdioOnly.versionId, [servers.invoiceDb]);
    const workerId = await seedWorker(t.db);
    await reportEnvNames(t.db, workerId, { envNames: ['INVOICE_DB_URL'], egressEnvNames: [] });

    const ids = [plain.versionId, withMcp.versionId, stdioOnly.versionId, 'cv_missing'];
    const unset = await unsetMcpVariablesByVersion(t.db, ids);
    expect([...unset.keys()]).toEqual(ids);
    expect(unset.get(plain.versionId)).toEqual([]);
    expect(unset.get(withMcp.versionId)).toEqual([
      { server: 'vendor-directory', name: 'VENDOR_DIRECTORY_TOKEN', transport: 'http' },
    ]);
    expect(unset.get(stdioOnly.versionId)).toEqual([]);
    expect(unset.get('cv_missing')).toEqual([]);

    await reportEnvNames(t.db, workerId, {
      envNames: ['INVOICE_DB_URL'],
      egressEnvNames: ['VENDOR_DIRECTORY_TOKEN'],
    });
    expect(
      (await unsetMcpVariablesByVersion(t.db, [withMcp.versionId])).get(withMcp.versionId),
    ).toEqual([]);
  });

  it('counts nothing as set once the worker has gone silent', async () => {
    const stdio = await seedMcpServer(t.db, 'ledger', {
      transport: 'stdio',
      envNames: ['LEDGER_URL'],
    });
    const config = await seedConfiguration(t.db, 'with-ledger');
    await pinMcpServers(t.db, config.versionId, [stdio]);
    const workerId = await seedWorker(t.db, { silentS: 3600 });
    await reportEnvNames(t.db, workerId, { envNames: ['LEDGER_URL'], egressEnvNames: [] });
    expect(
      (await unsetMcpVariablesByVersion(t.db, [config.versionId])).get(config.versionId),
    ).toEqual([{ server: 'ledger', name: 'LEDGER_URL', transport: 'stdio' }]);
    // The live worker's row is what counts; a stopped one does not.
    await t.db.update(workers).set({ lastHeartbeatAt: sql`now()`, stoppedAt: sql`now()` });
    expect(
      (await unsetMcpVariablesByVersion(t.db, [config.versionId])).get(config.versionId),
    ).toHaveLength(1);
  });

  it('answers an empty map for no ids', async () => {
    expect(await unsetMcpVariablesByVersion(t.db, [])).toEqual(new Map());
  });
});
