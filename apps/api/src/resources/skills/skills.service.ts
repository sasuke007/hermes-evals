/**
 * Skills: the two-step upload (validate, then confirm) and reading stored
 * skills (plan 5.1, UI_FLOWS 9.1).
 *
 * A stored skill is a skills row plus its unpacked tree at
 * DATA_DIR/skills/<content_hash>/. Trees are content-addressed, so two rows
 * with the same content would share one, and a tree is never changed or
 * removed while a row names it. Confirm renames the validated tree into
 * place (same volume, so atomic) inside the transaction that inserts the
 * row: the row commits only once the tree is there.
 */
import { constants } from 'node:fs';
import { mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import type {
  ConfigurationLink,
  SkillDetail,
  SkillFileContent,
  SkillRow,
  SkillUploadValidation,
} from '@hermes-evals/shared';
import { asc, count, desc, eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { ZipFile } from 'yazl';
import { DB } from '../../database/db.provider.js';
import { skills } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { StorageService } from '../../storage/storage.service.js';
import { deleteUnused, latestConfigurationLinks } from './configuration-links.js';
import { uploadFileName } from './format.js';
import {
  MAX_SKILL_MD_BYTES,
  readSkillMetadata,
  type SkillMetadata,
  skillMdTooLarge,
  splitFrontMatter,
} from './front-matter.js';
import { conflict, gone, notFound } from './http.js';
import type { UploadedFileRef } from './multipart-upload.js';
import {
  listSkillFiles,
  openSkillFileStream,
  readSkillFile,
  skillContentHash,
  syncTree,
} from './skill-files.js';
import { SkillUploadStore } from './skill-uploads.js';
import { buildValidation } from './skill-validation.js';
import { type UnpackedFile, unpackSkillZip } from './zip-reader.js';

type SkillRecord = typeof skills.$inferSelect;

const errorCode = (err: unknown): string | undefined => (err as { code?: string }).code;

/** A unique violation, as node-postgres or PGlite report it under Drizzle's wrapper. */
const isUniqueViolation = (err: unknown): boolean =>
  errorCode(err) === '23505' || errorCode((err as { cause?: unknown }).cause) === '23505';

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    throw err;
  }
}

/** fsyncs a directory so a rename into it is durable. */
async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function toSkillRow(row: SkillRecord, usedBy: ConfigurationLink[]): SkillRow {
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    description: row.description,
    contentHash: row.contentHash,
    fileCount: row.fileCount,
    unpackedBytes: row.sizeBytes,
    uploadedAt: row.uploadedAt.toISOString(),
    usedBy,
  };
}

@Injectable()
export class SkillsService {
  /** DATA_DIR/skills */
  readonly skillsDir: string;

  constructor(
    @Inject(DB) private readonly db: AppDb,
    storage: StorageService,
    private readonly uploads: SkillUploadStore,
    private readonly logger: PinoLogger,
  ) {
    this.skillsDir = join(storage.dataDir, 'skills');
    this.logger.setContext(SkillsService.name);
  }

  /** Where a stored skill's files are. */
  treePath(contentHash: string): string {
    return join(this.skillsDir, contentHash);
  }

  /**
   * The dry run: unpacks and checks the zip, reads SKILL.md, and compares
   * name and version with the stored skills. Stores nothing; an upload that
   * can be confirmed waits under its token until it expires.
   */
  async validate(upload: UploadedFileRef): Promise<SkillUploadValidation> {
    await this.uploads.sweepQuietly();
    const pending = await this.uploads.begin();
    try {
      const archive = await unpackSkillZip(upload.path, pending.tree);
      const metadata = archive.ok ? await this.readMetadata(pending.tree, archive.files) : null;
      const contentHash = archive.ok ? skillContentHash(archive.files) : null;
      const name = metadata?.name.ok ? metadata.name.value : null;
      const stored = name
        ? await this.db
            .select({
              id: skills.id,
              version: skills.version,
              contentHash: skills.contentHash,
              uploadedAt: skills.uploadedAt,
            })
            .from(skills)
            .where(eq(skills.name, name))
        : [];
      const report = buildValidation({
        fileName: uploadFileName(upload.originalname, 'skill.zip'),
        sizeBytes: upload.size,
        archive,
        metadata,
        contentHash,
        stored,
        token: pending.token,
      });
      const { name: n, version, description, contentHash: hash } = report;
      if (report.token && n && version && description && hash) {
        await this.uploads.commit(pending, {
          name: n,
          version,
          description,
          contentHash: hash,
          fileCount: report.fileTree.length,
          unpackedBytes: report.unpackedBytes,
        });
      } else {
        await pending.dispose();
      }
      return report;
    } catch (err) {
      await pending.dispose();
      throw err;
    }
  }

  /**
   * Stores a validated upload: 404 for a token never issued, 410 once it
   * expired, 409 when the same name and version was stored meanwhile.
   */
  async confirm(token: string): Promise<SkillRow> {
    const found = await this.uploads.lookup(token);
    if (found.state === 'unknown')
      throw notFound('no skill upload has this token; validate the zip again');
    if (found.state === 'expired') throw gone('this skill upload expired; validate the zip again');
    const { manifest } = found;
    // fsync outside the transaction; it is idempotent if the insert then fails.
    if (
      (await isDirectory(found.tree)) &&
      !(await isDirectory(this.treePath(manifest.contentHash)))
    ) {
      await syncTree(found.tree);
    }
    let row: SkillRecord;
    try {
      row = await this.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(skills)
          .values({
            name: manifest.name,
            version: manifest.version,
            description: manifest.description,
            contentHash: manifest.contentHash,
            fileCount: manifest.fileCount,
            sizeBytes: manifest.unpackedBytes,
          })
          .returning();
        await this.placeTree(found.tree, manifest.contentHash);
        return inserted!;
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      await this.uploads.remove(token);
      throw conflict(
        `${manifest.name} ${manifest.version} was stored while this upload waited; validate the zip again`,
      );
    }
    await this.uploads.remove(token);
    this.logger.info(
      { skillId: row.id, name: row.name, version: row.version, contentHash: row.contentHash },
      'stored skill',
    );
    return toSkillRow(row, []);
  }

  /** Every stored skill version, by name and newest version first. */
  async list(): Promise<SkillRow[]> {
    const rows = await this.db
      .select()
      .from(skills)
      .orderBy(asc(skills.name), desc(skills.uploadedAt), asc(skills.id));
    const links = await latestConfigurationLinks(this.db, 'skillIds');
    return rows.map((row) => toSkillRow(row, links.get(row.id) ?? []));
  }

  async count(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(skills);
    return row?.n ?? 0;
  }

  /** The row, its file tree, SKILL.md split into front matter and body, and "Used by". */
  async detail(id: string): Promise<SkillDetail> {
    const row = await this.get(id);
    const root = await this.storedTree(row);
    const [files, skillMd, links] = await Promise.all([
      listSkillFiles(root),
      readSkillFile(root, 'SKILL.md'),
      latestConfigurationLinks(this.db, 'skillIds', [row.id]),
    ]);
    const text = skillMd.content ?? '';
    return {
      ...toSkillRow(row, links.get(row.id) ?? []),
      files: files.map((f) => ({ path: f.path, sizeBytes: f.size, kind: f.kind })),
      skillMd: splitFrontMatter(text) ?? { frontMatter: '', body: text },
    };
  }

  /** One file of a stored skill; `path` must be one the tree walk lists. */
  async file(id: string, path: string): Promise<SkillFileContent> {
    const row = await this.get(id);
    const root = await this.storedTree(row);
    const files = await listSkillFiles(root);
    if (!files.some((f) => f.path === path)) {
      throw notFound(`skill ${row.name} ${row.version} has no file ${path}`);
    }
    const read = await readSkillFile(root, path);
    return {
      path,
      kind: read.kind,
      sizeBytes: read.size,
      content: read.content,
      sha256: read.sha256,
    };
  }

  /** The stored tree as a zip stream, built while it is sent. */
  async zip(id: string): Promise<{ stream: Readable; filename: string }> {
    const row = await this.get(id);
    const root = await this.storedTree(row);
    const files = await listSkillFiles(root);
    const zip = new ZipFile();
    const output = zip.outputStream as Readable;
    zip.on('error', (err: Error) => output.destroy(err));
    for (const file of files) {
      zip.addReadStreamLazy(
        file.path,
        { mtime: row.uploadedAt, mode: 0o100644, size: file.size },
        (callback) => {
          openSkillFileStream(root, file.path).then(
            (stream) => callback(null, stream),
            (err: unknown) => callback(err, null as unknown as NodeJS.ReadableStream),
          );
        },
      );
    }
    zip.end();
    return { stream: output, filename: `${row.name}-${row.version}.zip` };
  }

  /**
   * DELETE /resources/skills/:id: only a skill no configuration version
   * names (409 with them otherwise). The row goes; the tree under
   * DATA_DIR/skills stays, since a confirm of the same content may be
   * reusing it at this moment, and no run can need it any more.
   */
  async remove(id: string): Promise<void> {
    const row = await this.get(id);
    await deleteUnused(
      this.db,
      { column: 'skillIds', id, what: `skill ${row.name} ${row.version}` },
      async () =>
        (await this.db.delete(skills).where(eq(skills.id, id)).returning({ id: skills.id }))
          .length > 0,
    );
    this.logger.info({ skillId: id, name: row.name, version: row.version }, 'deleted skill');
  }

  /** SKILL.md's metadata, without reading a SKILL.md over the cap. */
  private async readMetadata(tree: string, files: UnpackedFile[]): Promise<SkillMetadata> {
    const size = files.find((f) => f.path === 'SKILL.md')?.size ?? 0;
    if (size > MAX_SKILL_MD_BYTES) return skillMdTooLarge();
    return readSkillMetadata(await readFile(join(tree, 'SKILL.md')));
  }

  private async get(id: string): Promise<SkillRecord> {
    const [row] = await this.db.select().from(skills).where(eq(skills.id, id));
    if (!row) throw notFound(`skill ${id} not found`);
    return row;
  }

  private async storedTree(row: SkillRecord): Promise<string> {
    const root = this.treePath(row.contentHash);
    if (!(await isDirectory(root))) {
      throw new InternalServerErrorException({
        statusCode: 500,
        message: `the files of skill ${row.name} ${row.version} are missing from DATA_DIR/skills`,
      });
    }
    return root;
  }

  /**
   * Moves a validated tree to DATA_DIR/skills/<hash>. A tree already there
   * has this exact content (it is named by its hash), so it is reused, which
   * also makes a retried confirm succeed after a failed commit moved the tree.
   */
  private async placeTree(tree: string, contentHash: string): Promise<void> {
    const target = this.treePath(contentHash);
    await mkdir(this.skillsDir, { recursive: true });
    if (await isDirectory(target)) return;
    try {
      await rename(tree, target);
    } catch (err) {
      const code = errorCode(err);
      if ((code === 'ENOTEMPTY' || code === 'EEXIST') && (await isDirectory(target))) return;
      if (code === 'ENOENT')
        throw gone('this skill upload is no longer available; validate the zip again');
      throw err;
    }
    await syncDir(this.skillsDir);
  }
}
