/**
 * The resources a configuration version names by id: skills, documents and
 * MCP definitions. Postgres cannot put foreign keys on array elements, so
 * the 0001 trigger checks the ids exist on every save; this module checks
 * them first so a save can answer 400 naming each missing reference, and
 * adds the rules that keep one trial home consistent (one version per MCP
 * server, per skill name and per document filename).
 */
import { BadRequestException } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type { DocumentRef, SkillRef } from '@hermes-evals/shared';
import { documents, mcpServers, mcpServerVersions, skills } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import type { ResolvedMcpServer } from './settings.js';

/** The three id lists a version stores. */
export interface ReferenceIds {
  skillIds: readonly string[];
  documentIds: readonly string[];
  mcpServerVersionIds: readonly string[];
}

/** Resource rows by id, as the views and the hash need them. */
export interface ResourceIndex {
  skills: Map<string, SkillRef>;
  documents: Map<string, DocumentRef>;
  mcpServers: Map<string, ResolvedMcpServer>;
}

/** One problem with a request field, in the ZodValidationPipe's issue shape. */
export interface FieldIssue {
  path: string;
  message: string;
}

/** 400 with the issues listed and named in the message, so the form can show it as is. */
export function invalidFields(issues: readonly FieldIssue[]): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: issues.map((i) => i.message).join('; '),
    issues,
  });
}

const unique = (ids: Iterable<string>): string[] => [...new Set(ids)];

/** Loads every skill, document and MCP definition the given id lists name, in one query each. */
export async function loadResources(
  db: AppDb,
  refs: readonly ReferenceIds[],
): Promise<ResourceIndex> {
  const skillIds = unique(refs.flatMap((r) => r.skillIds));
  const documentIds = unique(refs.flatMap((r) => r.documentIds));
  const mcpIds = unique(refs.flatMap((r) => r.mcpServerVersionIds));
  // One query at a time: callers pass a transaction, which is one connection.
  const skillRows =
    skillIds.length === 0
      ? []
      : await db
          .select({
            skillId: skills.id,
            name: skills.name,
            version: skills.version,
            contentHash: skills.contentHash,
          })
          .from(skills)
          .where(inArray(skills.id, skillIds));
  const documentRows =
    documentIds.length === 0
      ? []
      : await db
          .select({
            documentId: documents.id,
            filename: documents.filename,
            sizeBytes: documents.size,
            sha256: documents.sha256,
          })
          .from(documents)
          .where(inArray(documents.id, documentIds));
  const mcpRows =
    mcpIds.length === 0
      ? []
      : await db
          .select({
            mcpServerId: mcpServerVersions.mcpServerId,
            versionId: mcpServerVersions.id,
            name: mcpServers.name,
            version: mcpServerVersions.version,
            transport: mcpServerVersions.transport,
            definitionHash: mcpServerVersions.definitionHash,
          })
          .from(mcpServerVersions)
          .innerJoin(mcpServers, eq(mcpServers.id, mcpServerVersions.mcpServerId))
          .where(inArray(mcpServerVersions.id, mcpIds));
  return {
    skills: new Map(skillRows.map((r) => [r.skillId, r])),
    documents: new Map(documentRows.map((r) => [r.documentId, r])),
    mcpServers: new Map(mcpRows.map((r) => [r.versionId, r])),
  };
}

/** The resources of one version, in its stored order. */
export interface ResolvedResources {
  skills: SkillRef[];
  documents: DocumentRef[];
  mcpServers: ResolvedMcpServer[];
}

/**
 * Picks one version's resources out of an index. A stored version always
 * resolves (the trigger checked its ids and resources are never deleted), so
 * a miss here is corruption and fails loudly rather than dropping an entry.
 */
export function pickResources(index: ResourceIndex, ids: ReferenceIds): ResolvedResources {
  const pick = <T>(map: Map<string, T>, list: readonly string[], what: string): T[] =>
    list.map((id) => {
      const found = map.get(id);
      if (found === undefined) throw new Error(`${what} ${id} is referenced but does not exist`);
      return found;
    });
  return {
    skills: pick(index.skills, ids.skillIds, 'skill'),
    documents: pick(index.documents, ids.documentIds, 'document'),
    mcpServers: pick(index.mcpServers, ids.mcpServerVersionIds, 'MCP server version'),
  };
}

/** Names that occur more than once, each once, in first-seen order. */
function repeated<T>(items: readonly T[], keyOf: (item: T) => string): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) twice.add(key);
    seen.add(key);
  }
  return [...twice];
}

/**
 * Holds the MCP definitions a save names until it commits. The save hashes
 * each definition_hash into config_hash, and its insert freezes those
 * versions (0001 trigger); an in-place MCP edit committing in between would
 * leave the frozen row and the hash disagreeing. The locks follow the MCP
 * edit's order, servers then versions: servers FOR SHARE (a save never writes
 * them), versions FOR NO KEY UPDATE in id order (the freeze writes them, and
 * two saves sharing a version must queue rather than deadlock on it).
 * Meaningful inside the save's transaction, which is where it is called.
 */
async function lockMcpDefinitions(db: AppDb, versionIds: readonly string[]): Promise<void> {
  const ids = unique(versionIds);
  if (ids.length === 0) return;
  // A version's server never changes (0001 guards its identity), so this read needs no lock.
  const owners = await db
    .select({ serverId: mcpServerVersions.mcpServerId })
    .from(mcpServerVersions)
    .where(inArray(mcpServerVersions.id, ids));
  const serverIds = unique(owners.map((o) => o.serverId));
  if (serverIds.length > 0) {
    await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(inArray(mcpServers.id, serverIds))
      .orderBy(asc(mcpServers.id))
      .for('share');
  }
  await db
    .select({ id: mcpServerVersions.id })
    .from(mcpServerVersions)
    .where(inArray(mcpServerVersions.id, ids))
    .orderBy(asc(mcpServerVersions.id))
    .for('no key update');
}

/**
 * Resolves the ids a save sends, or throws 400 naming every problem:
 * - an id that does not exist;
 * - two versions of one MCP server (the 0001 trigger refuses it too);
 * - two versions of one skill, which would share home/skills/<name>/;
 * - two documents with one filename, which would share workspace/docs/<filename>.
 */
export async function resolveForSave(db: AppDb, ids: ReferenceIds): Promise<ResolvedResources> {
  await lockMcpDefinitions(db, ids.mcpServerVersionIds);
  const index = await loadResources(db, [ids]);
  const issues: FieldIssue[] = [];
  const missing = (
    path: string,
    what: string,
    list: readonly string[],
    map: Map<string, unknown>,
  ) => {
    for (const id of list) {
      if (!map.has(id)) issues.push({ path, message: `${what} ${id} does not exist` });
    }
  };
  missing('skillIds', 'skill', ids.skillIds, index.skills);
  missing('documentIds', 'document', ids.documentIds, index.documents);
  missing('mcpServerVersionIds', 'MCP server version', ids.mcpServerVersionIds, index.mcpServers);
  if (issues.length > 0) throw invalidFields(issues);

  const resolved = pickResources(index, ids);
  for (const name of repeated(resolved.mcpServers, (m) => m.name)) {
    const versions = resolved.mcpServers.filter((m) => m.name === name).map((m) => `v${m.version}`);
    issues.push({
      path: 'mcpServerVersionIds',
      message: `MCP server ${name} is included twice (${versions.join(', ')}); a configuration uses one version of each server`,
    });
  }
  for (const name of repeated(resolved.skills, (s) => s.name)) {
    const versions = resolved.skills.filter((s) => s.name === name).map((s) => s.version);
    issues.push({
      path: 'skillIds',
      message: `skill ${name} is included twice (${versions.join(', ')}); a configuration uses one version of each skill`,
    });
  }
  for (const filename of repeated(resolved.documents, (d) => d.filename)) {
    issues.push({
      path: 'documentIds',
      message: `two documents are named ${filename}; each is copied to workspace/docs/<filename>, so names must differ`,
    });
  }
  if (issues.length > 0) throw invalidFields(issues);
  return resolved;
}
