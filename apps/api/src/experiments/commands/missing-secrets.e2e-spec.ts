/**
 * The launch's unset-variable gate (Phase 6 S7) on Postgres 17 through
 * node-postgres: 409 with nothing stored while egress lacks the sample http
 * server's token, then a launch once the worker reports it.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LaunchExperimentResultSchema, MissingSecretsConflictSchema } from '@hermes-evals/shared';
import { experiments } from '../../database/schema/index.js';
import { createE2eDatabase, SERVER_URL, type E2eDatabase } from './commands-e2e.support-spec.js';
import { seedConfiguration, seedSuite, seedWorker } from './commands-seed.support-spec.js';
import { pinMcpServers, reportEnvNames, seedSampleServers } from './mcp-seed.support-spec.js';

describe.skipIf(!SERVER_URL)('launch with unset MCP variables on Postgres 17', () => {
  let e: E2eDatabase;
  beforeEach(async () => {
    e = await createE2eDatabase('secrets');
  });
  afterEach(() => e.close());

  it('refuses, storing nothing, until egress has the header variable', async () => {
    const { c } = e;
    const suite = await seedSuite(c.t.db, {
      tasks: [{ key: 'alpha' }, { key: 'bravo' }, { key: 'charlie' }],
    });
    const base = await seedConfiguration(c.t.db, 'docs-export');
    const withMcp = await seedConfiguration(c.t.db, 'with-mcp');
    const servers = await seedSampleServers(c.t.db);
    await pinMcpServers(c.t.db, withMcp.versionId, [servers.invoiceDb, servers.vendorDirectory]);
    const workerId = await seedWorker(c.t.db);
    await reportEnvNames(c.t.db, workerId, { envNames: ['INVOICE_DB_URL'], egressEnvNames: [] });
    const body = {
      name: 'MCP vs documents',
      description: '',
      suiteId: suite.id,
      taskKeys: ['alpha', 'bravo', 'charlie'],
      baselineVersionId: base.versionId,
      candidateVersionIds: [withMcp.versionId],
      repetitions: 1,
      concurrency: 2,
      spendCeilingUsd: null,
      timeBudgetOverrideS: null,
      expectedConfigHashes: {
        [base.versionId]: base.configHash,
        [withMcp.versionId]: withMcp.configHash,
      },
    };

    const refusal = MissingSecretsConflictSchema.parse(
      (await c.post('/experiments', body).expect(409)).body,
    );
    expect(refusal.issues).toEqual([
      {
        path: 'candidateVersionIds.0',
        message: 'VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress)',
      },
    ]);
    expect(await c.t.db.select().from(experiments)).toEqual([]);
    expect(await c.jobs()).toEqual([]);

    await reportEnvNames(c.t.db, workerId, {
      envNames: ['INVOICE_DB_URL'],
      egressEnvNames: ['VENDOR_DIRECTORY_TOKEN'],
    });
    LaunchExperimentResultSchema.parse((await c.post('/experiments', body).expect(201)).body);
    expect(await c.jobs()).toHaveLength(6);
  });
});
