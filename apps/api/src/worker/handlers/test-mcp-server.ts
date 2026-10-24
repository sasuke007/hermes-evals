/**
 * The test-mcp-server job (plan 5.3, UI_FLOWS 9.3): start one MCP server the
 * way a run would and list its tools. The job's output is the McpTestView the
 * API returns; a saved version also records the result on its last_test.
 *
 * - Reserved names (isReservedEnvName: provider keys, DATABASE_URL, the
 *   worker's and the platform's own variables) are refused before anything
 *   else, as env names and as header variables, so a definition stored
 *   before the API refused them still never gets one into a container. A
 *   stdio env name that an http server uses as a header variable is refused
 *   too: egress holds that value, and it must never reach a trial.
 * - stdio: env names the worker lacks (an empty value counts as missing) fail
 *   the test at once, by name, with no container. Otherwise the server runs
 *   under `hermes mcp test` in a throwaway trial container that has the values
 *   in its environment, exactly as a run's container would. Phase 2 trial
 *   setup applies the same refusals (refusedEnvNames).
 * - http: needs the egress MCP gateway (Phase 2). Until then the test fails
 *   saying so, and names the header variables egress reported missing.
 *
 * Values never leave this process: they go into the container's environment
 * only, and every text kept from the test has them replaced by
 * `<from env NAME>`, before any text is cut. Logs carry names, never values.
 */
import { and, eq } from 'drizzle-orm';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import type { PinoLogger } from 'nestjs-pino';
import {
  isReservedEnvName,
  McpServerInputSchema,
  reservedEnvNameMessage,
  type McpServerInput,
  type McpTestView,
} from '@hermes-evals/shared';
import { mcpServers, mcpServerVersions } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { findLiveWorker } from '../../queue/live-worker.js';
import { QUEUES, type TestMcpServerJob } from '../../queue/queues.js';
import { definitionOf } from '../../resources/mcp/definition.js';
import { headerVariableUses } from '../../resources/mcp/mcp-reads.js';
import type { FinishedMcpTestRecord, McpTestRecord } from '../../resources/mcp/test-record.js';
import { toMcpTestView } from '../../resources/mcp/views.js';
import type { SandboxService } from '../../sandbox/sandbox.service.js';
import { runStdioMcpTest, type StdioTestInput, type StdioTestRun } from './mcp-test-container.js';
import { parseMcpTestOutput } from './mcp-test-output.js';
import { redactTruncated, redactValues } from './redact.js';

/** The failure an http test reports until the egress MCP gateway exists. */
export const HTTP_TEST_UNAVAILABLE =
  'Testing http servers needs the egress MCP gateway, which is built in Phase 2.';

/** What a test needs from the worker's sandbox. */
export interface McpTestSandbox {
  /** A test runs the user's server command, so like a run it needs proven isolation. */
  isolated(): boolean;
  runStdioTest(input: StdioTestInput): Promise<StdioTestRun>;
}

/** The worker's SandboxService as an McpTestSandbox. */
export function mcpTestSandbox(sandbox: SandboxService): McpTestSandbox {
  return {
    isolated: () => sandbox.status().state === 'isolated',
    runStdioTest: (input) => runStdioMcpTest(sandbox, input),
  };
}

export interface McpTestDeps {
  db: AppDb;
  sandbox: McpTestSandbox;
  /** Where stdio env values come from. Default: the worker's own process.env. */
  env?: NodeJS.ProcessEnv;
  /**
   * How long the test container may run. The default, 110 s, covers Hermes's
   * three connection attempts and stays inside the API's default 120 s wait
   * (MCP_TEST_TIMEOUT_S) and the job's 300 s expiry.
   */
  containerTimeoutMs?: number;
  now?: () => Date;
}

export const DEFAULT_MCP_TEST_CONTAINER_TIMEOUT_MS = 110_000;
const TAIL_LINES = 40;
const TAIL_CHARS = 4000;

/** The fields of a job the handler reads. */
export type McpTestJob = Pick<JobWithMetadata<TestMcpServerJob>, 'id' | 'data' | 'createdOn'> & {
  signal?: AbortSignal;
};

/**
 * Starts consuming test-mcp-server jobs, one job per call and two at a time
 * (each is one short-lived container). Returns the pg-boss worker id.
 */
export function registerMcpTestHandler(
  boss: PgBoss,
  deps: McpTestDeps,
  logger: PinoLogger,
): Promise<string> {
  const options = { batchSize: 1, localConcurrency: 2, includeMetadata: true } as const;
  return boss.work<TestMcpServerJob, McpTestView | null, typeof options>(
    QUEUES.testMcpServer,
    options,
    async ([job]) => (job ? handleTestMcpServerJob(job, deps, logger) : null),
  );
}

/** One job: the view to return, after recording it on a saved version. Never throws for a failed test. */
export async function handleTestMcpServerJob(
  job: McpTestJob,
  deps: McpTestDeps,
  logger: PinoLogger,
): Promise<McpTestView> {
  const now = deps.now ?? (() => new Date());
  const requestedAt = job.createdOn.toISOString();
  const failed = (error: string): FinishedMcpTestRecord => ({
    status: 'failed',
    job_id: job.id,
    requested_at: requestedAt,
    finished_at: now().toISOString(),
    error,
    exit_code: null,
    missing_secret_names: [],
  });

  if (job.data.kind === 'unsaved') {
    const parsed = McpServerInputSchema.safeParse(job.data.definition);
    if (!parsed.success) {
      return toMcpTestView(failed('The definition sent for testing is not valid.'), NO_FILTERS);
    }
    const record = await testDefinition(parsed.data, job, deps, logger);
    return toMcpTestView(record, parsed.data);
  }

  const versionId = job.data.mcpServerVersionId;
  const [stored] = await deps.db
    .select({ name: mcpServers.name, version: mcpServerVersions })
    .from(mcpServerVersions)
    .innerJoin(mcpServers, eq(mcpServers.id, mcpServerVersions.mcpServerId))
    .where(eq(mcpServerVersions.id, versionId));
  if (!stored)
    return toMcpTestView(failed(`MCP server version ${versionId} no longer exists.`), NO_FILTERS);
  const definition = definitionOf(stored.name, stored.version);
  const hash = stored.version.definitionHash;
  if (hash !== job.data.definitionHash) {
    // Rewritten in place after the test was asked for: this job is about a
    // definition that no longer exists. The newer one has its own job (key).
    return toMcpTestView(
      failed(
        'The definition changed after this test was requested, so it was not run; test it again.',
      ),
      definition,
    );
  }

  await recordTest(deps.db, versionId, hash, {
    status: 'running',
    job_id: job.id,
    requested_at: requestedAt,
  });
  const record = await testDefinition(definition, job, deps, logger);
  if (!(await recordTest(deps.db, versionId, hash, record))) {
    // An in-place edit replaced the definition meanwhile; this result is about the old one.
    logger.info(
      { mcpServer: definition.name, versionId },
      'definition changed during its test; result not recorded',
    );
  }
  return toMcpTestView(record, definition);
}

const NO_FILTERS = { include: [], exclude: [] };

/**
 * Writes last_test, only while the version still holds the definition that
 * was tested. A frozen definition may still record its results (the guard
 * trigger exempts last_test). Returns whether the row was written.
 */
async function recordTest(
  db: AppDb,
  versionId: string,
  definitionHash: string,
  record: McpTestRecord,
): Promise<boolean> {
  const written = await db
    .update(mcpServerVersions)
    .set({ lastTest: record })
    .where(
      and(
        eq(mcpServerVersions.id, versionId),
        eq(mcpServerVersions.definitionHash, definitionHash),
      ),
    )
    .returning({ id: mcpServerVersions.id });
  return written.length > 0;
}

/** Tests one definition and returns the finished record. Every failure is a result, not a throw. */
export async function testDefinition(
  definition: McpServerInput,
  job: McpTestJob,
  deps: McpTestDeps,
  logger: PinoLogger,
): Promise<FinishedMcpTestRecord> {
  const now = deps.now ?? (() => new Date());
  const base = { job_id: job.id, requested_at: job.createdOn.toISOString() };
  const failed = (
    error: string,
    extra: Partial<Extract<FinishedMcpTestRecord, { status: 'failed' }>> = {},
  ): FinishedMcpTestRecord => ({
    status: 'failed',
    ...base,
    finished_at: now().toISOString(),
    error,
    exit_code: null,
    missing_secret_names: [],
    ...extra,
  });

  const refusal = await refusedEnvNames(deps.db, definition);
  if (refusal) return failed(refusal);

  if (definition.transport === 'http') {
    const worker = await findLiveWorker(deps.db);
    const egress = new Set(worker?.egressEnvNames ?? []);
    const missing = unique(definition.headers.map((h) => h.env)).filter(
      (name) => !egress.has(name),
    );
    return failed(HTTP_TEST_UNAVAILABLE, { missing_secret_names: missing });
  }

  const env = deps.env ?? process.env;
  const missing = definition.envNames.filter((name) => !env[name]);
  if (missing.length > 0) {
    return failed(
      `${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} not set in the worker environment.`,
      { missing_secret_names: missing },
    );
  }
  if (!deps.sandbox.isolated()) {
    return failed(
      'This worker has not proven trial isolation, so it starts no MCP server; see System for the self-test.',
    );
  }

  const values = Object.fromEntries(definition.envNames.map((name) => [name, env[name]!]));
  try {
    const run = await deps.sandbox.runStdioTest({
      definition,
      values,
      timeoutMs: deps.containerTimeoutMs ?? DEFAULT_MCP_TEST_CONTAINER_TIMEOUT_MS,
      signal: job.signal,
    });
    const record = interpretRun(run, values, failed, () => ({
      status: 'passed' as const,
      ...base,
      finished_at: now().toISOString(),
    }));
    logger.info(
      {
        mcpServer: definition.name,
        status: record.status,
        exitCode: run.exitCode,
        stopReason: run.stopReason,
      },
      'MCP server test finished',
    );
    return record;
  } catch (err) {
    const message = redactValues(err instanceof Error ? err.message : String(err), values);
    logger.error({ mcpServer: definition.name, error: message }, 'MCP server test could not run');
    return failed(`The test could not run: ${message}`);
  }
}

/**
 * Why a definition may not start at all, or null: it names a reserved
 * variable (as an env name or a header variable), or a stdio env name that
 * an http server uses as a header variable. The same check gates Phase 2
 * trial setup, so stored versions saved before the API refused these names
 * are refused too.
 */
export async function refusedEnvNames(
  db: AppDb,
  definition: McpServerInput,
): Promise<string | null> {
  const names =
    definition.transport === 'stdio'
      ? definition.envNames
      : unique(definition.headers.map((h) => h.env));
  const reserved = names.filter(isReservedEnvName);
  if (reserved.length > 0) return `${reservedEnvNameMessage(reserved)}.`;
  if (definition.transport !== 'stdio' || names.length === 0) return null;
  const uses = await headerVariableUses(db, names);
  const first = uses[0];
  if (!first) return null;
  return (
    `${first.env} is the header variable of http server ${first.server}; egress holds its value ` +
    'and it never enters a trial.'
  );
}

type Failed = (
  error: string,
  extra?: Partial<Extract<FinishedMcpTestRecord, { status: 'failed' }>>,
) => FinishedMcpTestRecord;

/** Reads the container's outcome and Hermes's output into a result. */
export function interpretRun(
  run: StdioTestRun,
  values: Readonly<Record<string, string>>,
  failed: Failed,
  passed: () => { status: 'passed'; job_id: string; requested_at: string; finished_at: string },
): FinishedMcpTestRecord {
  const parsed = parseMcpTestOutput(run.stdout);
  // Redacted before the tail is cut: a value the cut splits would otherwise
  // leave a piece that no longer matches.
  const stderrTail = tailOf(redactValues(run.serverLog, values), redactValues(run.stderr, values));
  const startedMs = parsed.connectedMs ?? undefined;
  const after = (seconds: number) => `${seconds.toFixed(1)} s`;
  const ranFor = after(run.durationMs / 1000);
  const extra = {
    stderr_tail: stderrTail,
    ...(startedMs !== undefined ? { started_ms: startedMs } : {}),
  };

  switch (run.stopReason) {
    case 'deadline':
      return failed(`Stopped after ${ranFor} · Hermes had not finished testing the server`, extra);
    case 'cancelled':
      return failed('Stopped: the worker shut down or the test was cancelled', extra);
    case 'disk_limit':
      return failed('Stopped: the server wrote more to disk than a trial may', extra);
    case 'output_limit':
      return failed('Stopped: the server printed more output than a test may', extra);
    case 'exited':
      break;
  }
  if (run.exitCode === 0 && parsed.tools) {
    return {
      ...passed(),
      started_ms: parsed.connectedMs ?? run.durationMs,
      // Tool names stay as they are: they are protocol identifiers that
      // include and exclude filters match on. Hermes cuts descriptions at 55
      // characters and "...", which can leave the start of a value.
      tools: parsed.tools.map((tool) => ({
        name: tool.name,
        ...(tool.description ? { description: redactTruncated(tool.description, values) } : {}),
      })),
    };
  }
  const exit = { ...extra, exit_code: run.exitCode };
  if (run.exitCode === 0) {
    const found = parsed.discovered === null ? '' : ` and found ${parsed.discovered} tools`;
    return failed(`Hermes connected${found}, but its tool list could not be read`, exit);
  }
  if (run.exitCode === 3) {
    return failed('Exited with code 3 · Hermes did not find the server in its config', exit);
  }
  if (parsed.failure) {
    const reason = redactValues(parsed.failure.reason, values);
    return failed(
      `Exited with code ${run.exitCode} after ${after(parsed.failure.elapsedS)} · ${reason}`,
      exit,
    );
  }
  return failed(`Exited with code ${run.exitCode} after ${ranFor} · no tools listed`, exit);
}

/** Hermes stamps each server stderr line with its own time; the tail shows the server's words. */
const HERMES_STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} /;

/** The last lines of the server's stderr, then Hermes's own, without blank lines. */
export function tailOf(serverLog: string, hermesStderr: string): string {
  const lines = [
    ...serverLog.split(/\r?\n/).map((line) => line.replace(HERMES_STAMP, '')),
    ...hermesStderr.split(/\r?\n/),
  ].filter((line) => line.trim() !== '');
  return lines.slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS);
}

const unique = (values: readonly string[]): string[] => [...new Set(values)];

const listOf = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
