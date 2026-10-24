/**
 * Runs `hermes mcp test <name>` for one stdio MCP definition in a throwaway
 * trial container (plan 5.3): the hardened trial spec through docker-guard,
 * a fresh directory in the trials volume, and a config.yaml with only this
 * server, built the way a run's is (hermesMcpEntry). The container gets the
 * server's env values in its environment, exactly as a run would; config.yaml
 * holds only `${NAME}` references.
 *
 * The container has no network at all (`none`): Hermes starts stdio servers
 * without the proxy variables, so a server has no route out in a run either,
 * and a test then takes no slot network from experiments. The http case goes
 * through the egress MCP gateway, which is Phase 2.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { McpServerInput } from '@hermes-evals/shared';
import { newId } from '../../database/ids.js';
import { hermesMcpEntry } from '../../resources/mcp/hermes-config.js';
import type { EngineClient } from '../../sandbox/engine-client.js';
import { DEFAULT_DISK_LIMIT, readTrialFile } from '../../sandbox/trial-files.js';
import { ByteTail } from '../../sandbox/streams.js';
import {
  prepareTrialDirs,
  removeTrialDirs,
  runTrial,
  type TrialOutcome,
} from '../../sandbox/trial-runner.js';
import { TRIAL_HOME, type TrialLimits } from '../../sandbox/trial-spec.js';

/** What the worker's sandbox gives a test: SandboxService has all of these. */
export interface McpTestSandboxParts {
  engine: EngineClient;
  trialsDir: string;
  image: string;
  volume: string;
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

export interface StdioTestRun {
  exitCode: number;
  stopReason: TrialOutcome['stopReason'];
  durationMs: number;
  stdout: string;
  /** The last STDERR_TAIL_BYTES of Hermes's own stderr. */
  stderr: string;
  /** home/logs/mcp-stderr.log, where Hermes copies the server's stderr; '' when absent. */
  serverLog: string;
}

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

/** config.yaml for the test: only this server, and nothing that phones home. */
export function mcpTestConfig(definition: McpServerInput): Record<string, unknown> {
  return {
    mcp_servers: { [definition.name]: hermesMcpEntry(definition) },
    updates: { check: false },
    plugins: { auto_update_check_hours: 0 },
    security: { allow_lazy_installs: false },
  };
}

export async function runStdioMcpTest(
  sandbox: McpTestSandboxParts,
  input: StdioTestInput,
): Promise<StdioTestRun> {
  const { definition } = input;
  if (definition.transport !== 'stdio') throw new Error('runStdioMcpTest takes a stdio definition');
  // The trial runner and docker-guard key a container and its directory by
  // ULIDs; a test has no run or attempt row, so it makes up both.
  const attemptId = newId();
  const runId = newId();
  const dirs = await prepareTrialDirs(sandbox.trialsDir, attemptId);
  try {
    await mkdir(join(dirs.home, '.run'), { mode: 0o700 });
    await writeFile(join(dirs.home, '.no-bundled-skills'), '');
    await writeFile(join(dirs.home, 'config.yaml'), stringify(mcpTestConfig(definition)));

    const stdout: string[] = [];
    const stderr = new ByteTail(STDERR_TAIL_BYTES);
    const outcome = await runTrial({
      engine: sandbox.engine,
      spec: {
        name: `hermes-evals-probe-${attemptId}`,
        runId,
        attemptId,
        image: sandbox.image,
        volume: sandbox.volume,
        network: 'none',
        cmd: ['mcp', 'test', definition.name],
        // The values first, so a platform variable can never be replaced (the
        // handler refuses every reserved name, isReservedEnvName, before it
        // gets here).
        env: {
          ...input.values,
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
      diskLimit: { ...DEFAULT_DISK_LIMIT, roots: [dirs.home, dirs.workspace] },
      outputLimit: { maxBytes: input.outputLimitBytes ?? MCP_TEST_OUTPUT_LIMIT_BYTES },
      signal: input.signal,
      onStdoutLine: (line) => {
        if (stdout.length < MAX_STDOUT_LINES) stdout.push(line);
      },
      onStderr: (chunk) => stderr.push(chunk),
    });
    // The server ran as the trial user and could have replaced the log with a
    // link or a FIFO: read it the untrusting way.
    const log = await readTrialFile(dirs.home, 'logs/mcp-stderr.log', MAX_SERVER_LOG_BYTES);
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
  } finally {
    await removeTrialDirs(sandbox.trialsDir, attemptId);
  }
}
