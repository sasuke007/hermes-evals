/**
 * The resources the samples seed adds (Phase 8 G3), each through the
 * service its page uses, so it is checked and stored exactly as an upload
 * or a save would be:
 *
 * - every folder of samples/skills, zipped and sent through the skill
 *   upload's validate and confirm (versions, the content hash, the tree);
 *   skipped when a skill with its name holds the same content;
 * - every file of samples/documents/<suite>/, uploaded as a document;
 *   skipped when one with its file name and sha256 exists;
 * - the two sample MCP servers, as README defines them; skipped when a
 *   server with the name exists, whatever its definition.
 *
 * One sample that fails is reported and the rest go on. Each function
 * returns where it found or put each sample, for the configurations.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { ZipFile } from 'yazl';
import { McpServerInputSchema, type McpServerInput, type SeedItem } from '@hermes-evals/shared';
import { documents, skills } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import type { DocumentsService } from '../resources/documents/documents.service.js';
import type { McpServersService } from '../resources/mcp/mcp-servers.service.js';
import { readSkillMetadata } from '../resources/skills/front-matter.js';
import type { UploadedFileRef } from '../resources/skills/multipart-upload.js';
import { skillContentHash } from '../resources/skills/skill-files.js';
import type { SkillsService } from '../resources/skills/skills.service.js';
import type { BlobStore } from '../storage/blob-store.js';

export interface ResourceSeedDeps {
  db: AppDb;
  storage: BlobStore;
  skills: SkillsService;
  documents: DocumentsService;
  mcpServers: McpServersService;
  /** Takes each item as it is decided: the report and the log. */
  report(item: SeedItem): void;
}

/**
 * The sample MCP servers (plan 18.2 P4), as README and the Phase 6 smoke
 * define them. mcp-v1's tasks and mock scripts name their tools
 * mcp__invoice_db__* and mcp__vendor_directory__*, so the names are fixed.
 */
export const SAMPLE_MCP_SERVERS: readonly McpServerInput[] = [
  {
    name: 'invoice-db',
    transport: 'stdio',
    command: 'invoice-db-mcp',
    args: [],
    envNames: ['INVOICE_DB_URL'],
    url: null,
    headers: [],
    include: [],
    exclude: [],
    timeoutS: 30,
  },
  {
    name: 'vendor-directory',
    transport: 'http',
    command: null,
    args: [],
    envNames: [],
    url: 'http://vendor-directory:8000/mcp',
    headers: [{ header: 'Authorization', env: 'VENDOR_DIRECTORY_TOKEN', prefix: 'Bearer ' }],
    include: [],
    exclude: [],
    timeoutS: 30,
  },
];

/** Why a service refused, as its HTTP answer would say it. */
export function reasonOf(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    if (typeof body === 'string') return body;
    const { message, issues } = body as { message?: unknown; issues?: unknown };
    const text = Array.isArray(message)
      ? message.join('; ')
      : typeof message === 'string'
        ? message
        : err.message;
    const details = Array.isArray(issues)
      ? (issues as { path?: string; message?: string }[]).map((i) =>
          i.path ? `${i.path}: ${i.message}` : String(i.message),
        )
      : [];
    return details.length > 0 ? `${text} (${details.join('; ')})` : text;
  }
  return err instanceof Error ? err.message : String(err);
}

const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex');

/** A file on disk as multer would hand it to the upload handler. */
async function uploadedFile(
  path: string,
  originalname: string,
  mimetype: string,
): Promise<UploadedFileRef> {
  const { size } = await stat(path);
  return {
    fieldname: 'file',
    originalname,
    encoding: '7bit',
    mimetype,
    size,
    destination: '',
    filename: originalname,
    path,
    buffer: Buffer.alloc(0),
    stream: Readable.from([]),
  };
}

/** Folder or file names in `dir`, sorted; none when it does not exist. */
async function entries(dir: string, kind: 'folder' | 'file'): Promise<string[]> {
  let found;
  try {
    found = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return found
    .filter((e) => (kind === 'folder' ? e.isDirectory() : e.isFile()))
    .map((e) => e.name)
    .filter((name) => !name.startsWith('.'))
    .sort();
}

interface SkillFile {
  path: string;
  content: Buffer;
}

/**
 * A skill folder's files as the upload's zip reader keeps them: regular
 * files under their posix paths, macOS metadata left out (zip-reader.ts).
 * Links are left out too; the reader would refuse a zip with one.
 */
async function skillFiles(root: string, prefix = ''): Promise<SkillFile[]> {
  const files: SkillFile[] = [];
  const found = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of found.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name === '.DS_Store' || entry.name === '__MACOSX') continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await skillFiles(root, path)));
    else if (entry.isFile()) files.push({ path, content: await readFile(join(root, path)) });
  }
  return files;
}

async function writeZip(files: readonly SkillFile[], path: string): Promise<void> {
  const zip = new ZipFile();
  for (const file of files) zip.addBuffer(file.content, file.path);
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(path));
}

interface StoredSkill {
  name: string;
  id: string;
}

/** One sample skill: skipped, or validated and confirmed as an upload. Returns its row when stored. */
async function seedSkill(
  deps: ResourceSeedDeps,
  root: string,
  folder: string,
): Promise<StoredSkill | null> {
  const files = await skillFiles(root);
  const skillMd = files.find((f) => f.path === 'SKILL.md');
  const name = (skillMd && readSkillMetadata(skillMd.content).name.value) || folder;
  const hash = skillContentHash(files.map((f) => ({ path: f.path, sha256: sha256(f.content) })));
  const [stored] = await deps.db
    .select({ id: skills.id, version: skills.version })
    .from(skills)
    .where(and(eq(skills.name, name), eq(skills.contentHash, hash)))
    .orderBy(asc(skills.uploadedAt), asc(skills.id))
    .limit(1);
  if (stored) {
    deps.report({
      kind: 'skill',
      name,
      outcome: 'skipped',
      detail: `exists with the same content (version ${stored.version})`,
    });
    return { name, id: stored.id };
  }

  const scratch = await deps.storage.scratchDir('seed-skill');
  try {
    const zip = join(scratch.path, `${folder}.zip`);
    await writeZip(files, zip);
    const check = await deps.skills.validate(
      await uploadedFile(zip, `${folder}.zip`, 'application/zip'),
    );
    if (check.token) {
      const row = await deps.skills.confirm(check.token);
      const beside = check.outcome === 'new_version' && check.existing;
      deps.report({
        kind: 'skill',
        name: row.name,
        outcome: 'created',
        detail: `version ${row.version}${beside ? `, beside ${beside.version}` : ''}`,
      });
      return { name: row.name, id: row.id };
    }
    if (check.outcome === 'conflict' && check.existing?.contentHash === check.contentHash) {
      deps.report({
        kind: 'skill',
        name,
        outcome: 'skipped',
        detail: `exists with the same content (version ${check.existing.version})`,
      });
      return { name, id: check.existing.id };
    }
    const problems = check.problems.map((p) => `${p.title} ${p.detail}`.trim());
    deps.report({
      kind: 'skill',
      name,
      outcome: 'failed',
      detail: problems.join(' ') || `the upload check answered ${check.outcome}`,
    });
    return null;
  } finally {
    await scratch.dispose();
  }
}

/** Every folder of samples/skills. Returns skill name to the id of the row with the sample's content. */
export async function seedSkills(
  deps: ResourceSeedDeps,
  samplesDir: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const root = join(samplesDir, 'skills');
  for (const folder of await entries(root, 'folder')) {
    try {
      const stored = await seedSkill(deps, join(root, folder), folder);
      if (stored) ids.set(stored.name, stored.id);
    } catch (err) {
      deps.report({ kind: 'skill', name: folder, outcome: 'failed', detail: reasonOf(err) });
    }
  }
  return ids;
}

/** Every file of samples/documents/<suite>/. Returns `<suite>/<file>` to its document's id. */
export async function seedDocuments(
  deps: ResourceSeedDeps,
  samplesDir: string,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const root = join(samplesDir, 'documents');
  for (const suite of await entries(root, 'folder')) {
    for (const file of await entries(join(root, suite), 'file')) {
      const name = `${suite}/${file}`;
      try {
        const path = join(root, suite, file);
        const [stored] = await deps.db
          .select({ id: documents.id })
          .from(documents)
          .where(
            and(eq(documents.filename, file), eq(documents.sha256, sha256(await readFile(path)))),
          )
          .orderBy(asc(documents.uploadedAt), asc(documents.id))
          .limit(1);
        if (stored) {
          deps.report({
            kind: 'document',
            name,
            outcome: 'skipped',
            detail: 'exists with the same name and content',
          });
          ids.set(name, stored.id);
          continue;
        }
        // The type a browser sends for a file it does not know; the service reads the content.
        const row = await deps.documents.upload(
          await uploadedFile(path, file, 'application/octet-stream'),
        );
        deps.report({ kind: 'document', name, outcome: 'created', detail: row.typeLabel });
        ids.set(name, row.id);
      } catch (err) {
        deps.report({ kind: 'document', name, outcome: 'failed', detail: reasonOf(err) });
      }
    }
  }
  return ids;
}

/** The two sample MCP servers. Returns each server's name to its latest version's id. */
export async function seedMcpServers(deps: ResourceSeedDeps): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const stored = new Map((await deps.mcpServers.list()).map((row) => [row.name, row]));
  for (const definition of SAMPLE_MCP_SERVERS) {
    const name = definition.name;
    const existing = stored.get(name);
    if (existing) {
      deps.report({
        kind: 'mcp_server',
        name,
        outcome: 'skipped',
        detail: `exists (version ${existing.version}); its definition is left as it is`,
      });
      ids.set(name, existing.versionId);
      continue;
    }
    try {
      const row = await deps.mcpServers.create(McpServerInputSchema.parse(definition));
      deps.report({ kind: 'mcp_server', name, outcome: 'created', detail: row.transport });
      ids.set(name, row.versionId);
    } catch (err) {
      deps.report({ kind: 'mcp_server', name, outcome: 'failed', detail: reasonOf(err) });
    }
  }
  return ids;
}
