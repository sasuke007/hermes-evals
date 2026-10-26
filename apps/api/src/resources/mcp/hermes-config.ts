/**
 * How an MCP server definition reaches Hermes: its entry under `mcp_servers`
 * in a trial's config.yaml (plan 8.2), and Hermes's rule for which of the
 * server's tools the agent is offered. The MCP "Test start" container and,
 * from Phase 2, every trial build their config from this, so a test checks
 * exactly what a run gets.
 */
import type { McpHeader, McpServerInput } from '@hermes-evals/shared';
import { MCP_GATEWAY_HEADERS } from '../../execution/providers-map.js';
import { headerPair } from './definition.js';

/** Where a trial reaches an http server: the egress MCP gateway, which adds the headers (plan 5.3). */
export const egressMcpUrl = (name: string): string => `http://egress:8080/mcp/${name}`;

/**
 * An http server's headers as its egress route carries them (the
 * registration's `mcp[].headers`, apps/egress/src/registry.ts): the header,
 * the variable egress reads its value from and, when the definition gives
 * one, the prefix egress writes before that value (`Bearer `, Phase 7).
 * Names only; egress holds the values. Both a trial's registration and an
 * MCP Test start's use it, so a test checks what a run gets.
 */
export function egressRouteHeaders(
  headers: readonly McpHeader[],
): Array<{ header: string; env: string; prefix?: string }> {
  return headers.map(headerPair);
}

/**
 * The server's config.yaml entry. Never holds a value:
 * - stdio env entries are `${NAME}` references, which Hermes fills from its
 *   own environment when it starts the server; the trial container's
 *   environment carries the values.
 * - an http server points at the egress gateway, with only the attempt-token
 *   reference as its Authorization header (`Bearer ${HERMES_EVALS_ATTEMPT_TOKEN}`,
 *   providers-map.ts). Hermes fills it from the container environment and
 *   sends it on every request, its preflight probe included; the gateway
 *   checks it, strips it, and adds the definition's own headers from
 *   egress's environment.
 * An empty include list is left out: to Hermes `include: []` offers no tool
 * at all, while to the platform it means "no filter".
 * `timeout` is Hermes's per-call limit for the server's tools.
 */
export function hermesMcpEntry(def: McpServerInput): Record<string, unknown> {
  const tools: { include?: string[]; exclude?: string[] } = {};
  if (def.include.length > 0) tools.include = [...def.include];
  if (def.exclude.length > 0) tools.exclude = [...def.exclude];
  const filters = tools.include || tools.exclude ? { tools } : {};
  if (def.transport === 'http') {
    return {
      url: egressMcpUrl(def.name),
      headers: { ...MCP_GATEWAY_HEADERS },
      ...filters,
      timeout: def.timeoutS,
    };
  }
  return {
    command: def.command,
    args: [...def.args],
    env: Object.fromEntries(def.envNames.map((name) => [name, `\${${name}}`])),
    ...filters,
    timeout: def.timeoutS,
  };
}

/**
 * Whether Hermes offers `tool` to the agent under the definition's filters
 * (tools/mcp_tool_registration.py and mcp_tool_schema.py at 4d04303): a
 * non-empty include list is a whitelist and wins over exclude; otherwise
 * every tool not matching exclude is offered. Entries are exact names, or
 * case-sensitive fnmatch globs when they contain `*`, `?` or `[`.
 */
export function toolOffered(
  tool: string,
  def: Pick<McpServerInput, 'include' | 'exclude'>,
): boolean {
  if (def.include.length > 0) return matchesAny(tool, def.include);
  return !matchesAny(tool, def.exclude);
}

function matchesAny(tool: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => p === tool || (/[*?[]/.test(p) && globToRegExp(p).test(tool)));
}

/** Python's fnmatch.translate: `*`, `?`, `[seq]` and `[!seq]`; an unclosed `[` is literal. */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!;
    if (c === '*') {
      source += '.*';
    } else if (c === '?') {
      source += '.';
    } else if (c === '[') {
      let j = i + 1;
      if (pattern[j] === '!') j += 1;
      if (pattern[j] === ']') j += 1;
      while (j < pattern.length && pattern[j] !== ']') j += 1;
      if (j >= pattern.length) {
        source += '\\[';
      } else {
        let set = pattern.slice(i + 1, j).replace(/\\/g, '\\\\');
        let negate = '';
        if (set.startsWith('!')) {
          negate = '^';
          set = set.slice(1);
        } else if (set.startsWith('^')) {
          set = `\\${set}`;
        }
        // A leading `]` is a member in fnmatch; JavaScript would read `[]` as an empty class.
        if (set.startsWith(']')) set = `\\${set}`;
        source += `[${negate}${set}]`;
        i = j;
      }
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 's');
}
