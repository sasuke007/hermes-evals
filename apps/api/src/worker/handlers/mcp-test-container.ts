/**
 * Runs `hermes mcp test <name>` for one MCP definition in a throwaway trial
 * container (plan 5.3): the hardened trial spec through docker-guard, a fresh
 * directory in the trials volume, and a config.yaml with only this server,
 * built the way a run's is (hermesMcpEntry). The container and its directory
 * are always removed.
 *
 * stdio: the container gets the server's env values in its environment,
 * exactly as a run would; config.yaml holds only `${NAME}` references. It has
 * no network at all (`none`): Hermes starts stdio servers without the proxy
 * variables, so a server has no route out in a run either.
 *
 * http: the server is reached the way a run reaches it, through the egress
 * MCP gateway. The container joins a free slot network, where only egress
 * answers; config.yaml points the server at `http://egress:8080/mcp/<name>`
 * with `Authorization: Bearer ${HERMES_EVALS_ATTEMPT_TOKEN}`, and the
 * container environment carries a fresh token. A short-lived egress
 * registration (allowlist mode, no model) holds the one route, and egress
 * adds the definition's header values from its own environment, so no value
 * reaches the container. The registration is removed when the container is
 * gone, and its connection log becomes part of the result's tail.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { McpServerInput } from '@hermes-evals/shared';
import { newId } from '../../database/ids.js';
import { ATTEMPT_TOKEN_ENV } from '../../execution/providers-map.js';
import { hermesMcpEntry } from '../../resources/mcp/hermes-config.js';
import {
  newAttemptToken,
  type EgressClient,
  type EgressLogEntry,
} from '../../sandbox/egress-client.js';
import type { EngineClient } from '../../sandbox/engine-client.js';
import { DEFAULT_DISK_LIMIT, readTrialFile } from '../../sandbox/trial-files.js';
import { ByteTail } from '../../sandbox/streams.js';
import {
  freeSlot,
  prepareTrialDirs,
  removeTrialDirs,
  runTrial,
  type TrialOutcome,
} from '../../sandbox/trial-runner.js';
import { TRIAL_HOME, type TrialLimits } from '../../sandbox/trial-spec.js';
import { redactValues } from './redact.js';

/** What the worker's sandbox gives a stdio test: SandboxService has all of these. */
export interface McpTestSandboxParts {
  engine: EngineClient;
  trialsDir: string;
  image: string;
  volume: string;
}

/** A slot network held for one container; `release` hands it back once the container is gone. */
export interface SlotLease {
  slot: string;
  release: () => void;
}

/** What an http test needs besides: egress, and a free slot network (E9). */
export interface McpHttpTestParts extends McpTestSandboxParts {
  egress: Pick<EgressClient, 'register' | 'remove'>;
  acquireSlot: () => Promise<SlotLease>;
}

export interface StdioTestInput {
  definition: McpServerInput;
  /** NAME=value for each of the definition's env names, from the worker's environment. */
  values: Readonly<Record<string, string>>;
  /** Stop the container after this long. */
  timeoutMs: number;
  /** Stop it once stdout and stderr pass this many bytes. Default MCP_TEST_OUTPUT_LIMIT_BYTES. */
  outputLimitBytes?: number;
  signal?: AbortSignal;
}

/** An http test has no values: egress holds them. */
export type HttpTestInput = Omit<StdioTestInput, 'values'>;

export interface McpTestRun {
  exitCode: number;
  stopReason: TrialOutcome['stopReason'];
  durationMs: number;
  stdout: string;
  /** The last STDERR_TAIL_BYTES of Hermes's own stderr. */
  stderr: string;
  /** home/logs/mcp-stderr.log, where Hermes copies a stdio server's stderr; '' when absent. */
  serverLog: string;
  /** http: one line per call the MCP gateway logged, for the result's tail. Never a value. */
  gatewayLog?: string[];
}

/** The name Phase 1 gave McpTestRun, when only stdio servers could be tested. */
export type StdioTestRun = McpTestRun;

/** Smaller than a run's: one Hermes process and one server, no agent. */
const MCP_TEST_LIMITS: TrialLimits = { memoryMiB: 1024, cpus: 1, pids: 512, tmpMiB: 256 };
/** The server log is read for its tail only; a server that writes more is cut off. */
const MAX_SERVER_LOG_BYTES = 4 * 1024 * 1024;
/**
 * Output caps. `hermes mcp test` prints a few lines per tool, so a few MiB is
 * far more than a real test needs; the server is arbitrary code that can
 * write to Hermes's streams, and the container is stopped past the cap
 * (stopReason output_limit). Under the cap, stdout keeps its first lines (the
 * tool list) and stderr its last bytes (the tail the result shows).
 */
export const MCP_TEST_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;
const MAX_STDOUT_LINES = 5000;
const STDERR_TAIL_BYTES = 64 * 1024;
/** Gateway calls kept for the tail: a test makes a handful (probe, initialize, list, close). */
const MAX_GATEWAY_LINES = 20;
/** How long past the container's timeout the test's egress token stays valid, if removal fails. */
const TOKEN_GRACE_MS = 60_000;

/**
 * config.yaml for the test: only this server, and nothing that phones home.
 * An http server's entry carries the gateway's Authorization header as a
 * `${HERMES_EVALS_ATTEMPT_TOKEN}` reference (hermesMcpEntry), as a run's does.
 */
export function mcpTestConfig(definition: McpServerInput): Record<string, unknown> {
  return {
    mcp_servers: { [definition.name]: hermesMcpEntry(definition) },
    updates: { check: false },
    plugins: { auto_update_check_hours: 0 },
    security: { allow_lazy_installs: false },
  };
}

/** The default slot source: the first slot network with no live trial (sandbox/trial-runner.ts). */
export function freeSlotSource(engine: EngineClient, slots: string[]): () => Promise<SlotLease> {
  return async () => ({ slot: await freeSlot(engine, slots), release: () => {} });
}

export async function runStdioMcpTest(
  sandbox: McpTestSandboxParts,
  input: StdioTestInput,
): Promise<McpTestRun> {
  const { definition } = input;
  if (definition.transport !== 'stdio') throw new Error('runStdioMcpTest takes a stdio definition');
  return withProbeDirs(sandbox, definition, (probe) =>
    // The values first, so a platform variable can never be replaced (the
    // handler refuses every reserved name, isReservedEnvName, before it gets here).
    runProbe(sandbox, probe, { ...input, network: 'none', env: { ...input.values } }),
  );
}

export async function runHttpMcpTest(
  sandbox: McpHttpTestParts,
  input: HttpTestInput,
): Promise<McpTestRun> {
  const { definition } = input;
  if (definition.transport !== 'http' || definition.url === null) {
    throw new Error('runHttpMcpTest takes an http definition');
  }
  const url = definition.url;
  const token = newAttemptToken();
  const run = await withProbeDirs(sandbox, definition, async (probe) => {
    const lease = await sandbox.acquireSlot();
    try {
      await sandbox.egress.register(probe.attemptId, {
        token,
        mode: 'allowlist',
        allowHosts: [],
        provider: null,
        expiresAt: Date.now() + input.timeoutMs + TOKEN_GRACE_MS,
        mcp: [
          {
            name: definition.name,
            url,
            headers: definition.headers.map(({ header, env }) => ({ header, env })),
          },
        ],
      });
      // Filled by the finally below, before this callback's promise settles.
      const log: EgressLogEntry[] = [];
      try {
        const result = await runProbe(sandbox, probe, {
          ...input,
          network: lease.slot,
          env: { [ATTEMPT_TOKEN_ENV]: token },
        });
        return { ...result, log };
      } finally {
        // runTrial removed the container; the token dies with the registration. If the
        // removal fails, the token still expires at expiresAt.
        log.push(...((await sandbox.egress.remove(probe.attemptId).catch(() => null))?.log ?? []));
      }
    } finally {
      lease.release();
    }
  });
  // Nothing the container printed may carry the token on: it is replaced like a value.
  const hide = (text: string) => redactValues(text, { [ATTEMPT_TOKEN_ENV]: token });
  return {
    exitCode: run.exitCode,
    stopReason: run.stopReason,
    durationMs: run.durationMs,
    stdout: hide(run.stdout),
    stderr: hide(run.stderr),
    serverLog: hide(run.serverLog),
    gatewayLog: run.log
      .filter((entry) => entry.kind === 'mcp')
      .slice(-MAX_GATEWAY_LINES)
      .map(describeGatewayCall),
  };
}

/**
 * An egress log entry as the MCP gateway writes it: egress also records the
 * HTTP method of each `mcp` call, which EgressLogEntry does not declare yet.
 */
export type McpGatewayLogEntry = EgressLogEntry & { method?: string };

/** One gateway call as a tail line: method, server, status and why, never a header or a value. */
export function describeGatewayCall(entry: McpGatewayLogEntry): string {
  const status = entry.status ?? '-';
  const reason = entry.reason ? ` · ${entry.reason}` : '';
  const verb = entry.decision === 'denied' ? 'refused' : 'answered';
  return `egress: ${entry.method ?? '?'} ${entry.server ?? '?'} ${verb} ${status}${reason}`;
}

interface ProbeDirs {
  attemptId: string;
  runId: string;
  home: string;
  workspace: string;
}

/** Makes the probe's directory with config.yaml in its home, runs `body`, and always removes it. */
async function withProbeDirs<T>(
  sandbox: McpTestSandboxParts,
  definition: McpServerInput,
  body: (probe: ProbeDirs) => Promise<T>,
): Promise<T> {
  // The trial runner and docker-guard key a container and its directory by
  // ULIDs; a test has no run or attempt row, so it makes up both.
  const attemptId = newId();
  const runId = newId();
  const dirs = await prepareTrialDirs(sandbox.trialsDir, attemptId);
  try {
    await mkdir(join(dirs.home, '.run'), { mode: 0o700 });
    await writeFile(join(dirs.home, '.no-bundled-skills'), '');
    await writeFile(join(dirs.home, 'config.yaml'), stringify(mcpTestConfig(definition)));
    return await body({ attemptId, runId, home: dirs.home, workspace: dirs.workspace });
  } finally {
    await removeTrialDirs(sandbox.trialsDir, attemptId);
  }
}

/** Runs `hermes mcp test` in the probe's container and reads what it printed and logged. */
async function runProbe(
  sandbox: McpTestSandboxParts,
  probe: ProbeDirs,
  input: HttpTestInput & { network: string; env: Record<string, string> },
): Promise<McpTestRun> {
  const stdout: string[] = [];
  const stderr = new ByteTail(STDERR_TAIL_BYTES);
  const outcome = await runTrial({
    engine: sandbox.engine,
    spec: {
      name: `hermes-evals-probe-${probe.attemptId}`,
      runId: probe.runId,
      attemptId: probe.attemptId,
      image: sandbox.image,
      volume: sandbox.volume,
      network: input.network,
      cmd: ['mcp', 'test', input.definition.name],
      env: {
        ...input.env,
        HOME: TRIAL_HOME,
        HERMES_HOME: TRIAL_HOME,
        XDG_RUNTIME_DIR: `${TRIAL_HOME}/.run`,
        TMPDIR: '/tmp',
        NO_COLOR: '1',
      },
      deadline: Math.floor((Date.now() + input.timeoutMs) / 1000) + 60,
      limits: MCP_TEST_LIMITS,
    },
    deadlineMs: input.timeoutMs,
    stopGraceSeconds: 5,
    diskLimit: { ...DEFAULT_DISK_LIMIT, roots: [probe.home, probe.workspace] },
    outputLimit: { maxBytes: input.outputLimitBytes ?? MCP_TEST_OUTPUT_LIMIT_BYTES },
    signal: input.signal,
    onStdoutLine: (line) => {
      if (stdout.length < MAX_STDOUT_LINES) stdout.push(line);
    },
    onStderr: (chunk) => stderr.push(chunk),
  });
  // The server ran as the trial user and could have replaced the log with a
  // link or a FIFO: read it the untrusting way.
  const log = await readTrialFile(probe.home, 'logs/mcp-stderr.log', MAX_SERVER_LOG_BYTES);
  return {
    exitCode: outcome.exitCode,
    stopReason: outcome.stopReason,
    durationMs: outcome.durationMs,
    stdout: stdout.join('\n'),
    stderr: stderr.text(),
    serverLog: log.ok
      ? log.content.toString('utf8')
      : log.reason === 'unreadable'
        ? ''
        : `(logs/mcp-stderr.log not read: ${log.reason}, ${log.detail})`,
  };
}
