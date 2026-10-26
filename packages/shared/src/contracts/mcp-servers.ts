/**
 * MCP server definitions in the resource library (plan section 5.3, UI_FLOWS
 * 9.3): the form's input, the stored row with its last Test start, and the
 * rules egress's registration shares. Names only, never a secret value:
 * stdio servers name environment variables the worker passes, http servers
 * header and variable pairs egress adds. The rest of the library is in
 * ./resources.ts. See ./common.ts for the conventions every contract file
 * follows.
 */
import { z } from 'zod';
import { isReservedEnvName, reservedEnvNameMessage } from '../env-names.js';
import { ENV_NAME_PATTERN, McpHeaderSchema, type McpHeader } from '../records.js';
import { MCP_TRANSPORTS } from '../vocab.js';
import {
  countView,
  HTTP_URL_PATTERN,
  isoTimeView,
  isUnique,
  sha256View,
  SLUG_PATTERN,
} from './common.js';
import { ConfigurationLinkSchema } from './resources.js';

export const McpToolViewSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  /** Whether the server's include/exclude filter offers this tool to the agent. */
  included: z.boolean(),
});
export type McpToolView = z.infer<typeof McpToolViewSchema>;

/**
 * The definition a test ran on: the hash of what the form held (the same as
 * McpServerRow's version's definition hash once saved). POST
 * /resources/mcp-servers/test always sets it, and a save whose definition
 * hashes the same keeps that test's result instead of reading "untested"
 * (Phase 5 question 14). Absent on results read back from a saved version.
 */
const definitionHash = sha256View.optional();

/** Result of the last "Test start" of a server definition. Never holds secret values. */
export const McpTestViewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('untested') }),
  z.object({ status: z.literal('running'), requestedAt: isoTimeView, definitionHash }),
  z.object({
    status: z.literal('passed'),
    definitionHash,
    requestedAt: isoTimeView,
    finishedAt: isoTimeView,
    startedMs: countView,
    tools: z.array(McpToolViewSchema),
  }),
  z.object({
    status: z.literal('failed'),
    definitionHash,
    requestedAt: isoTimeView,
    finishedAt: isoTimeView,
    startedMs: countView.nullable(),
    /** e.g. "Exited with code 1 after 0.6 s · no tools listed". */
    error: z.string(),
    exitCode: z.number().int().nullable(),
    stderrTail: z.string(),
    /** Env names the worker lacks (stdio) or header variables egress lacks (http). Names only. */
    missingSecretNames: z.array(z.string()),
  }),
]);
export type McpTestView = z.infer<typeof McpTestViewSchema>;

/**
 * Headers egress manages itself or that would change where a request goes.
 * A definition cannot set them.
 */
const RESERVED_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * What egress's registration schema refuses on an http server's route
 * (apps/egress/src/registry.ts McpRouteSchema), beyond RESERVED_HEADERS: a
 * definition that saves must also register, or every attempt that uses it
 * ends as `setup`. Checked on input only (and by the worker before it
 * registers an attempt), so a row stored before the rule still reads back.
 */
export const MCP_ROUTE_LIMITS = { maxHeaders: 32, maxUrlChars: 2048, maxRoutes: 32 } as const;
const EGRESS_ONLY_REFUSED_HEADERS: ReadonlySet<string> = new Set(['proxy-authenticate']);

/**
 * Why egress would refuse an http server's route, or [] when it would not:
 * a header egress sets or refuses itself, more headers than a route may
 * carry, or a URL longer than egress accepts. The worker runs it on every
 * http server of an attempt before registering it.
 */
export function mcpRouteProblems(s: {
  url: string | null;
  headers: ReadonlyArray<{ header: string }>;
}): string[] {
  const problems: string[] = [];
  const refused = [
    ...new Set(
      s.headers
        .map((h) => h.header.toLowerCase())
        .filter((h) => RESERVED_HEADERS.has(h) || EGRESS_ONLY_REFUSED_HEADERS.has(h)),
    ),
  ];
  if (refused.length > 0) problems.push(`egress sets ${refused.join(', ')} itself`);
  if (s.headers.length > MCP_ROUTE_LIMITS.maxHeaders) {
    problems.push(`at most ${MCP_ROUTE_LIMITS.maxHeaders} headers`);
  }
  if (s.url !== null && s.url.length > MCP_ROUTE_LIMITS.maxUrlChars) {
    problems.push(`the url must be at most ${MCP_ROUTE_LIMITS.maxUrlChars} characters`);
  }
  return problems;
}

/**
 * The header pairs of a definition in the canonical form its hash covers
 * (apps/api resources/mcp/definition.ts definitionHash): each header name
 * lower-cased, as HTTP compares them, with its variable, and its prefix only
 * when it has one, sorted by header name. A pair without a prefix is
 * exactly the `{ header, env }` of definitions stored before prefixes
 * existed (Phase 7), so an unchanged definition keeps its hash and no new
 * version is made for it; setting, changing or removing a prefix changes
 * the hash.
 */
export function canonicalMcpHeaders(
  headers: readonly McpHeader[],
): Array<{ header: string; env: string; prefix?: string }> {
  return headers
    .map((h) => ({
      header: h.header.toLowerCase(),
      env: h.env,
      ...(h.prefix !== undefined ? { prefix: h.prefix } : {}),
    }))
    .sort((a, b) => (a.header < b.header ? -1 : a.header > b.header ? 1 : 0));
}

/** The fields of an MCP server definition, unchecked. Rows extend this. */
const McpServerFieldsSchema = z.object({
  /** The `-t` alias Hermes knows the server by. */
  name: z.string(),
  transport: z.enum(MCP_TRANSPORTS),
  /** stdio only. */
  command: z.string().nullable(),
  args: z.array(z.string()),
  /**
   * Environment variable names (stdio). Values come from the worker
   * environment and are readable by the agent (plan section 5.3).
   */
  envNames: z.array(z.string()),
  /** http only. */
  url: z.string().nullable(),
  /**
   * Header and variable name pairs (http), e.g. Authorization ← VENDOR_API_TOKEN,
   * each with an optional prefix (`Bearer `) written before the value.
   * Egress adds each value from its own environment; the run never sees them.
   */
  headers: z.array(McpHeaderSchema),
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  timeoutS: z.number().int(),
});

type McpServerFields = z.infer<typeof McpServerFieldsSchema>;

/**
 * Exactly one transport shape, the rule the mcp_server_versions shape CHECK
 * enforces, plus the name rules the API checks before it gets there.
 */
function checkMcpServer(s: McpServerFields, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (!SLUG_PATTERN.test(s.name)) {
    issue('name', 'use lowercase letters, digits, - and _ (at most 63 characters)');
  }
  if (s.transport === 'stdio') {
    if (s.command === null || s.command.trim() === '') {
      issue('command', 'a stdio server needs a command');
    }
    if (s.url !== null) issue('url', 'a stdio server has no url');
    if (s.headers.length > 0) issue('headers', 'a stdio server has no headers; use envNames');
  } else {
    if (s.url === null || !HTTP_URL_PATTERN.test(s.url)) {
      issue('url', 'an http server needs an http(s) url without user:password@');
    }
    if (s.command !== null) issue('command', 'an http server has no command');
    if (s.args.length > 0) issue('args', 'an http server has no args');
    if (s.envNames.length > 0) issue('envNames', 'an http server has no envNames; use headers');
  }
  if (!s.envNames.every((n) => ENV_NAME_PATTERN.test(n))) {
    issue('envNames', 'environment variable names are upper case: A-Z, 0-9 and _');
  }
  if (!isUnique(s.envNames)) issue('envNames', 'environment variable names must not repeat');
  const headerNames = s.headers.map((h) => h.header.toLowerCase());
  if (!isUnique(headerNames)) issue('headers', 'header names must not repeat');
  const reserved = headerNames.filter((h) => RESERVED_HEADERS.has(h));
  if (reserved.length > 0) issue('headers', `egress sets ${reserved.join(', ')} itself`);
  for (const key of ['include', 'exclude'] as const) {
    if (s[key].some((t) => t === '')) issue(key, 'tool names must not be empty');
    if (!isUnique(s[key])) issue(key, 'tool names must not repeat');
  }
  if (s.timeoutS < 1 || s.timeoutS > 3600) issue('timeoutS', 'timeout must be 1 to 3600 seconds');
}

/**
 * Names a definition may not reference (env-names.ts): the worker's and
 * egress's own settings and the provider credentials, which must never enter
 * a trial. Checked on input only, not in checkMcpServer, so a row stored
 * before the rule still reads back; the worker refuses such a row when it
 * tests or runs it.
 */
function checkReservedNames(s: McpServerFields, ctx: z.RefinementCtx): void {
  const refuse = (path: string, names: string[]) => {
    if (names.length > 0) {
      ctx.addIssue({ code: 'custom', path: [path], message: reservedEnvNameMessage(names) });
    }
  };
  refuse('envNames', s.envNames.filter(isReservedEnvName));
  refuse('headers', [...new Set(s.headers.map((h) => h.env).filter(isReservedEnvName))]);
  if (s.transport !== 'http') return;
  // RESERVED_HEADERS is reported by checkMcpServer; these are the rest egress refuses.
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  const egressOnly = [
    ...new Set(
      s.headers
        .map((h) => h.header.toLowerCase())
        .filter((h) => EGRESS_ONLY_REFUSED_HEADERS.has(h)),
    ),
  ];
  if (egressOnly.length > 0) issue('headers', `egress sets ${egressOnly.join(', ')} itself`);
  if (s.headers.length > MCP_ROUTE_LIMITS.maxHeaders) {
    issue('headers', `at most ${MCP_ROUTE_LIMITS.maxHeaders} headers`);
  }
  if (s.url !== null && s.url.length > MCP_ROUTE_LIMITS.maxUrlChars) {
    issue('url', `the url must be at most ${MCP_ROUTE_LIMITS.maxUrlChars} characters`);
  }
}

/**
 * An MCP server definition as the form edits it: the body of
 * POST /resources/mcp-servers, PUT /resources/mcp-servers/:id and
 * POST /resources/mcp-servers/test. Names only, never a value.
 */
export const McpServerInputSchema =
  McpServerFieldsSchema.superRefine(checkMcpServer).superRefine(checkReservedNames);
export type McpServerInput = z.infer<typeof McpServerInputSchema>;

export const McpServerRowSchema = McpServerFieldsSchema.extend({
  id: z.string(),
  versionId: z.string(),
  version: z.number().int().positive(),
  definedAt: isoTimeView,
  /** True once a configuration version uses this definition; editing creates a new version. */
  frozen: z.boolean(),
  usedBy: z.array(ConfigurationLinkSchema),
  lastTest: McpTestViewSchema,
}).superRefine(checkMcpServer);
export type McpServerRow = z.infer<typeof McpServerRowSchema>;
