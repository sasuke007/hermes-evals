/**
 * The Phase 1 definition columns (migration 0002): loader-assigned version
 * numbers, where a task version was introduced, http MCP headers as names
 * only, where a configuration version was duplicated from, and what a worker
 * reports about its sandbox.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpHeader } from '@hermes-evals/shared';
import {
  createTestDatabase,
  rejection,
  SQLSTATE,
  type TestDatabase,
} from '../../test/support/database.js';
import { HERMES_REVISION, seedExperiment, sha } from '../../test/support/seed.js';
import {
  configurationVersions,
  configurations,
  mcpServerVersions,
  mcpServers,
  suites,
  tasks,
  workers,
} from './schema/index.js';
import { WorkerSandboxSchema, type WorkerSandbox } from './schema/worker-sandbox.js';

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
});

afterEach(async () => {
  await t.close();
});

const suiteVersion = (sourcePath: string, versionNumber: number, content = `v${versionNumber}`) =>
  t.db
    .insert(suites)
    .values({
      sourcePath,
      versionNumber,
      name: sourcePath,
      versionLabel: '0.1',
      contentHash: sha(`${sourcePath} ${content}`),
      checkHash: sha('checks'),
      taskCount: 1,
      validCount: 0,
    })
    .returning({ id: suites.id });

const invalidTask = (suiteId: string, introducedInSuiteId: string, versionNumber = 1) =>
  t.db.insert(tasks).values({
    suiteId,
    key: 'total_due',
    versionNumber,
    introducedInSuiteId,
    position: 0,
    selfCheck: { status: 'skipped', ran_at: null, duration_ms: null, results: [] },
    valid: false,
    invalidReason: 'reference.json is missing',
    contentHash: sha('total_due'),
    taskYaml: 'summary: Total due\n',
  });

/** Inserts MCP server `name` with version 1 and returns the version id. */
async function mcpVersion(
  name: string,
  definition: Partial<typeof mcpServerVersions.$inferInsert>,
): Promise<string> {
  return t.db.transaction(async (tx) => {
    const [server] = await tx.insert(mcpServers).values({ name }).returning();
    const [version] = await tx
      .insert(mcpServerVersions)
      .values({
        mcpServerId: server!.id,
        version: 1,
        transport: 'http',
        url: 'https://mcp.example.com/',
        definitionHash: sha(name),
        ...definition,
      })
      .returning();
    return version!.id;
  });
}

const AUTH: McpHeader = { header: 'Authorization', env: 'VENDOR_API_TOKEN' };

describe('suite and task versions', () => {
  it('number suite versions once per directory', async () => {
    await suiteVersion('invoices-v1', 1);
    await suiteVersion('invoices-v1', 2);
    await suiteVersion('receipts', 1);
    // Two loads of different content racing for the same next number.
    const taken = await rejection(suiteVersion('invoices-v1', 2, 'other files'));
    expect(taken.code).toBe(SQLSTATE.uniqueViolation);
    expect(taken.message).toMatch(/suites_source_version_uq/);
    const zero = await rejection(suiteVersion('receipts', 0));
    expect(zero.message).toMatch(/suites_version_number_ck/);
  });

  it('point a task version at the suite version that introduced it', async () => {
    const [v1] = await suiteVersion('invoices-v1', 1);
    const [v2] = await suiteVersion('invoices-v1', 2);
    // Carried over unchanged into v2: introduced by v1.
    await invalidTask(v2!.id, v1!.id);
    const [stored] = await t.db.select().from(tasks).where(eq(tasks.suiteId, v2!.id));
    expect(stored).toMatchObject({
      versionNumber: 1,
      introducedInSuiteId: v1!.id,
      taskYaml: 'summary: Total due\n',
    });

    const [v3] = await suiteVersion('invoices-v1', 3);
    const unknown = await rejection(invalidTask(v3!.id, '01NOSUCHSUITE0000000000000'));
    expect(unknown.code).toBe(SQLSTATE.foreignKeyViolation);
    expect(unknown.message).toMatch(/tasks_introduced_in_suite_fk/);
    const zero = await rejection(invalidTask(v3!.id, v3!.id, 0));
    expect(zero.message).toMatch(/tasks_version_number_ck/);
  });
});

describe('MCP headers', () => {
  it('store http headers as header and variable name pairs', async () => {
    const id = await mcpVersion('vendor', { headers: [AUTH, { header: 'X-Org', env: 'ORG_ID' }] });
    const [stored] = await t.db
      .select()
      .from(mcpServerVersions)
      .where(eq(mcpServerVersions.id, id));
    expect(stored!.headers).toEqual([AUTH, { header: 'X-Org', env: 'ORG_ID' }]);
    // A stdio server defaults to no headers.
    const stdio = await mcpVersion('invoice-db', {
      transport: 'stdio',
      url: null,
      command: 'python3',
      envNames: ['INVOICE_DB_PATH'],
    });
    const [plain] = await t.db
      .select({ headers: mcpServerVersions.headers })
      .from(mcpServerVersions)
      .where(eq(mcpServerVersions.id, stdio));
    expect(plain!.headers).toEqual([]);
  });

  it('give headers to http servers only, and env names and args to stdio only', async () => {
    const stdioWithHeaders = await rejection(
      mcpVersion('a', { transport: 'stdio', url: null, command: 'python3', headers: [AUTH] }),
    );
    expect(stdioWithHeaders.message).toMatch(/mcp_server_versions_shape_ck/);
    const httpWithEnv = await rejection(mcpVersion('b', { envNames: ['VENDOR_API_TOKEN'] }));
    expect(httpWithEnv.message).toMatch(/mcp_server_versions_shape_ck/);
    const httpWithArgs = await rejection(mcpVersion('c', { args: ['--verbose'] }));
    expect(httpWithArgs.message).toMatch(/mcp_server_versions_shape_ck/);
  });

  it('refuse headers that are not a list of name pairs, so no value can be stored', async () => {
    const bad: unknown[] = [
      { header: 'Authorization' },
      { env: 'VENDOR_API_TOKEN' },
      { header: 'Authorization', env: 'Bearer sk-live-123' },
      { header: 'Bad Header', env: 'VENDOR_API_TOKEN' },
      { header: 'Authorization', env: 42 },
      'Authorization',
    ];
    for (const entry of bad) {
      const error = await rejection(mcpVersion('vendor', { headers: [entry] as McpHeader[] }));
      expect(error.message, JSON.stringify(entry)).toMatch(/mcp_server_versions_headers_ck/);
    }
    const notArray = await rejection(
      mcpVersion('vendor', {
        headers: { Authorization: 'VENDOR_API_TOKEN' } as unknown as McpHeader[],
      }),
    );
    expect(notArray.message).toMatch(/mcp_server_versions_headers_ck/);
  });

  it('freeze headers with the rest of a definition a configuration uses', async () => {
    const id = await mcpVersion('vendor', { headers: [AUTH] });
    const seed = await seedExperiment(t.db);
    await t.db.transaction(async (tx) => {
      const [configuration] = await tx
        .insert(configurations)
        .values({ name: 'with-mcp' })
        .returning();
      await tx.insert(configurationVersions).values({
        configurationId: configuration!.id,
        version: 1,
        model: 'openai/gpt-6.1-sol',
        provider: 'nous',
        maxTurns: 20,
        timeBudgetS: 300,
        configHash: sha('with-mcp'),
        mcpServerVersionIds: [id],
        duplicatedFromVersionId: seed.baselineVersionId,
      });
    });
    const edit = await rejection(
      t.db
        .update(mcpServerVersions)
        .set({ headers: [{ ...AUTH, env: 'OTHER_TOKEN' }] })
        .where(eq(mcpServerVersions.id, id)),
    );
    expect(edit.code).toBe(SQLSTATE.restrictViolation);
  });
});

describe('configuration versions', () => {
  it('record the version they were duplicated from, which must exist', async () => {
    const seed = await seedExperiment(t.db);
    const draft = (name: string, duplicatedFromVersionId: string) =>
      t.db.transaction(async (tx) => {
        const [configuration] = await tx.insert(configurations).values({ name }).returning();
        const [version] = await tx
          .insert(configurationVersions)
          .values({
            configurationId: configuration!.id,
            version: 1,
            model: 'openai/gpt-6.1-sol',
            provider: 'nous',
            maxTurns: 20,
            timeBudgetS: 300,
            configHash: sha(name),
            duplicatedFromVersionId,
          })
          .returning();
        return version!;
      });
    const copy = await draft('baseline-copy', seed.baselineVersionId);
    expect(copy.duplicatedFromVersionId).toBe(seed.baselineVersionId);
    const missing = await rejection(draft('ghost-copy', '01NOSUCHVERSION00000000000'));
    expect(missing.code).toBe(SQLSTATE.foreignKeyViolation);
    expect(missing.message).toMatch(/configuration_versions_duplicated_from_fk/);
  });
});

describe('workers', () => {
  const sandbox: WorkerSandbox = {
    state: 'isolated',
    checks: [
      { id: 'no-default-route', name: 'has no default route', passed: true, detail: 'no route' },
    ],
    checked_at: '2026-10-24T09:00:00.000Z',
    image: 'hermes-evals/trial:v0.22.4-4d04303',
    revision: HERMES_REVISION,
    trigger: 'worker start',
  };
  const worker = (overrides: Partial<typeof workers.$inferInsert> = {}) =>
    t.db
      .insert(workers)
      .values({
        hostname: 'worker-1',
        concurrency: 3,
        hermesVersion: '0.22.4',
        hermesRevision: HERMES_REVISION,
        ...overrides,
      })
      .returning();

  it('store egress variable names and the last self-test', async () => {
    const [plain] = await worker();
    expect(plain).toMatchObject({ egressEnvNames: [], sandbox: null });
    const [reported] = await worker({ egressEnvNames: ['VENDOR_API_TOKEN'], sandbox });
    expect(reported!.egressEnvNames).toEqual(['VENDOR_API_TOKEN']);
    expect(WorkerSandboxSchema.parse(reported!.sandbox)).toEqual(sandbox);
  });

  it('refuse a self-test without a known state', async () => {
    const unknown = await rejection(
      worker({ sandbox: { ...sandbox, state: 'proven' as WorkerSandbox['state'] } }),
    );
    expect(unknown.message).toMatch(/workers_sandbox_ck/);
    const notObject = await rejection(worker({ sandbox: 'isolated' as unknown as WorkerSandbox }));
    expect(notObject.message).toMatch(/workers_sandbox_ck/);
  });
});
