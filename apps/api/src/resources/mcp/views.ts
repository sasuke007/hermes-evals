/**
 * Stored MCP rows to the view models in @hermes-evals/shared
 * (contracts/resources.ts). The worker uses toMcpTestView too, for the output
 * of a test-mcp-server job, so the API returns the same view either way.
 */
import type {
  ConfigurationLink,
  McpServerInput,
  McpServerRow,
  McpTestView,
} from '@hermes-evals/shared';
import type { mcpServers, mcpServerVersions } from '../../database/schema/index.js';
import { definitionOf } from './definition.js';
import { toolOffered } from './hermes-config.js';
import { readTestRecord, type McpTestRecord } from './test-record.js';

type ServerRow = typeof mcpServers.$inferSelect;
type VersionRow = typeof mcpServerVersions.$inferSelect;

/** A test result as the page shows it, with each tool marked by the definition's filters. */
export function toMcpTestView(
  record: McpTestRecord,
  filters: Pick<McpServerInput, 'include' | 'exclude'>,
): McpTestView {
  switch (record.status) {
    case 'untested':
      return { status: 'untested' };
    case 'running':
      return { status: 'running', requestedAt: record.requested_at };
    case 'passed':
      return {
        status: 'passed',
        requestedAt: record.requested_at,
        finishedAt: record.finished_at,
        startedMs: record.started_ms,
        tools: record.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? null,
          included: toolOffered(tool.name, filters),
        })),
      };
    case 'failed':
      return {
        status: 'failed',
        requestedAt: record.requested_at,
        finishedAt: record.finished_at,
        startedMs: record.started_ms ?? null,
        error: record.error,
        exitCode: record.exit_code ?? null,
        stderrTail: record.stderr_tail ?? '',
        missingSecretNames: record.missing_secret_names,
      };
  }
}

/** The server with its latest version, as GET /resources/mcp-servers lists it. */
export function toMcpServerRow(
  server: ServerRow,
  version: VersionRow,
  usedBy: ConfigurationLink[],
): McpServerRow {
  const definition = definitionOf(server.name, version);
  return {
    ...definition,
    id: server.id,
    versionId: version.id,
    version: version.version,
    // updated_at moves only when the definition is saved, never for a test result.
    definedAt: version.updatedAt.toISOString(),
    frozen: version.frozenAt !== null,
    usedBy,
    lastTest: toMcpTestView(readTestRecord(version.lastTest), definition),
  };
}
