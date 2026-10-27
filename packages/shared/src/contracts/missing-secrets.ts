/**
 * Unset MCP variables at launch (Phase 6 S7): which variable a chosen
 * configuration's MCP servers need that the service reading it lacks, the
 * sentences New experiment and the launch 409 give, and that 409's body.
 * Split from ./new-experiment.ts in Phase 8.
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { ENV_NAME_PATTERN } from '../records.js';
import { MCP_TRANSPORTS } from '../vocab.js';
import { ApiErrorBodySchema } from './common.js';

/**
 * One variable an MCP server version of a configuration names that the
 * service reading it does not have (Phase 5 decision #13, Phase 6 S7): a
 * stdio env name the live worker's environment lacks, or an http header
 * variable egress's lacks (the names GET /resources/secrets reports). With
 * no live worker every name is unset: nothing can vouch for it. Names only.
 */
export const MissingMcpSecretSchema = z.object({
  /** The MCP server's name. */
  server: z.string(),
  /** The variable, e.g. VENDOR_DIRECTORY_TOKEN. */
  name: z.string().regex(ENV_NAME_PATTERN),
  /** stdio: the worker reads it; http: egress reads it and adds the header. */
  transport: z.enum(MCP_TRANSPORTS),
});
export type MissingMcpSecret = z.infer<typeof MissingMcpSecretSchema>;

/** "VENDOR_DIRECTORY_TOKEN (vendor-directory, added by egress)". */
export const missingSecretText = (s: MissingMcpSecret): string =>
  `${s.name} (${s.server}, ${s.transport === 'stdio' ? 'read by the worker' : 'added by egress'})`;

/**
 * Why a configuration cannot launch, as New experiment shows it under the
 * configuration and as Launch's disabled reason, and as the launch 409
 * words it: "with-mcp: VENDOR_DIRECTORY_TOKEN (vendor-directory, added by
 * egress) is not set". Empty `missing` gives an empty string.
 */
export function missingSecretsReason(
  configuration: string,
  missing: readonly MissingMcpSecret[],
): string {
  if (missing.length === 0) return '';
  const names = missing.map(missingSecretText);
  const list =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${configuration}: ${list} ${missing.length === 1 ? 'is' : 'are'} not set`;
}

/** What the launch 409 asks the user to do about unset MCP variables. */
export const MISSING_SECRETS_HINT =
  'Set each in .env, then recreate the worker (stdio) or egress (http) so it reads them.';

/**
 * The launch 409's message: each configuration's missingSecretsReason, in
 * the order given (baseline first), joined with "; ", then
 * MISSING_SECRETS_HINT. Configurations with nothing missing are left out.
 */
export function missingSecretsConflictMessage(
  byConfiguration: ReadonlyArray<{ configuration: string; missing: readonly MissingMcpSecret[] }>,
): string {
  const reasons = byConfiguration
    .filter((c) => c.missing.length > 0)
    .map((c) => missingSecretsReason(c.configuration, c.missing));
  return `${reasons.join('; ')}. ${MISSING_SECRETS_HINT}`;
}

/**
 * The 409 of POST /experiments when a chosen configuration's MCP servers
 * name variables that are not set (Phase 6 S7), checked after the worker and
 * provider gates. `message` is missingSecretsConflictMessage. One issue per
 * unset variable:
 * `path` is the body field that chose the configuration (`baselineVersionId`
 * or `candidateVersionIds.<i>`) and `message` is its missingSecretText.
 */
export const MissingSecretsConflictSchema = ApiErrorBodySchema.extend({
  statusCode: z.literal(409),
  issues: z
    .array(
      z.object({
        path: z.string().regex(/^(baselineVersionId|candidateVersionIds\.\d+)$/),
        message: z.string().min(1),
      }),
    )
    .min(1),
});
export type MissingSecretsConflict = z.infer<typeof MissingSecretsConflictSchema>;
