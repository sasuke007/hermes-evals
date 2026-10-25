/**
 * MCP servers Hermes could not start (plan 8.4: "MCP server failed to start"
 * is `execution_error · setup`). Hermes does not stop a one-shot run when a
 * configured server fails to connect: it parks the server, runs the agent
 * without its tools and ends with a normal `result`, so the run would be
 * scored as if the configuration had been applied. Nothing reaches stdout or
 * stderr; the one record is a WARNING in HERMES_HOME/logs/errors.log, written
 * once per server by the discovery pass (tools/mcp_tool_discovery.py at
 * 4d04303):
 *
 *   ... WARNING tools.mcp_tool: Failed to connect to MCP server '<name>' (command=<cmd>): <reason>
 *
 * The runner reads that file from the home once the container is gone and
 * before it deletes the home. The agent can write to its home, so it could
 * forge such a line (which only fails its own run) or remove the file; a
 * missing, unreadable or oversized log reads as "no failure", as before.
 */
import { readTrialFile } from '../../sandbox/trial-files.js';
import type { PlannedMcpServer } from '../contracts.js';

/** errors.log, relative to the home. Hermes rotates it at 2 MiB. */
export const HERMES_ERRORS_LOG = 'logs/errors.log';
const MAX_LOG_BYTES = 4 * 1024 * 1024;
/** Longest reason kept; Hermes's own reason is one line. */
const MAX_REASON = 300;

export interface McpStartFailure {
  name: string;
  /** Hermes's reason, e.g. "missing executable '/opt/x/server'". */
  reason: string;
}

/**
 * The configured servers errors.log reports as failed to connect, in the
 * configuration's order. Only exact names of this attempt's servers count,
 * and for a stdio server the line must carry its own command.
 */
export function parseMcpStartFailures(
  log: string,
  servers: readonly Pick<PlannedMcpServer, 'name' | 'definition'>[],
): McpStartFailure[] {
  const failures: McpStartFailure[] = [];
  for (const server of servers) {
    const command = server.definition.command;
    const prefix = `Failed to connect to MCP server '${server.name}'`;
    const heads = [command ? `${prefix} (command=${command}): ` : null, `${prefix}: `];
    for (const line of log.split('\n')) {
      const head = heads.find((h) => h !== null && line.includes(h));
      if (!head) continue;
      const reason = line.slice(line.indexOf(head) + head.length).trim();
      failures.push({
        name: server.name,
        reason: reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}...` : reason,
      });
      break;
    }
  }
  return failures;
}

/** Reads the home's errors.log (no link followed) and parses it; never throws. */
export async function mcpStartFailures(
  home: string,
  servers: readonly Pick<PlannedMcpServer, 'name' | 'definition'>[],
): Promise<McpStartFailure[]> {
  if (servers.length === 0) return [];
  try {
    const read = await readTrialFile(home, HERMES_ERRORS_LOG, MAX_LOG_BYTES);
    return read.ok ? parseMcpStartFailures(read.content.toString('utf8'), servers) : [];
  } catch {
    return [];
  }
}

/** The setup message for an attempt whose servers failed to start. */
export function mcpStartMessage(failures: readonly McpStartFailure[]): string {
  const [first, ...rest] = failures;
  if (!first) return '';
  const more = rest.length > 0 ? ` (and ${rest.map((f) => f.name).join(', ')})` : '';
  return `MCP server ${first.name} failed to start: ${first.reason}${more}. Hermes ran without its tools, so the run is not scored.`;
}
