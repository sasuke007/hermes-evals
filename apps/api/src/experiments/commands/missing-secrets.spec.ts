/**
 * Phase 5 decision #13, Phase 6 S7 over HTTP on PGlite: launch answers 409
 * naming each MCP variable a chosen configuration needs that is not set,
 * and New experiment's options carry the same list per configuration.
 * Every answer is parsed with its shared schema.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApiErrorBodySchema,
  LaunchExperimentResultSchema,
  MissingSecretsConflictSchema,
  NewExperimentOptionsSchema,
  type LaunchExperimentInput,
} from '@hermes-evals/shared';
import { configurationVersions, experiments, runs } from '../../database/schema/index.js';
import { createCommandsApp, type CommandsApp } from './commands-app.support-spec.js';
import {
  seedConfiguration,
  seedSuite,
  seedWorker,
  type SeededConfiguration,
  type SeededSuite,
} from './commands-seed.support-spec.js';
import { pinMcpServers, reportEnvNames, seedSampleServers } from './mcp-seed.support-spec.js';

let c: CommandsApp;
let suite: SeededSuite;
let base: SeededConfiguration;
let withMcp: SeededConfiguration;
let servers: { invoiceDb: string; vendorDirectory: string };

beforeEach(async () => {
  c = await createCommandsApp();
  suite = await seedSuite(c.t.db, {
    tasks: [{ key: 'alpha' }, { key: 'bravo' }, { key: 'charlie' }],
  });
  base = await seedConfiguration(c.t.db, 'docs-export');
  withMcp = await seedConfiguration(c.t.db, 'with-mcp');
  servers = await seedSampleServers(c.t.db);
  await pinMcpServers(c.t.db, withMcp.versionId, [servers.invoiceDb, servers.vendorDirectory]);
});

afterEach(() => c.close());

const body = (candidates: SeededConfiguration[], baseline = base): LaunchExperimentInput => ({
  name: 'MCP vs documents',
  description: '',
  suiteId: suite.id,
  taskKeys: ['alpha', 'bravo', 'charlie'],
  baselineVersionId: baseline.versionId,
  candidateVersionIds: candidates.map((v) => v.versionId),
  repetitions: 1,
  concurrency: 2,
  spendCeilingUsd: null,
  timeBudgetOverrideS: null,
  expectedConfigHashes: Object.fromEntries(
    [baseline, ...candidates].map((v) => [v.versionId, v.configHash]),
  ),
});

async function expectNothingLaunched(): Promise<void> {
  expect(await c.t.db.select().from(experiments)).toEqual([]);
  expect(await c.t.db.select().from(runs)).toEqual([]);
  expect(await c.jobs()).toEqual([]);
  const frozen = await c.t.db
    .select({ frozenAt: configurationVersions.frozenAt })
    .from(configurationVersions);
  expect(frozen.every((v) => v.frozenAt === null)).toBe(true);
}

describe('POST /api/experiments with unset MCP variables', () => {
  it('answers 409 naming each unset variable with its server, on the field that chose it', async () => {
    await seedWorker(c.t.db);
    const res = await c.post('/experiments', body([withMcp])).expect(409);
    const refusal = MissingSecretsConflictSchema.parse(res.body);
    expect(refusal.message).toBe(
      'with-mcp: INVOICE_DB_URL (invoice-db, read by the worker) and VENDOR_DIRECTORY_TOKEN ' +
        '(vendor-directory, added by egress) are not set. Set each in .env, then recreate the ' +
        'worker (stdio) or egress (http) so it reads them.',
    );
    expect(refusal.issues).toEqual([
      { path: 'candidateVersionIds.0', message: 'INVOICE_DB_URL (invoice-db, read by the worker)' },
      {
        path: 'candidateVersionIds.0',
        message: 'VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress)',
      },
    ]);
    await expectNothingLaunched();
  });

  it('checks stdio names against the worker and header variables against egress, per configuration', async () => {
    const workerId = await seedWorker(c.t.db);
    // The token in the worker's environment does not help: egress adds the header.
    await reportEnvNames(c.t.db, workerId, {
      envNames: ['INVOICE_DB_URL', 'VENDOR_DIRECTORY_TOKEN'],
      egressEnvNames: [],
    });
    const second = await seedConfiguration(c.t.db, 'stdio-only');
    await pinMcpServers(c.t.db, second.versionId, [servers.invoiceDb]);
    await pinMcpServers(c.t.db, base.versionId, [servers.vendorDirectory]);
    const res = await c.post('/experiments', body([second, withMcp])).expect(409);
    const refusal = MissingSecretsConflictSchema.parse(res.body);
    expect(refusal.issues).toEqual([
      {
        path: 'baselineVersionId',
        message: 'VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress)',
      },
      {
        path: 'candidateVersionIds.1',
        message: 'VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress)',
      },
    ]);
    expect(refusal.message).toBe(
      'docs-export: VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress) is not set; ' +
        'with-mcp: VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress) is not set. ' +
        'Set each in .env, then recreate the worker (stdio) or egress (http) so it reads them.',
    );
    await expectNothingLaunched();
  });

  it('launches once every variable is set where it is read', async () => {
    const workerId = await seedWorker(c.t.db);
    await reportEnvNames(c.t.db, workerId, {
      envNames: ['INVOICE_DB_URL'],
      egressEnvNames: ['VENDOR_DIRECTORY_TOKEN'],
    });
    const res = await c.post('/experiments', body([withMcp])).expect(201);
    LaunchExperimentResultSchema.parse(res.body);
    expect(await c.jobs()).toHaveLength(6);
  });

  it('comes after the worker and provider gates', async () => {
    const noWorker = ApiErrorBodySchema.parse(
      (await c.post('/experiments', body([withMcp])).expect(409)).body,
    );
    expect(noWorker.message).toMatch(/^No worker is connected/);
    expect(noWorker.issues).toBeUndefined();
    await seedWorker(c.t.db);
    const nous = await seedConfiguration(c.t.db, 'on-nous', {
      provider: 'nous',
      model: 'openai/gpt-6.1-sol',
    });
    await pinMcpServers(c.t.db, nous.versionId, [servers.invoiceDb]);
    c.nous.status = 'not_connected';
    const blocked = ApiErrorBodySchema.parse(
      (await c.post('/experiments', body([nous])).expect(409)).body,
    );
    expect(blocked.message).not.toMatch(/INVOICE_DB_URL/);
    expect(blocked.issues).toBeUndefined();
    await expectNothingLaunched();
  });
});

describe('GET /api/experiments/new-options missingSecrets', () => {
  it('lists the unset variables of each configuration, as launch would refuse them', async () => {
    const workerId = await seedWorker(c.t.db);
    await reportEnvNames(c.t.db, workerId, { envNames: ['INVOICE_DB_URL'], egressEnvNames: [] });
    const options = NewExperimentOptionsSchema.parse(
      (await c.get('/experiments/new-options').expect(200)).body,
    );
    const byName = new Map(options.configurations.map((o) => [o.name, o]));
    expect(byName.get('docs-export')).toMatchObject({
      mcpServers: [],
      missingSecrets: [],
      skillLoading: 'preload',
    });
    expect(byName.get('with-mcp')).toMatchObject({
      mcpServers: ['invoice-db (stdio)', 'vendor-directory (http)'],
      missingSecrets: [
        { server: 'vendor-directory', name: 'VENDOR_DIRECTORY_TOKEN', transport: 'http' },
      ],
    });
  });

  it('lists every variable as unset with no live worker', async () => {
    const options = NewExperimentOptionsSchema.parse(
      (await c.get('/experiments/new-options').expect(200)).body,
    );
    expect(options.configurations.find((o) => o.name === 'with-mcp')!.missingSecrets).toEqual([
      { server: 'invoice-db', name: 'INVOICE_DB_URL', transport: 'stdio' },
      { server: 'vendor-directory', name: 'VENDOR_DIRECTORY_TOKEN', transport: 'http' },
    ]);
  });
});
