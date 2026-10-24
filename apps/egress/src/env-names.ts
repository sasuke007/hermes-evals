/**
 * Names of the variables in egress's own environment. Egress holds the values
 * of http MCP headers (plan 5.3), so the worker asks it which names are set
 * and records them on its `workers` row; the Secrets page can then say "set"
 * or "not set" for an egress secret without its value ever leaving this
 * process.
 */

/**
 * The rule for a variable name a definition may reference: ENV_NAME_PATTERN
 * in packages/shared/src/records.ts, repeated here because egress does not
 * depend on the shared package.
 */
export const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Sorted names of the variables that match ENV_NAME_PATTERN and hold a
 * non-empty value. An empty value counts as not set: `VENDOR_API_TOKEN=` in
 * .env gives egress nothing to put in a header. Only names are returned.
 */
export function envNames(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([name, value]) => ENV_NAME_PATTERN.test(name) && Boolean(value))
    .map(([name]) => name)
    .sort();
}
