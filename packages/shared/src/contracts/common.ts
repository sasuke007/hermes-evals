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

/** A pass rate, mean score or confidence: a fraction from 0 to 1. */
export const rateView = z.number().min(0).max(1);

/** A difference of two rates (candidate minus baseline), or an interval bound. */
export const deltaView = z.number().min(-1).max(1);

/** Seconds of wall time; fractional when measured. */
export const secondsView = z.number().nonnegative();

/** Money in US dollars. */
export const usdView = z.number().nonnegative();

/**
 * A spend ceiling in dollars, as launch and resume accept it. The column is
 * numeric(10,2) with CHECK > 0, so anything under a cent would round to a
 * refused 0.
 */
export const spendCeilingUsd = z
  .number()
  .min(0.01, 'the spend ceiling must be at least $0.01')
  .max(10_000, 'the spend ceiling is at most $10,000');

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
