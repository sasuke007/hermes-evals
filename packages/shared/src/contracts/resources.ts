/**
 * View models for the resource library: skills, documents, MCP servers and
 * secrets (Resources section, plan section 5). Secret values never appear in
 * any of these schemas; only names, and whether the service that reads each
 * one (the worker for stdio servers, egress for http servers) has it.
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { isReservedEnvName, reservedEnvNameMessage } from '../env-names.js';
import { ENV_NAME_PATTERN, McpHeaderSchema } from '../records.js';
import { MCP_TRANSPORTS } from '../vocab.js';
import {
  countView,
  HTTP_URL_PATTERN,
  isoTimeView,
  isUnique,
  sha256View,
  SLUG_PATTERN,
} from './common.js';

export const ResourceCountsSchema = z.object({
  skills: countView,
  documents: countView,
  mcpServers: countView,
  secrets: countView,
});
export type ResourceCounts = z.infer<typeof ResourceCountsSchema>;

export const ConfigurationLinkSchema = z.object({
  configurationId: z.string(),
  name: z.string(),
});
export type ConfigurationLink = z.infer<typeof ConfigurationLinkSchema>;

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** One uploaded skill version (a name and version is one row). */
export const SkillRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string(),
  contentHash: sha256View,
  fileCount: countView,
  unpackedBytes: countView,
  uploadedAt: isoTimeView,
  usedBy: z.array(ConfigurationLinkSchema),
});
export type SkillRow = z.infer<typeof SkillRowSchema>;

export const RESOURCE_FILE_KINDS = ['markdown', 'code', 'text', 'csv', 'binary'] as const;
export const ResourceFileKindSchema = z.enum(RESOURCE_FILE_KINDS);
export type ResourceFileKind = z.infer<typeof ResourceFileKindSchema>;

export const SkillFileEntrySchema = z.object({
  path: z.string(),
  sizeBytes: countView,
  kind: ResourceFileKindSchema,
});
export type SkillFileEntry = z.infer<typeof SkillFileEntrySchema>;

export const SkillDetailSchema = SkillRowSchema.extend({
  files: z.array(SkillFileEntrySchema),
  /** SKILL.md split into its front matter (verbatim YAML) and Markdown body. */
  skillMd: z.object({ frontMatter: z.string(), body: z.string() }),
});
export type SkillDetail = z.infer<typeof SkillDetailSchema>;

export const SkillFileContentSchema = z.object({
  path: z.string(),
  kind: ResourceFileKindSchema,
  sizeBytes: countView,
  /** Text content; null for binary files (size and hash only). */
  content: z.string().nullable(),
  sha256: sha256View,
});
export type SkillFileContent = z.infer<typeof SkillFileContentSchema>;

/** One line of the validation checklist in ResourceUploadDialog. */
export const UploadCheckSchema = z.object({
  label: z.string(),
  value: z.string(),
  ok: z.boolean(),
});
export type UploadCheck = z.infer<typeof UploadCheckSchema>;

export const UploadProblemSchema = z.object({
  title: z.string(),
  detail: z.string(),
});
export type UploadProblem = z.infer<typeof UploadProblemSchema>;

/**
 * Result of POST /resources/skills/validate. Nothing is stored yet.
 * - `valid`: a new name, or a new version of nothing; Confirm upload.
 * - `new_version`: the name exists and SKILL.md declares a new version; "Upload as 1.1.0".
 * - `conflict`: same name and version as a stored skill with a different hash; Confirm disabled.
 * - `invalid`: problems listed; Confirm disabled.
 */
export const SkillUploadValidationSchema = z.object({
  /** Short-lived token Confirm sends back; null when the upload cannot be confirmed. */
  token: z.string().nullable(),
  fileName: z.string(),
  sizeBytes: countView,
  outcome: z.enum(['valid', 'new_version', 'conflict', 'invalid']),
  name: z.string().nullable(),
  version: z.string().nullable(),
  description: z.string().nullable(),
  contentHash: sha256View.nullable(),
  checks: z.array(UploadCheckSchema),
  problems: z.array(UploadProblemSchema),
  /** The stored version this upload collides with or follows. */
  existing: z.object({ id: z.string(), version: z.string(), contentHash: sha256View }).nullable(),
  fileTree: z.array(z.object({ path: z.string(), sizeBytes: countView })),
  unpackedBytes: countView,
});
export type SkillUploadValidation = z.infer<typeof SkillUploadValidationSchema>;

/** Body of POST /resources/skills: confirms a validated upload. */
export const SkillConfirmRequestSchema = z.strictObject({
  token: z.string().min(1),
});
export type SkillConfirmRequest = z.infer<typeof SkillConfirmRequestSchema>;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const DocumentRowSchema = z.object({
  id: z.string(),
  filename: z.string(),
  sizeBytes: countView,
  mediaType: z.string(),
  /** e.g. "PDF · 6 pages". */
  typeLabel: z.string(),
  sha256: sha256View,
  uploadedAt: isoTimeView,
  attachedTo: z.array(ConfigurationLinkSchema),
});
export type DocumentRow = z.infer<typeof DocumentRowSchema>;

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export const McpToolViewSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  /** Whether the server's include/exclude filter offers this tool to the agent. */
  included: z.boolean(),
});
export type McpToolView = z.infer<typeof McpToolViewSchema>;

/** Result of the last "Test start" of a server definition. Never holds secret values. */
export const McpTestViewSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('untested') }),
  z.object({ status: z.literal('running'), requestedAt: isoTimeView }),
  z.object({
    status: z.literal('passed'),
    requestedAt: isoTimeView,
    finishedAt: isoTimeView,
    startedMs: countView,
    tools: z.array(McpToolViewSchema),
  }),
  z.object({
    status: z.literal('failed'),
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
   * Header and variable name pairs (http), e.g. Authorization ← VENDOR_API_TOKEN.
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

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export const SecretReferenceSchema = z
  .object({
    kind: z.literal('mcp_server'),
    id: z.string(),
    name: z.string(),
    via: z.enum(['env', 'header']),
    /** The header the value is sent as, when via = 'header'; null for env. */
    header: z.string().nullable(),
  })
  .refine((r) => (r.via === 'header') === (r.header !== null), {
    path: ['header'],
    message: 'header is set exactly when via is header',
  });
export type SecretReference = z.infer<typeof SecretReferenceSchema>;

/**
 * Who reads a secret's value. stdio env values come from the worker and are
 * set in the trial's environment, so the agent can read them; http header
 * values come from egress and never enter the run (plan section 5.3).
 */
export const SECRET_SOURCES = ['worker', 'egress'] as const;
export type SecretSource = (typeof SECRET_SOURCES)[number];
export const SECRET_EXPOSURES = ['readable_by_agent', 'egress_only'] as const;
export type SecretExposure = (typeof SECRET_EXPOSURES)[number];
/** The exposure that follows from each source. */
export const SECRET_EXPOSURE_BY_SOURCE = {
  worker: 'readable_by_agent',
  egress: 'egress_only',
} as const satisfies Record<SecretSource, SecretExposure>;

/**
 * One secret name referenced by MCP servers, and whether the service that
 * reads it has it. One row per name and source: a name used both as a stdio
 * env variable and as an http header variable is two rows.
 */
export const SecretRowSchema = z
  .object({
    name: z.string().regex(ENV_NAME_PATTERN),
    set: z.boolean(),
    source: z.enum(SECRET_SOURCES),
    /** `readable_by_agent` for source worker, `egress_only` for source egress. */
    exposure: z.enum(SECRET_EXPOSURES),
    /** env references for source worker, header references for source egress. */
    referencedBy: z.array(SecretReferenceSchema),
    lastCheckedAt: isoTimeView,
    /** When the service reported it: "at worker start" or "on request". */
    checkedWhen: z.string(),
  })
  .superRefine((row, ctx) => {
    if (row.exposure !== SECRET_EXPOSURE_BY_SOURCE[row.source]) {
      ctx.addIssue({
        code: 'custom',
        path: ['exposure'],
        message: `source ${row.source} means exposure ${SECRET_EXPOSURE_BY_SOURCE[row.source]}`,
      });
    }
    const via = row.source === 'worker' ? 'env' : 'header';
    if (row.referencedBy.some((r) => r.via !== via)) {
      ctx.addIssue({
        code: 'custom',
        path: ['referencedBy'],
        message: `source ${row.source} is referenced via ${via} only`,
      });
    }
  });
export type SecretRow = z.infer<typeof SecretRowSchema>;
