/**
 * Launch's MCP secrets gate (Phase 5 decision #13, Phase 6 S7): a chosen
 * configuration whose MCP server versions name a variable the reading
 * service lacks (a stdio env name the worker lacks, an http header variable
 * egress lacks) would only fail each run at setup, so launch answers 409
 * naming every such variable with its server, the way New experiment shows
 * it under the configuration before Launch.
 */
import { ConflictException } from '@nestjs/common';
import {
  missingSecretsConflictMessage,
  missingSecretText,
  type MissingMcpSecret,
  type MissingSecretsConflict,
} from '@hermes-evals/shared';
import type { VersionPair } from '../../configurations/views.js';

/** The launch body's field that chose the i-th version (baseline first). */
const pathOf = (i: number): string =>
  i === 0 ? 'baselineVersionId' : `candidateVersionIds.${i - 1}`;

/**
 * The 409 for `versions` (baseline, then the candidates in the body's
 * order) given what unsetMcpVariablesByVersion found for each, or null when
 * nothing is missing. One issue per unset variable, on the field that chose
 * its configuration.
 */
export function missingSecretsConflict(
  versions: readonly VersionPair[],
  unset: ReadonlyMap<string, readonly MissingMcpSecret[]>,
): ConflictException | null {
  const chosen = versions.map(({ configuration, row }, i) => ({
    path: pathOf(i),
    configuration: configuration.name,
    missing: unset.get(row.id) ?? [],
  }));
  const issues = chosen.flatMap(({ path, missing }) =>
    missing.map((s) => ({ path, message: missingSecretText(s) })),
  );
  if (issues.length === 0) return null;
  const body: MissingSecretsConflict = {
    statusCode: 409,
    message: missingSecretsConflictMessage(chosen),
    issues,
  };
  return new ConflictException(body);
}
