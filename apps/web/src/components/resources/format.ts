/**
 * How the resource library writes file trees, MCP commands and tool filters, as the Resources
 * boards draw them. Sizes, hashes and counts come from lib/format.ts (formatBytes follows the
 * API's own rule, so a size the browser measures reads like one the API sends).
 */
import type { McpServerInput, McpTestView } from '@/api/types/resources';
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
