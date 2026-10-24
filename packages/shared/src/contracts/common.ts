/**
 * Building blocks of the API view models in this folder.
 *
 * Conventions for every contract file:
 * - camelCase fields; ids are opaque strings; timestamps are ISO-8601 strings;
 *   sha256 values are full 64-character lowercase hex (pages shorten them).
 * - Durations carry their unit in the name (`durationS`, `durationMs`).
 * - Status strings are the shared vocabularies from this package.
 * - Every response the API sends parses with its schema here, and the web
 *   fixtures do too (apps/web/src/api/__tests__/contracts.spec.ts).
 */
import { z } from 'zod';

/** An ISO-8601 time. Not checked further: the web fixtures carry no offset, live data does. */
export const isoTimeView = z.string();

export const sha256View = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase sha256 hex');

export const countView = z.number().int().nonnegative();

/**
 * An http(s) URL without `user:password@`, the same rule as the url and
 * base_url CHECK constraints: credentials belong in the environment.
 */
export const HTTP_URL_PATTERN = /^https?:\/\/[^/?#@\s]+(?:[/?#]\S*)?$/;

/** Names of configurations and MCP servers: lowercase slug, the CHECK constraint's rule. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** True when no value repeats. */
export const isUnique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

/**
 * The body of every error the API answers (plan 11): the HTTP status again,
 * a sentence for the reader and, for a request that failed validation, one
 * issue per problem with its dotted path (`headers.0.env`).
 */
export const ApiErrorBodySchema = z.object({
  statusCode: z.number().int().min(400).max(599),
  message: z.string(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
