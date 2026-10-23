/**
 * Agent configurations. A configuration is a name; its versions hold the
 * settings. A version that an experiment has used is frozen, and saving
 * changes to it creates the next version, so an experiment always points at
 * exactly what it tested.
 */
import { sql } from 'drizzle-orm';
import { boolean, check, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { PROVIDERS, type Provider } from '@hermes-evals/shared';
import { createdAt, emptyTextArray, id, isSha256, oneOf, tstz } from './_columns.js';

export const configurations = pgTable(
  'configurations',
  {
    id: id(),
    name: text('name').notNull(),
    latestVersion: integer('latest_version').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('configurations_name_uq').on(t.name),
    check('configurations_name_ck', sql`${t.name} ~ '^[a-z0-9][a-z0-9_-]{0,62}$'`),
    check('configurations_latest_version_ck', sql`${t.latestVersion} >= 1`),
  ],
);

/**
 * The settings Hermes is launched with. Resource references are id arrays:
 * skills and documents are immutable rows and MCP definitions freeze when
 * referenced, so a frozen version always resolves to the same files. The API
 * checks every id exists on save, because Postgres cannot put a foreign key
 * on array elements.
 */
export const configurationVersions = pgTable(
  'configuration_versions',
  {
    id: id(),
    configurationId: text('configuration_id')
      .notNull()
      .references(() => configurations.id),
    version: integer('version').notNull(),
    /** Model id as the provider names it, e.g. `openai/gpt-6.1-sol`. */
    model: text('model').notNull(),
    provider: text('provider').$type<Provider>().notNull(),
    /** Required for the `custom` provider. */
    baseUrl: text('base_url'),
    /** Name of the worker env var holding the key, when it is not the provider default. */
    apiKeyEnv: text('api_key_env'),
    /** Hermes toolsets, sorted and de-duplicated. MCP server names are appended at launch. */
    toolsets: text('toolsets').array().notNull().default(emptyTextArray),
    memoryEnabled: boolean('memory_enabled').notNull().default(false),
    skillIds: text('skill_ids').array().notNull().default(emptyTextArray),
    documentIds: text('document_ids').array().notNull().default(emptyTextArray),
    mcpServerVersionIds: text('mcp_server_version_ids').array().notNull().default(emptyTextArray),
    maxTurns: integer('max_turns').notNull(),
    timeBudgetS: integer('time_budget_s').notNull(),
    /** sha256 of the normalised settings plus the hashes of every referenced resource. */
    configHash: text('config_hash').notNull(),
    changeNote: text('change_note'),
    /** Set once, when the first experiment that uses this version is created. */
    frozenAt: tstz('frozen_at'),
    createdAt: createdAt(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('configuration_versions_config_version_uq').on(t.configurationId, t.version),
    check('configuration_versions_version_ck', sql`${t.version} >= 1`),
    check('configuration_versions_provider_ck', oneOf(t.provider, PROVIDERS)),
    check('configuration_versions_model_ck', sql`${t.model} <> ''`),
    check(
      'configuration_versions_custom_base_url_ck',
      sql`${t.provider} <> 'custom' or ${t.baseUrl} is not null`,
    ),
    check(
      'configuration_versions_base_url_ck',
      // http(s) only, and no user:password@ in the URL: keys live in the worker environment.
      sql`${t.baseUrl} is null or ${t.baseUrl} ~ '^https?://[^/?#@]+([/?#]|$)'`,
    ),
    check(
      'configuration_versions_api_key_env_ck',
      sql`${t.apiKeyEnv} is null or ${t.apiKeyEnv} ~ '^[A-Z_][A-Z0-9_]*$'`,
    ),
    check('configuration_versions_max_turns_ck', sql`${t.maxTurns} between 1 and 200`),
    check('configuration_versions_time_budget_ck', sql`${t.timeBudgetS} between 30 and 3600`),
    check('configuration_versions_hash_ck', isSha256(t.configHash)),
  ],
);
