/**
 * Documents: reference files a configuration copies into every run's
 * workspace/docs/ (plan 5.2, UI_FLOWS 9.2). The content lives in the blob
 * store by sha256; a documents row names it with the uploaded file name and
 * media type. Rows never change. Uploading the same content twice makes two
 * rows over one blob.
 *
 * The type label ("PDF · 6 pages") is not a column: it is derived from the
 * content, which never changes, so it is computed once per blob and media
 * type and cached for the life of the process.
 */
import type { ReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import type { ConfigurationLink, DocumentRow } from '@hermes-evals/shared';
import { asc, count, desc, eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import pLimit from 'p-limit';
import { DB } from '../../database/db.provider.js';
import { documents } from '../../database/schema/index.js';
import type { AppDb } from '../../database/types.js';
import { StorageService } from '../../storage/storage.service.js';
import { latestConfigurationLinks } from '../skills/configuration-links.js';
import { uploadFileName } from '../skills/format.js';
import { notFound } from '../skills/http.js';
import type { UploadedFileRef } from '../skills/multipart-upload.js';
import { documentTypeLabel, mediaTypeFor, sizeTypeLabel } from './type-label.js';

type DocumentRecord = typeof documents.$inferSelect;

/** Labels kept in memory; beyond this the oldest are dropped and recomputed on demand. */
const LABEL_CACHE_SIZE = 1000;
/** Blobs read at once to label a list. */
const LABEL_READS = 4;

/** Media types a browser may show in place: they cannot run script on the API's origin. */
const INLINE_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/markdown',
  'text/csv',
]);

async function readHead(path: string, bytes: number): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(head, 0, bytes, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** What GET /resources/documents/:id/content sends. */
export interface DocumentContent {
  stream: ReadStream;
  filename: string;
  /** Content-Type, with a charset for text. */
  contentType: string;
  size: number;
  disposition: 'inline' | 'attachment';
}

@Injectable()
export class DocumentsService {
  private readonly labels = new Map<string, string>();

  constructor(
    @Inject(DB) private readonly db: AppDb,
    private readonly storage: StorageService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DocumentsService.name);
  }

  /** Stores an uploaded file in the blob store and inserts its documents row. */
  async upload(file: UploadedFileRef): Promise<DocumentRow> {
    const filename = uploadFileName(file.originalname, 'document');
    const mediaType = mediaTypeFor(filename, await readHead(file.path, 64), file.mimetype);
    const typeLabel = await documentTypeLabel(file.path, mediaType, file.size, filename);
    const ref = await this.storage.putFile(file.path);
    const row = await this.db.transaction(async (tx) => {
      await this.storage.recordBlob(tx, ref);
      const [inserted] = await tx
        .insert(documents)
        .values({ filename, mime: mediaType, size: ref.size, sha256: ref.sha256 })
        .returning();
      return inserted!;
    });
    this.remember(row, typeLabel);
    this.logger.info(
      { documentId: row.id, filename, mediaType, size: row.size, sha256: row.sha256 },
      'stored document',
    );
    return this.toRow(row, []);
  }

  /** Every document, by file name and newest first. */
  async list(): Promise<DocumentRow[]> {
    const rows = await this.db
      .select()
      .from(documents)
      .orderBy(asc(documents.filename), desc(documents.uploadedAt), asc(documents.id));
    const links = await latestConfigurationLinks(this.db, 'documentIds');
    // Labels not cached yet (after a restart) read their blobs; a few at a time.
    const limit = pLimit(LABEL_READS);
    return Promise.all(rows.map((row) => limit(() => this.toRow(row, links.get(row.id) ?? []))));
  }

  async count(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(documents);
    return row?.n ?? 0;
  }

  /** The stored file of a document, with the headers to send it with. */
  async content(id: string): Promise<DocumentContent> {
    const row = await this.get(id);
    if (!(await this.storage.exists(row.sha256))) {
      throw new InternalServerErrorException({
        statusCode: 500,
        message: `the content of document ${row.filename} is missing from the blob store`,
      });
    }
    return {
      stream: this.storage.stream(row.sha256),
      filename: row.filename,
      contentType: row.mime.startsWith('text/') ? `${row.mime}; charset=utf-8` : row.mime,
      size: row.size,
      disposition: INLINE_TYPES.has(row.mime) ? 'inline' : 'attachment',
    };
  }

  private async get(id: string): Promise<DocumentRecord> {
    const [row] = await this.db.select().from(documents).where(eq(documents.id, id));
    if (!row) throw notFound(`document ${id} not found`);
    return row;
  }

  private labelKey = (row: DocumentRecord) => `${row.sha256}:${row.mime}:${row.filename}`;

  private remember(row: DocumentRecord, label: string): void {
    this.labels.delete(this.labelKey(row));
    this.labels.set(this.labelKey(row), label);
    while (this.labels.size > LABEL_CACHE_SIZE) {
      const oldest = this.labels.keys().next().value;
      if (oldest === undefined) break;
      this.labels.delete(oldest);
    }
  }

  private async label(row: DocumentRecord): Promise<string> {
    const cached = this.labels.get(this.labelKey(row));
    if (cached !== undefined) return cached;
    let label: string;
    try {
      label = await documentTypeLabel(
        this.storage.path(row.sha256),
        row.mime,
        row.size,
        row.filename,
      );
    } catch (err) {
      // A missing or unreadable blob still lists, labelled by type and size.
      this.logger.warn({ err, documentId: row.id }, 'could not read document for its label');
      return sizeTypeLabel(row.mime, row.size, row.filename);
    }
    this.remember(row, label);
    return label;
  }

  private async toRow(row: DocumentRecord, attachedTo: ConfigurationLink[]): Promise<DocumentRow> {
    return {
      id: row.id,
      filename: row.filename,
      sizeBytes: row.size,
      mediaType: row.mime,
      typeLabel: await this.label(row),
      sha256: row.sha256,
      uploadedAt: row.uploadedAt.toISOString(),
      attachedTo,
    };
  }
}
