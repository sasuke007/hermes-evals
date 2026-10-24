/**
 * Reads what `hermes mcp test <name>` prints (hermes_cli/mcp_config.py,
 * cmd_mcp_test, at revision 4d04303). Captured from the trial image in
 * __fixtures__/hermes-mcp-test/. A run that connects prints:
 *
 *     ✓ Connected (1171ms)
 *     ✓ Tools discovered: 4
 *
 *       list_invoices                        List invoices, optionally only those ...
 *
 * Each tool line is four spaces, the name padded to 36 characters, a space
 * and the description, which Hermes shortens to 55 characters plus "...".
 * Descriptions are not flattened, so a multi-line description continues on
 * lines of its own. A line counts as a tool only when it has that exact
 * layout; anything else continues the previous description, and the result
 * must have as many tools as Hermes says it discovered. A failure prints
 * "✗ Connection failed (10.1s): <reason>". The exit code (0 connected,
 * 1 failed, 3 no such server) is the caller's to read.
 *
 * Blank lines are ignored everywhere: the trial runner's line splitter drops
 * them, so the text read from a container never has any, and a capture taken
 * with `docker run` parses the same.
 */

export interface ParsedMcpTool {
  name: string;
  /** Hermes's shortened description; null when the server gave none. */
  description: string | null;
}

export interface McpTestOutput {
  /** From "Connected (1171ms)": starting the server and listing its tools. */
  connectedMs: number | null;
  /** From "Tools discovered: N". */
  discovered: number | null;
  /** The listed tools, or null when the list could not be read reliably. */
  tools: ParsedMcpTool[] | null;
  /** From "Connection failed (10.1s): reason". */
  failure: { elapsedS: number; reason: string } | null;
}

const NAME_WIDTH = 36;
const INDENT = '    ';
// oxlint-disable-next-line no-control-regex -- ANSI colour sequences start with ESC
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const CONNECTED = /^\s*\S*\s*Connected \((\d+)ms\)\s*$/;
const DISCOVERED = /^\s*\S*\s*Tools discovered: (\d+)\s*$/;
const FAILED = /^\s*\S*\s*Connection failed \((\d+(?:\.\d+)?)s\): (.*)$/;

export function parseMcpTestOutput(stdout: string): McpTestOutput {
  const lines = stdout
    .replace(ANSI, '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  let connectedMs: number | null = null;
  let discovered: number | null = null;
  let discoveredAt = -1;
  let failure: McpTestOutput['failure'] = null;
  for (const [i, line] of lines.entries()) {
    const connected = CONNECTED.exec(line);
    if (connected && connectedMs === null) connectedMs = Number(connected[1]);
    const count = DISCOVERED.exec(line);
    if (count && discoveredAt < 0) {
      discovered = Number(count[1]);
      discoveredAt = i;
    }
    const failed = FAILED.exec(line);
    if (failed && !failure) failure = { elapsedS: Number(failed[1]), reason: failed[2]!.trim() };
  }
  const tools =
    discovered === null ? null : readToolList(lines.slice(discoveredAt + 1), discovered);
  return { connectedMs, discovered, tools, failure };
}

/** The tool lines after "Tools discovered: N", each followed by any further lines of its description. */
function readToolList(after: string[], expected: number): ParsedMcpTool[] | null {
  if (expected === 0) return after.length === 0 ? [] : null;
  const found: Array<{ name: string; lines: string[] }> = [];
  for (const line of after) {
    const tool = toolLine(line);
    if (tool) found.push({ name: tool.name, lines: [tool.description] });
    else if (found.length > 0) found.at(-1)!.lines.push(line);
    else return null;
  }
  if (found.length !== expected) return null;
  return found.map(({ name, lines }) => {
    const description = lines.join('\n').trimEnd();
    return { name, description: description === '' ? null : description };
  });
}

/**
 * `    {name:36} {description}` as Python formats it: the name padded with
 * spaces to 36 code points (a longer name is not padded), then one space.
 */
function toolLine(line: string): { name: string; description: string } | null {
  if (!line.startsWith(INDENT)) return null;
  // Code points, as Python counts a string's length for padding.
  const rest = Array.from(line.slice(INDENT.length));
  const space = rest.indexOf(' ');
  if (space <= 0) return null;
  const nameEnd = Math.max(space, NAME_WIDTH);
  if (rest.slice(space, nameEnd + 1).some((c) => c !== ' ') || rest.length <= nameEnd) return null;
  return { name: rest.slice(0, space).join(''), description: rest.slice(nameEnd + 1).join('') };
}
