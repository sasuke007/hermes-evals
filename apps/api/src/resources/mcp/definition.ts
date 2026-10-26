/**
 * An MCP server definition as the platform stores and hashes it, and the rule
 * that decides what saving an edit does (plan 5.3, UI_FLOWS 9.3).
 *
 * The definition names environment variables and headers, never values, so
 * everything here is safe to hash, store, log and return.
 */
import { createHash } from 'node:crypto';
import { canonicalMcpHeaders, type McpHeader, type McpServerInput } from '@hermes-evals/shared';
import { canonicalJson } from '../../queue/queues.js';
import type { mcpServerVersions } from '../../database/schema/index.js';

type VersionRow = typeof mcpServerVersions.$inferSelect;

/**
 * A header pair as stored and sent: `{ header, env }` plus `prefix` only
 * when there is one (Phase 7), so a pair saved without a prefix stays
 * exactly what it was before prefixes existed.
 */
export function headerPair(h: McpHeader): McpHeader {
  return {
    header: h.header,
    env: h.env,
    ...(h.prefix !== undefined ? { prefix: h.prefix } : {}),
  };
}

/** The definition fields of a stored version, in the shape the form sends. */
export function definitionOf(name: string, v: VersionRow): McpServerInput {
  return {
    name,
    transport: v.transport,
    command: v.command,
    args: v.args,
    envNames: v.envNames,
    url: v.url,
    headers: v.headers.map(headerPair),
    include: v.include,
    exclude: v.exclude,
    timeoutS: v.timeoutS,
  };
}

/** The columns of mcp_server_versions a definition fills. */
export function versionColumns(def: McpServerInput) {
  return {
    transport: def.transport,
    command: def.command,
    args: def.args,
    envNames: def.envNames,
    url: def.url,
    headers: def.headers.map(headerPair),
    include: def.include,
    exclude: def.exclude,
    timeoutS: def.timeoutS,
    definitionHash: definitionHash(def),
  };
}

const sorted = (values: readonly string[]): string[] => [...values].sort();

/**
 * sha256 of the definition in canonical form. It feeds the configuration
 * hash, so it covers everything Hermes is given for this server, including
 * the name (the `-t` alias and config.yaml key). Lists whose order means
 * nothing to Hermes (env names, headers, tool filters) are sorted first, so
 * reordering them is not a change; args keep their order. Header names are
 * compared case-insensitively, as HTTP does. A header's prefix is covered
 * only when it has one (canonicalMcpHeaders), so a definition saved before
 * prefixes existed keeps its hash, and with it its version (Phase 7).
 */
export function definitionHash(def: McpServerInput): string {
  const canonical = {
    name: def.name,
    transport: def.transport,
    command: def.command,
    args: def.args,
    envNames: sorted(def.envNames),
    url: def.url,
    headers: canonicalMcpHeaders(def.headers),
    include: sorted(def.include),
    exclude: sorted(def.exclude),
    timeoutS: def.timeoutS,
  };
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}

/** What the server's latest version looks like when an edit arrives. */
export interface LatestVersion {
  /** Its definition, under the server's current name. */
  definition: McpServerInput;
  version: number;
  definitionHash: string;
  /** A configuration version uses it, so it can no longer change. */
  frozen: boolean;
}

/**
 * What saving `next` over `latest` does:
 * - `refuse_rename`: the name is the alias configurations know the server
 *   by, so it may change only while no configuration has used any version.
 * - `unchanged`: saved exactly as stored, or a frozen definition saved with
 *   nothing that matters changed (a reorder of env names, say).
 * - `in_place`: the definition is not frozen, so the version is rewritten.
 *   Its last test describes the old definition, so it is reset when the
 *   hash changed (a reorder keeps it).
 * - `new_version`: the definition is frozen; configurations on it keep it,
 *   and the edit becomes version n + 1, the server's new latest.
 */
export type EditPlan =
  | { kind: 'refuse_rename' }
  | { kind: 'unchanged' }
  | { kind: 'in_place'; definitionHash: string; resetTest: boolean }
  | { kind: 'new_version'; version: number; definitionHash: string };

export function planEdit(latest: LatestVersion, next: McpServerInput): EditPlan {
  // Version n + 1 exists only because version n froze, so a server past
  // version 1 has a frozen version even when its latest is not.
  const nameFixed = latest.frozen || latest.version > 1;
  if (next.name !== latest.definition.name && nameFixed) return { kind: 'refuse_rename' };
  if (canonicalJson(next) === canonicalJson(latest.definition)) return { kind: 'unchanged' };
  const hash = definitionHash(next);
  const changed = hash !== latest.definitionHash;
  if (!latest.frozen) return { kind: 'in_place', definitionHash: hash, resetTest: changed };
  if (!changed) return { kind: 'unchanged' };
  return { kind: 'new_version', version: latest.version + 1, definitionHash: hash };
}
