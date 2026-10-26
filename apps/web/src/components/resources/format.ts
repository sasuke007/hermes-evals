/**
 * How the resource library writes file trees, MCP commands and tool filters, as the Resources
 * boards draw them. Sizes, hashes and counts come from lib/format.ts (formatBytes follows the
 * API's own rule, so a size the browser measures reads like one the API sends).
 */
import type { ConfigurationLink, McpServerInput, McpTestView } from '@/api/types/resources';
import { formatBytes } from '@/lib/format';

/**
 * The file tree under an upload, as the dialog's <pre> draws it:
 *   invoice-method/
 *   ├── SKILL.md                 2.1 KB
 *   └── examples/sample.csv      4.9 KB
 */
export function fileTreeText(
  root: string | null,
  files: ReadonlyArray<{ path: string; sizeBytes: number }>,
): string {
  const width = Math.max(24, ...files.map((f) => f.path.length + 4));
  const lines = files.map((f, i) => {
    const branch = i === files.length - 1 ? '└── ' : '├── ';
    return `${branch}${f.path.padEnd(width)}${formatBytes(f.sizeBytes)}`;
  });
  return [...(root ? [`${root}/`] : []), ...lines].join('\n');
}

/**
 * The Arguments field as a list: words split on spaces, with "double" or 'single' quotes
 * keeping spaces inside one argument.
 */
export function splitArgs(text: string): string[] {
  const args: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const match of text.matchAll(pattern)) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return args;
}

/** The list back as the field shows it: an argument with a space is quoted. */
export function joinArgs(args: readonly string[]): string {
  return args.map((a) => (a === '' || /\s/.test(a) ? `"${a}"` : a)).join(' ');
}

/** "npx invoice-db-mcp" for stdio, the URL for http. */
export function endpointOf(server: Pick<McpServerInput, 'transport' | 'command' | 'args' | 'url'>) {
  return server.transport === 'stdio'
    ? [server.command ?? '', joinArgs(server.args)].filter(Boolean).join(' ')
    : (server.url ?? '');
}

/** Of the tools a passed test listed: how many the filter offers. null before a passed test. */
export function toolCounts(test: McpTestView): { total: number; included: number } | null {
  if (test.status !== 'passed') return null;
  return { total: test.tools.length, included: test.tools.filter((t) => t.included).length };
}

type HeaderPair = McpServerInput['headers'][number];

/**
 * A header pair's prefix as typed (Phase 6 question 6): none when blank; leading spaces
 * dropped; and a prefix ending in a letter or digit gets one space, so "Bearer" sends
 * "Bearer <value>" as an Authorization scheme needs, while it stays within the 64
 * characters a prefix may have. "token=" stays as it is.
 */
export function headerPrefixOf(typed: string): string | undefined {
  const prefix = typed.replace(/^\s+/, '');
  if (!prefix) return undefined;
  return /[A-Za-z0-9]$/.test(prefix) && prefix.length < 64 ? `${prefix} ` : prefix;
}

/** What egress sends: `VENDOR_API_TOKEN`, or `"Bearer " + VENDOR_API_TOKEN` with a prefix. */
export function headerValueText(pair: HeaderPair): string {
  return pair.prefix ? `${JSON.stringify(pair.prefix)} + ${pair.env}` : pair.env;
}

/** The header names of a server's row: `Authorization ("Bearer " + value)`, `X-Team`. */
export function headerNamesText(headers: readonly HeaderPair[]): string {
  return headers
    .map((h) => (h.prefix ? `${h.header} (${JSON.stringify(h.prefix)} + value)` : h.header))
    .join(', ');
}

/** Whether any configuration version names a skill or document (SkillRow, DocumentRow). */
interface InUse {
  inUse: boolean;
  inUseBy: readonly ConfigurationLink[];
}

/** `a`, `a and b`, `a, b and c`, as the API joins names in its refusal. */
function listed(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Why Delete is disabled (Phase 5b question 8): any configuration version names the skill
 * or document, not only a latest one, and the API refuses the delete for the same reason.
 * Null when Delete is allowed.
 */
export function inUseReason(what: 'skill' | 'document', row: InUse): string | null {
  if (!row.inUse) return null;
  const names = listed(row.inUseBy.map((c) => c.name));
  return `Part of a saved version of ${names}. A configuration version keeps the ${what} it was saved with, so it cannot be deleted.`;
}

/** The configurations only an older version of which names the resource (not `latest`). */
export function olderVersionsOnly(
  latest: readonly ConfigurationLink[],
  row: InUse,
): ConfigurationLink[] {
  const now = new Set(latest.map((c) => c.configurationId));
  return row.inUseBy.filter((c) => !now.has(c.configurationId));
}
