/**
 * The stdio MCP env values an attempt's container gets (plan 5.3): read from
 * the worker's own environment by name, and nowhere else. They go into the
 * container environment only: config.yaml holds `${NAME}`, the launch record
 * holds the names, and everything stored is redacted (redaction.ts).
 *
 * The lifecycle checks refusedEnvNames (worker/handlers/test-mcp-server.ts)
 * against the database before it calls the runner. The checks here need no
 * database and repeat the ones that keep a value out of a trial, so the
 * runner is safe on its own: a reserved name, a name one of the attempt's
 * http servers uses as a header variable, or a missing or empty value ends
 * the attempt as `setup`, naming the variable, before any container exists.
 *
 * http servers get the same treatment against egress (checkHttpMcpServers):
 * a header variable egress does not hold would make every gateway call
 * answer 503 while Hermes carried on without the server's tools, and the
 * arm would be scored as if it had its MCP server (plan 5.3: a run with a
 * missing name fails as `setup` and names it).
 */
import {
  isReservedEnvName,
  mcpRouteProblems,
  MCP_ROUTE_LIMITS,
  reservedEnvNameMessage,
} from '@hermes-evals/shared';
import type { PlannedMcpServer } from '../contracts.js';
import { AttemptSetupError } from './errors.js';

const listOf = (names: readonly string[]): string =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** The attempt's http MCP servers. */
export const httpServers = (servers: readonly PlannedMcpServer[]): PlannedMcpServer[] =>
  servers.filter((s) => s.definition.transport === 'http');

/**
 * Refuses, before egress is asked to register them, the http routes egress
 * would refuse anyway (a definition saved before the API applied its rules):
 * a header egress sets itself, too many headers or servers, a URL too long.
 */
export function checkMcpRoutes(servers: readonly PlannedMcpServer[]): void {
  const http = httpServers(servers);
  if (http.length > MCP_ROUTE_LIMITS.maxRoutes) {
    throw new AttemptSetupError(
      `The configuration has ${http.length} http MCP servers; egress takes at most ${MCP_ROUTE_LIMITS.maxRoutes}.`,
    );
  }
  for (const server of http) {
    const problems = mcpRouteProblems(server.definition);
    if (problems.length > 0) {
      throw new AttemptSetupError(
        `The MCP server ${server.name} cannot be routed through egress: ${problems.join('; ')}.`,
      );
    }
  }
}

/**
 * Throws AttemptSetupError naming every header variable of the attempt's
 * http servers that egress does not hold (`held`: egress's own answer, by
 * name, for this worker's egress).
 */
export function checkHttpMcpServers(
  servers: readonly PlannedMcpServer[],
  held: readonly string[],
): void {
  const present = new Set(held);
  for (const server of httpServers(servers)) {
    const missing = [...new Set(server.definition.headers.map((h) => h.env))].filter(
      (name) => !present.has(name),
    );
    if (missing.length > 0) {
      throw new AttemptSetupError(
        `${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} not set in the egress ` +
          `environment; the MCP server ${server.name} cannot start.`,
      );
    }
  }
}

/** NAME → value for every env name of the attempt's stdio servers. Throws AttemptSetupError. */
export function stdioSecretValues(
  servers: readonly PlannedMcpServer[],
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const names = [
    ...new Set(
      servers.flatMap((s) => (s.definition.transport === 'stdio' ? s.definition.envNames : [])),
    ),
  ].sort();
  const reserved = names.filter(isReservedEnvName);
  if (reserved.length > 0) throw new AttemptSetupError(`${reservedEnvNameMessage(reserved)}.`);
  for (const server of servers) {
    if (server.definition.transport !== 'http') continue;
    const shared = server.definition.headers.find((h) => names.includes(h.env));
    if (shared) {
      throw new AttemptSetupError(
        `${shared.env} is the header variable of http server ${server.name}; egress holds its ` +
          'value and it never enters a trial.',
      );
    }
  }
  const missing = names.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new AttemptSetupError(
      `${listOf(missing)} ${missing.length === 1 ? 'is' : 'are'} not set in the worker ` +
        'environment; the MCP servers that use them cannot start.',
    );
  }
  return Object.fromEntries(names.map((name) => [name, env[name]!]));
}
