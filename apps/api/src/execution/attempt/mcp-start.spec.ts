import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpServerInput } from '@hermes-evals/shared';
import {
  HERMES_ERRORS_LOG,
  mcpStartFailures,
  mcpStartMessage,
  parseMcpStartFailures,
} from './mcp-start.js';

const definition = (name: string, over: Partial<McpServerInput>): McpServerInput => ({
  name,
  transport: 'stdio',
  command: 'invoice-db-mcp',
  args: [],
  envNames: [],
  url: null,
  headers: [],
  include: [],
  exclude: [],
  timeoutS: 30,
  ...over,
});
const BROKEN = {
  name: 'broken',
  definition: definition('broken', { command: '/opt/nope/broken-mcp' }),
};
const INVOICE_DB = { name: 'invoice-db', definition: definition('invoice-db', {}) };
const VENDOR = {
  name: 'vendor-api',
  definition: definition('vendor-api', {
    transport: 'http',
    command: null,
    url: 'https://vendor.example/mcp',
  }),
};

// errors.log as Hermes 4d04303 wrote it in a live trial (Phase 2 live check).
const LOG = [
  '2026-10-24 23:19:07,853 WARNING hermes_cli.post_update: config migration skipped: This config predates version 12',
  "2026-10-24 23:19:12,149 WARNING tools.mcp_tool: MCP server 'broken' failed initial connection with a permanent error, parking without retries (state: connecting → parked): FileNotFoundError: [Errno 2] No such file or directory: '/opt/nope/broken-mcp'",
  "2026-10-24 23:19:12,149 WARNING tools.mcp_tool: Failed to connect to MCP server 'broken' (command=/opt/nope/broken-mcp): missing executable '/opt/nope/broken-mcp'",
  '  child stderr tail (full log: mcp-stderr.log):',
  "    starting MCP server 'broken' =====",
  '2026-10-24 23:19:12,171 WARNING gateway.run: No messaging platforms enabled.',
].join('\n');

describe('parseMcpStartFailures', () => {
  it("finds a stdio server's failure with Hermes's reason", () => {
    expect(parseMcpStartFailures(LOG, [INVOICE_DB, BROKEN])).toEqual([
      { name: 'broken', reason: "missing executable '/opt/nope/broken-mcp'" },
    ]);
  });

  it('finds an http server, which Hermes logs without a command', () => {
    const log =
      "x WARNING tools.mcp_tool: Failed to connect to MCP server 'vendor-api': Connection refused";
    expect(parseMcpStartFailures(log, [VENDOR])).toEqual([
      { name: 'vendor-api', reason: 'Connection refused' },
    ]);
  });

  it('matches exact names only, never another server that shares a prefix', () => {
    const log =
      "WARNING tools.mcp_tool: Failed to connect to MCP server 'invoice-db-2' (command=x): gone";
    expect(parseMcpStartFailures(log, [INVOICE_DB])).toEqual([]);
  });

  it('reports nothing for a run whose servers connected', () => {
    expect(parseMcpStartFailures(LOG.split('\n')[0]!, [INVOICE_DB, BROKEN])).toEqual([]);
  });

  it('cuts a long reason', () => {
    const log = `Failed to connect to MCP server 'broken' (command=/opt/nope/broken-mcp): ${'e'.repeat(400)}`;
    const [failure] = parseMcpStartFailures(log, [BROKEN]);
    expect(failure!.reason).toHaveLength(303);
  });
});

describe('mcpStartMessage', () => {
  it('names the first server and the rest', () => {
    expect(
      mcpStartMessage([
        { name: 'a', reason: 'gone' },
        { name: 'b', reason: 'gone' },
      ]),
    ).toBe(
      'MCP server a failed to start: gone (and b). Hermes ran without its tools, so the run is not scored.',
    );
  });
});

describe('mcpStartFailures', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcp-start-'));
    await mkdir(join(home, 'logs'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("reads the home's errors.log", async () => {
    await writeFile(join(home, HERMES_ERRORS_LOG), LOG);
    expect(await mcpStartFailures(home, [BROKEN])).toEqual([
      { name: 'broken', reason: "missing executable '/opt/nope/broken-mcp'" },
    ]);
  });

  it('reads nothing without servers, without a log, or through a link', async () => {
    await writeFile(join(home, 'elsewhere.log'), LOG);
    expect(await mcpStartFailures(home, [])).toEqual([]);
    expect(await mcpStartFailures(home, [BROKEN])).toEqual([]);
    await symlink(join(home, 'elsewhere.log'), join(home, HERMES_ERRORS_LOG));
    expect(await mcpStartFailures(home, [BROKEN])).toEqual([]);
  });

  it('never throws, even without a home', async () => {
    expect(await mcpStartFailures(join(home, 'missing'), [BROKEN])).toEqual([]);
  });
});
