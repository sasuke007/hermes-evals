/**
 * Things a configuration can give the agent: skills, documents and MCP servers.
 * Secrets have no table: MCP servers name the environment variables they need.
 * Values come from the worker's environment (stdio env) or from egress's
 * (http headers) at run time, and are never stored (plan 5.3).
 */
import { sql } from 'drizzle-orm';
import { bigint, check, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  MCP_TRANSPORTS,
  type McpHeader,
  type McpTestState,
  type McpTransport,
} from '@hermes-evals/shared';
import {
  createdAt,
  emptyJsonArray,
  emptyTextArray,
  id,
  isSha256,
  jsonValue,
  oneOf,
  tstz,
} from './_columns.js';
import { blobs } from './blobs.js';

/**
 * An uploaded skill: a directory with SKILL.md at its root. Stored unpacked at
 * DATA_DIR/skills/<content_hash>/ and copied into each trial home that uses it.
 * Rows never change; a new upload of the same name is a new version.
 */
export const skills = pgTable(
  'skills',
  {
    id: id(),
    /** `name` from SKILL.md frontmatter; Hermes preloads skills by this name. */
    name: text('name').notNull(),
    version: text('version').notNull(),
    description: text('description').notNull(),
    contentHash: text('content_hash').notNull(),
    fileCount: integer('file_count').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    uploadedAt: tstz('uploaded_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('skills_name_version_uq').on(t.name, t.version),
    check('skills_name_ck', sql`${t.name} ~ '^[a-z0-9][a-z0-9_-]{0,63}$'`),
    check('skills_content_hash_ck', isSha256(t.contentHash)),
    check('skills_file_count_ck', sql`${t.fileCount} >= 1`),
    check('skills_size_ck', sql`${t.sizeBytes} >= 0`),
  ],
);

/**
 * A reference file a configuration gives the agent in every run, copied to
 * workspace/docs/<filename>. Content lives in the blob store at
 * DATA_DIR/blobs/<sha256>. Documents attach to configurations only.
 */
export const documents = pgTable(
  'documents',
  {
    id: id(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    sha256: text('sha256')
      .notNull()
      .references(() => blobs.sha256),
    uploadedAt: tstz('uploaded_at').notNull().defaultNow(),
  },
  (t) => [
    check('documents_sha256_ck', isSha256(t.sha256)),
    check('documents_size_ck', sql`${t.size} >= 0`),
    check(
      'documents_filename_ck',
      sql`${t.filename} <> '' and ${t.filename} !~ '[/\\\\]' and ${t.filename} not in ('.', '..')`,
    ),
  ],
);

/**
 * Identity of an MCP server. The name becomes the Hermes toolset alias, so it
 * is appended to `-t` and used as the key under `mcp_servers` in config.yaml.
 */
export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: id(),
    name: text('name').notNull(),
    latestVersion: integer('latest_version').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('mcp_servers_name_uq').on(t.name),
    check('mcp_servers_name_ck', sql`${t.name} ~ '^[a-z0-9][a-z0-9_-]{0,62}$'`),
    check('mcp_servers_latest_version_ck', sql`${t.latestVersion} >= 1`),
  ],
);

/**
 * One definition of an MCP server. Configuration versions reference these
 * rows, so a definition is frozen once a configuration uses it; editing a
 * frozen definition creates the next version. Env and header entries are
 * variable names only, never values.
 *
 * jsonpath for mcp_server_versions_headers_ck: an entry that is not
 * `{ header, env }` with both strings in the shapes McpHeaderSchema accepts,
 * and, when it has one, a `prefix` string in MCP_HEADER_PREFIX_PATTERN's
 * shape (1 to 64 printable ASCII characters, space to tilde; migration
 * 0010, Phase 6 question 6). A prefix is absent rather than null. The check
 * refuses the row when any entry matches.
 */
const BAD_HEADER_ENTRY =
  '$[*] ? (!(@.header.type() == "string" && @.env.type() == "string"' +
  ' && @.header like_regex "^[A-Za-z0-9-]{1,64}$" && @.env like_regex "^[A-Z_][A-Z0-9_]*$"' +
  ' && (!(exists(@.prefix)) || (@.prefix.type() == "string" && @.prefix like_regex "^[ -~]{1,64}$"))))';

export const mcpServerVersions = pgTable(
  'mcp_server_versions',
  {
    id: id(),
    mcpServerId: text('mcp_server_id')
      .notNull()
      .references(() => mcpServers.id),
    version: integer('version').notNull(),
    transport: text('transport').$type<McpTransport>().notNull(),
    /** stdio: the command the worker spawns fresh for each trial. */
    command: text('command'),
    /** stdio: argv after the command, in order. */
    args: text('args').array().notNull().default(emptyTextArray),
    /** stdio: names of worker environment variables passed to the server. */
    envNames: text('env_names').array().notNull().default(emptyTextArray),
    /** http: a server the user hosts. */
    url: text('url'),
    /**
     * http: header name and the egress environment variable holding its
     * value, e.g. `{ header: 'Authorization', env: 'VENDOR_API_TOKEN' }`,
     * with an optional `prefix` written before the value (`Bearer `,
     * migration 0010). Egress adds the header on the way to the server; the
     * value never enters a trial (plan 5.3).
     */
    headers: jsonValue<McpHeader[]>('headers').notNull().default(emptyJsonArray),
    /** Tool allow and deny lists passed to Hermes. */
    include: text('include').array().notNull().default(emptyTextArray),
    exclude: text('exclude').array().notNull().default(emptyTextArray),
    timeoutS: integer('timeout_s').notNull().default(60),
    /** sha256 of the canonical definition; feeds the configuration hash. */
    definitionHash: text('definition_hash').notNull(),
    lastTest: jsonValue<McpTestState>('last_test')
      .notNull()
      .default(sql`'{"status":"untested"}'::jsonb`),
    /** Set when the first configuration version references this definition. */
    frozenAt: tstz('frozen_at'),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('mcp_server_versions_server_version_uq').on(t.mcpServerId, t.version),
    check('mcp_server_versions_version_ck', sql`${t.version} >= 1`),
    check('mcp_server_versions_transport_ck', oneOf(t.transport, MCP_TRANSPORTS)),
    // stdio: a command, args and env names, no headers. http: a URL and
    // headers, nothing to spawn. `= '[]'` rather than jsonb_array_length,
    // which raises instead of failing the check when headers is not an array.
    check(
      'mcp_server_versions_shape_ck',
      sql`(${t.transport} = 'stdio' and ${t.command} is not null and ${t.command} <> '' and ${t.url} is null and ${t.headers} = '[]'::jsonb)
       or (${t.transport} = 'http' and ${t.url} is not null and ${t.command} is null and cardinality(${t.args}) = 0 and cardinality(${t.envNames}) = 0)`,
    ),
    check(
      'mcp_server_versions_headers_ck',
      sql`jsonb_typeof(${t.headers}) = 'array' and not jsonb_path_exists(${t.headers}, ${sql.raw(`'${BAD_HEADER_ENTRY}'`)})`,
    ),
    // http(s) only, and no user:password@ in the URL.
    check(
      'mcp_server_versions_url_ck',
      sql`${t.url} is null or ${t.url} ~ '^https?://[^/?#@]+([/?#]|$)'`,
    ),
    check('mcp_server_versions_timeout_ck', sql`${t.timeoutS} between 1 and 3600`),
    check('mcp_server_versions_hash_ck', isSha256(t.definitionHash)),
    check(
      'mcp_server_versions_last_test_ck',
      sql`${t.lastTest} ->> 'status' in ('untested', 'running', 'passed', 'failed')`,
    ),
  ],
);
