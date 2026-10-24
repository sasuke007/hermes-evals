/**
 * The test-mcp-server handler with a fake sandbox, on PGlite: what each kind
 * of definition and outcome becomes, what a saved version records, and that
 * no secret value is kept, returned or logged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import type { PinoLogger } from 'nestjs-pino';
import { McpTestViewSchema, type McpServerInput, type McpTestView } from '@hermes-evals/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { mcpServerVersions } from '../../database/schema/index.js';
import { QUEUES } from '../../queue/queues.js';
import { McpServersService } from '../../resources/mcp/mcp-servers.service.js';
import {
  INVOICE_DB,
  insertWorker,
  useInConfiguration,
  VENDOR_API,
} from '../../resources/mcp/mcp-testing.support-spec.js';
import type { StdioTestInput, StdioTestRun } from './mcp-test-container.js';
import {
  handleTestMcpServerJob,
  HTTP_TEST_UNAVAILABLE,
  registerMcpTestHandler,
  tailOf,
  type McpTestDeps,
  type McpTestJob,
} from './test-mcp-server.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '__fixtures__', 'hermes-mcp-test', name), 'utf8');

const SECRET = 'file:///srv/secret-share/invoices.csv';
const REQUESTED = new Date('2026-10-24T09:00:00.000Z');
const FINISHED = new Date('2026-10-24T09:00:03.000Z');

/** Records every log call, so a test can prove no value reached the log. */
function recordingLogger() {
  const lines: unknown[][] = [];
  const record = (...args: unknown[]) => lines.push(args);
  const logger = { info: record, warn: record, error: record, debug: record };
  return { logger: logger as unknown as PinoLogger, lines };
}

/** A sandbox whose stdio test returns `run`, recording what it was given. */
function fakeSandbox(
  run: StdioTestRun | Error | ((input: StdioTestInput) => Promise<StdioTestRun>),
  isolated = true,
) {
  const calls: StdioTestInput[] = [];
  return {
    calls,
    sandbox: {
      isolated: () => isolated,
      runStdioTest: async (input: StdioTestInput) => {
        calls.push(input);
        if (run instanceof Error) throw run;
        return typeof run === 'function' ? run(input) : run;
      },
    },
  };
}

const passedRun: StdioTestRun = {
  exitCode: 0,
  stopReason: 'exited',
  durationMs: 2300,
  stdout: fixture('invoice-db-passed.stdout.txt'),
  stderr: '',
  serverLog: fixture('invoice-db-passed.mcp-stderr.log'),
};

const failedRun: StdioTestRun = {
  exitCode: 1,
  stopReason: 'exited',
  durationMs: 9900,
  stdout: fixture('invoice-db-missing-env.stdout.txt'),
  stderr: '',
  serverLog: `${fixture('invoice-db-missing-env.mcp-stderr.log')}2026-10-24 09:44:41,240 opened ${SECRET}\n`,
};

describe('test-mcp-server handler', () => {
  let t: TestDatabase;
  let servers: McpServersService;
  let log: ReturnType<typeof recordingLogger>;

  beforeEach(async () => {
    t = await createTestDatabase();
    servers = new McpServersService(t.db);
    log = recordingLogger();
  });

  afterEach(async () => {
    await t.close();
  });

  const deps = (
    sandbox: McpTestDeps['sandbox'],
    env: NodeJS.ProcessEnv = { INVOICE_DB_URL: SECRET },
  ): McpTestDeps => ({
    db: t.db,
    sandbox,
    env,
    now: () => FINISHED,
  });

  const unsaved = (definition: McpServerInput): McpTestJob => ({
    id: 'job-unsaved',
    data: { kind: 'unsaved', definition },
    createdOn: REQUESTED,
  });

  const versionRow = async (versionId: string) =>
    (await t.db.select().from(mcpServerVersions).where(eq(mcpServerVersions.id, versionId)))[0];

  /** A saved test as the API sends it: the version and the definition hash it read. */
  const saved = async (
    mcpServerVersionId: string,
    definitionHash?: string,
  ): Promise<McpTestJob> => ({
    id: 'job-saved',
    data: {
      kind: 'saved',
      mcpServerVersionId,
      definitionHash:
        definitionHash ?? (await versionRow(mcpServerVersionId))?.definitionHash ?? 'none',
    },
    createdOn: REQUESTED,
  });

  const lastTestOf = async (versionId: string) => (await versionRow(versionId))!.lastTest;

  /** Neither the view, the stored record nor the log may hold the value. */
  const expectNoValue = (...things: unknown[]) => {
    for (const thing of [...things, log.lines]) expect(JSON.stringify(thing)).not.toContain(SECRET);
  };

  describe('stdio', () => {
    it('passes with the tools Hermes listed, each marked by the filters, and records it', async () => {
      const { sandbox, calls } = fakeSandbox(passedRun);
      const row = await servers.create(INVOICE_DB);
      const view = await handleTestMcpServerJob(
        await saved(row.versionId),
        deps(sandbox),
        log.logger,
      );

      expect(McpTestViewSchema.parse(view)).toEqual({
        status: 'passed',
        requestedAt: REQUESTED.toISOString(),
        finishedAt: FINISHED.toISOString(),
        startedMs: 1171,
        tools: [
          expect.objectContaining({ name: 'list_invoices', included: true }),
          expect.objectContaining({ name: 'get_invoice', included: true }),
          expect.objectContaining({ name: 'update_invoice', included: true }),
          // INVOICE_DB excludes delete_*.
          expect.objectContaining({ name: 'delete_invoice', included: false }),
        ],
      });
      // The container gets the value; nothing else does.
      expect(calls).toHaveLength(1);
      expect(calls[0]!.values).toEqual({ INVOICE_DB_URL: SECRET });
      expect(calls[0]!.definition).toEqual(INVOICE_DB);
      expect(await lastTestOf(row.versionId)).toMatchObject({
        status: 'passed',
        job_id: 'job-saved',
        started_ms: 1171,
        tools: expect.arrayContaining([
          { name: 'get_invoice', description: 'Get one invoice by its number, e.g. INV-1002.' },
        ]),
      });
      expectNoValue(view, await lastTestOf(row.versionId));
    });

    it('records running while the container runs', async () => {
      const row = await servers.create(INVOICE_DB);
      let during: unknown;
      const { sandbox } = fakeSandbox(async () => {
        during = await lastTestOf(row.versionId);
        return passedRun;
      });
      await handleTestMcpServerJob(await saved(row.versionId), deps(sandbox), log.logger);
      expect(during).toEqual({
        status: 'running',
        job_id: 'job-saved',
        requested_at: REQUESTED.toISOString(),
      });
    });

    it('fails by name, with no container, when the worker lacks an env value (empty counts)', async () => {
      const { sandbox, calls } = fakeSandbox(passedRun);
      const definition = { ...INVOICE_DB, envNames: ['INVOICE_DB_URL', 'INVOICE_DB_TOKEN'] };
      const view = await handleTestMcpServerJob(
        unsaved(definition),
        deps(sandbox, { INVOICE_DB_TOKEN: '' }),
        log.logger,
      );
      expect(view).toMatchObject({
        status: 'failed',
        error: 'INVOICE_DB_URL and INVOICE_DB_TOKEN are not set in the worker environment.',
        missingSecretNames: ['INVOICE_DB_URL', 'INVOICE_DB_TOKEN'],
        exitCode: null,
      });
      expect(calls).toEqual([]);
    });

    it('refuses a stored version naming credentials or platform variables, before any container', async () => {
      // Saved before the API refused such names: the row is written directly.
      const row = await servers.create(INVOICE_DB);
      await t.db
        .update(mcpServerVersions)
        .set({ envNames: ['OPENROUTER_API_KEY', 'DATABASE_URL'] })
        .where(eq(mcpServerVersions.id, row.versionId));
      const { sandbox, calls } = fakeSandbox(passedRun);
      const env = { OPENROUTER_API_KEY: 'sk-or-v1-provider-key', DATABASE_URL: 'postgres://pw@db' };
      const view = await handleTestMcpServerJob(
        await saved(row.versionId),
        deps(sandbox, env),
        log.logger,
      );
      expect(view).toMatchObject({
        status: 'failed',
        error:
          'OPENROUTER_API_KEY and DATABASE_URL are platform variables or credentials; they never enter a trial.',
      });
      expect(calls).toEqual([]);
      const stored = JSON.stringify([view, await lastTestOf(row.versionId), log.lines]);
      expect(stored).not.toContain(env.OPENROUTER_API_KEY);
      expect(stored).not.toContain(env.DATABASE_URL);
    });

    it('refuses an env name an http server uses as a header variable', async () => {
      await servers.create(VENDOR_API);
      const row = await servers.create(INVOICE_DB);
      await t.db
        .update(mcpServerVersions)
        .set({ envNames: ['VENDOR_API_TOKEN'] })
        .where(eq(mcpServerVersions.id, row.versionId));
      const { sandbox, calls } = fakeSandbox(passedRun);
      const view = await handleTestMcpServerJob(
        await saved(row.versionId),
        deps(sandbox, { VENDOR_API_TOKEN: 'egress-only-value' }),
        log.logger,
      );
      expect(view).toMatchObject({
        status: 'failed',
        error:
          'VENDOR_API_TOKEN is the header variable of http server vendor-api; egress holds its value and it never enters a trial.',
      });
      expect(calls).toEqual([]);
    });

    it('runs nothing and records nothing for a definition rewritten after the test was asked for', async () => {
      const row = await servers.create(INVOICE_DB);
      const asked = await saved(row.versionId);
      await servers.update(row.id, { ...INVOICE_DB, timeoutS: 45 });
      const { sandbox, calls } = fakeSandbox(passedRun);
      const view = await handleTestMcpServerJob(asked, deps(sandbox), log.logger);
      expect(view).toMatchObject({
        status: 'failed',
        error:
          'The definition changed after this test was requested, so it was not run; test it again.',
      });
      expect(calls).toEqual([]);
      expect(await lastTestOf(row.versionId)).toEqual({ status: 'untested' });
    });

    it('leaves no 8-character piece of a value in a tail the 4000-character cut splits', async () => {
      const value = 'sk-test-7f3a9c1e5b2d8046-tail';
      const serverLog =
        `2026-10-24 09:44:32,790 token=${value}\n` +
        `2026-10-24 09:44:32,791 ${'x'.repeat(3990)}\n`;
      const { sandbox } = fakeSandbox({ ...failedRun, serverLog, stdout: '' });
      const view = await handleTestMcpServerJob(
        unsaved({ ...INVOICE_DB, envNames: ['INVOICE_DB_URL'] }),
        deps(sandbox, { INVOICE_DB_URL: value }),
        log.logger,
      );
      const tail = (view as Extract<McpTestView, { status: 'failed' }>).stderrTail;
      expect(tail.length).toBeLessThanOrEqual(4000);
      expectNoPiece(tail, value);
    });

    it('leaves no 8-character piece of a value in a description Hermes cut with "..."', async () => {
      const value = 'sk-test-9e8d7c6b5a4f3e2d1c0b';
      const description = `Reads with token ${value} as given`;
      // Hermes prints the first 55 characters and "...": the value is cut inside.
      const shown = `${description.slice(0, 40)}...`;
      const stdout = passedRun.stdout.replace(
        'Get one invoice by its number, e.g. INV-1002.',
        shown,
      );
      const { sandbox } = fakeSandbox({ ...passedRun, stdout });
      const view = await handleTestMcpServerJob(
        unsaved(INVOICE_DB),
        deps(sandbox, { INVOICE_DB_URL: value }),
        log.logger,
      );
      expect(view.status).toBe('passed');
      const tool = (view as Extract<McpTestView, { status: 'passed' }>).tools.find(
        (t) => t.name === 'get_invoice',
      )!;
      expect(tool.description).toBe('Reads with token <from env INVOICE_DB_URL>...');
      expectNoPiece(JSON.stringify(view), value);
    });

    it('starts no server on a worker that has not proven isolation', async () => {
      const { sandbox, calls } = fakeSandbox(passedRun, false);
      const view = await handleTestMcpServerJob(unsaved(INVOICE_DB), deps(sandbox), log.logger);
      expect(view).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/not proven trial isolation/),
      });
      expect(calls).toEqual([]);
    });

    it("fails with Hermes's reason, exit code and the server's stderr, values replaced", async () => {
      const { sandbox } = fakeSandbox(failedRun);
      const row = await servers.create(INVOICE_DB);
      const view = await handleTestMcpServerJob(
        await saved(row.versionId),
        deps(sandbox),
        log.logger,
      );
      expect(McpTestViewSchema.parse(view)).toMatchObject({
        status: 'failed',
        error: 'Exited with code 1 after 9.2 s · Connection closed',
        exitCode: 1,
        startedMs: null,
        missingSecretNames: [],
      });
      const tail = (view as Extract<McpTestView, { status: 'failed' }>).stderrTail;
      expect(tail).toContain('Error: INVOICE_DB_URL is not set');
      expect(tail).toContain('opened <from env INVOICE_DB_URL>');
      // Hermes's timestamps are dropped; the server's words remain.
      expect(tail.split('\n')[0]).toBe("===== starting MCP server 'invoice-db' =====");
      expect(await lastTestOf(row.versionId)).toMatchObject({ status: 'failed', exit_code: 1 });
      expectNoValue(view, await lastTestOf(row.versionId));
    });

    it('says why a container that was stopped did not finish', async () => {
      const cases: Array<[Partial<StdioTestRun>, RegExp]> = [
        [
          { stopReason: 'deadline', exitCode: 137, durationMs: 110_000 },
          /^Stopped after 110\.0 s · Hermes had not finished/,
        ],
        [{ stopReason: 'cancelled', exitCode: 137 }, /^Stopped: the worker shut down/],
        [{ stopReason: 'disk_limit', exitCode: 137 }, /^Stopped: the server wrote more to disk/],
        [
          { stopReason: 'output_limit', exitCode: 137 },
          /^Stopped: the server printed more output than a test may$/,
        ],
        [{ exitCode: 3, stdout: '' }, /^Exited with code 3 · Hermes did not find the server/],
        [
          { exitCode: 2, stdout: 'usage: hermes ...' },
          /^Exited with code 2 after 9\.9 s · no tools listed$/,
        ],
        [
          {
            exitCode: 0,
            stdout: passedRun.stdout.replace('Tools discovered: 4', 'Tools discovered: 9'),
          },
          /^Hermes connected and found 9 tools, but its tool list could not be read$/,
        ],
      ];
      for (const [over, error] of cases) {
        const { sandbox } = fakeSandbox({ ...failedRun, ...over });
        const view = await handleTestMcpServerJob(unsaved(INVOICE_DB), deps(sandbox), log.logger);
        expect(view, String(error)).toMatchObject({
          status: 'failed',
          error: expect.stringMatching(error),
        });
      }
    });

    it('turns a sandbox error into a failed result, value replaced', async () => {
      const { sandbox } = fakeSandbox(new Error(`docker-guard refused the create (env ${SECRET})`));
      const view = await handleTestMcpServerJob(unsaved(INVOICE_DB), deps(sandbox), log.logger);
      expect(view).toMatchObject({
        status: 'failed',
        error:
          'The test could not run: docker-guard refused the create (env <from env INVOICE_DB_URL>)',
      });
      expectNoValue(view);
    });

    it('records a frozen definition’s result too', async () => {
      const row = await servers.create(INVOICE_DB);
      await useInConfiguration(t.db, 'baseline', [row.versionId]);
      const { sandbox } = fakeSandbox(passedRun);
      await handleTestMcpServerJob(await saved(row.versionId), deps(sandbox), log.logger);
      expect(await lastTestOf(row.versionId)).toMatchObject({ status: 'passed' });
    });

    it('does not record a result about a definition that was edited during the test', async () => {
      const row = await servers.create(INVOICE_DB);
      const { sandbox } = fakeSandbox(async () => {
        await servers.update(row.id, { ...INVOICE_DB, timeoutS: 99 });
        return passedRun;
      });
      const view = await handleTestMcpServerJob(
        await saved(row.versionId),
        deps(sandbox),
        log.logger,
      );
      expect(view.status).toBe('passed');
      // The edit reset the test; the old definition's result does not overwrite that.
      expect(await lastTestOf(row.versionId)).toEqual({ status: 'untested' });
    });
  });

  describe('http', () => {
    it('fails until the egress gateway exists, naming what egress lacks', async () => {
      await insertWorker(t.db, { egress: ['OTHER_TOKEN'] });
      const { sandbox, calls } = fakeSandbox(passedRun);
      const row = await servers.create({
        ...VENDOR_API,
        headers: [
          { header: 'Authorization', env: 'VENDOR_API_TOKEN' },
          { header: 'X-Other', env: 'OTHER_TOKEN' },
        ],
      });
      const view = await handleTestMcpServerJob(
        await saved(row.versionId),
        deps(sandbox),
        log.logger,
      );
      expect(McpTestViewSchema.parse(view)).toMatchObject({
        status: 'failed',
        error: HTTP_TEST_UNAVAILABLE,
        missingSecretNames: ['VENDOR_API_TOKEN'],
      });
      expect(calls).toEqual([]);
      expect(await lastTestOf(row.versionId)).toMatchObject({
        status: 'failed',
        error: HTTP_TEST_UNAVAILABLE,
      });
    });

    it('refuses a stored version that sends a provider key as a header', async () => {
      const row = await servers.create(VENDOR_API);
      await t.db
        .update(mcpServerVersions)
        .set({ headers: [{ header: 'Authorization', env: 'OPENROUTER_API_KEY' }] })
        .where(eq(mcpServerVersions.id, row.versionId));
      const { sandbox } = fakeSandbox(passedRun);
      const view = await handleTestMcpServerJob(
        await saved(row.versionId),
        deps(sandbox),
        log.logger,
      );
      expect(view).toMatchObject({
        status: 'failed',
        error: 'OPENROUTER_API_KEY is a platform variable or credential; it never enters a trial.',
      });
    });

    it('names every header variable when no worker reports egress', async () => {
      const { sandbox } = fakeSandbox(passedRun);
      const view = await handleTestMcpServerJob(unsaved(VENDOR_API), deps(sandbox), log.logger);
      expect(view).toMatchObject({ missingSecretNames: ['VENDOR_API_TOKEN'] });
    });
  });

  it('answers a version that no longer exists, or a definition that is not valid, with a failed result', async () => {
    const { sandbox } = fakeSandbox(passedRun);
    expect(
      await handleTestMcpServerJob(await saved('mcpv_gone'), deps(sandbox), log.logger),
    ).toMatchObject({
      status: 'failed',
      error: 'MCP server version mcpv_gone no longer exists.',
    });
    const invalid = { ...INVOICE_DB, command: null };
    expect(await handleTestMcpServerJob(unsaved(invalid), deps(sandbox), log.logger)).toMatchObject(
      {
        status: 'failed',
        error: 'The definition sent for testing is not valid.',
      },
    );
  });

  it('registers one job per call, two at a time, and returns the view as the job output', async () => {
    let registered: {
      name: string;
      options: unknown;
      handler: (jobs: McpTestJob[]) => Promise<unknown>;
    } | null = null;
    const boss = {
      work: async (
        name: string,
        options: unknown,
        handler: (jobs: McpTestJob[]) => Promise<unknown>,
      ) => {
        registered = { name, options, handler };
        return 'worker-1';
      },
    } as unknown as PgBoss;
    const { sandbox } = fakeSandbox(passedRun);
    expect(await registerMcpTestHandler(boss, deps(sandbox), log.logger)).toBe('worker-1');
    expect(registered!.name).toBe(QUEUES.testMcpServer);
    expect(registered!.options).toEqual({
      batchSize: 1,
      localConcurrency: 2,
      includeMetadata: true,
    });
    const output = await registered!.handler([unsaved(INVOICE_DB)]);
    expect(McpTestViewSchema.parse(output)).toMatchObject({ status: 'passed' });
  });
});

/** No piece of `value` 8 characters or longer survives in `text`. */
function expectNoPiece(text: string, value: string): void {
  for (let i = 0; i + 8 <= value.length; i++) {
    expect(text, `piece ${i}`).not.toContain(value.slice(i, i + 8));
  }
}

describe('tailOf', () => {
  it('keeps the last 40 non-blank lines, the server log first', () => {
    const log = Array.from({ length: 50 }, (_, i) => `2026-10-24 09:44:32,790 line ${i}`).join(
      '\n',
    );
    const tail = tailOf(log, 'hermes said\n\n').split('\n');
    expect(tail).toHaveLength(40);
    expect(tail[0]).toBe('line 11');
    expect(tail.at(-1)).toBe('hermes said');
  });
});
