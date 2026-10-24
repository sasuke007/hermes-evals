/**
 * DocumentsService on PGlite with a real blob store: upload stores the blob,
 * its blobs row and the documents row; the list carries the type label and
 * "Attached to" from latest configuration versions; content streams the
 * stored bytes back with safe headers.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentRowSchema } from '@hermes-evals/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { sha } from '../../../test/support/seed.js';
import { blobs, documents } from '../../database/schema/index.js';
import { StorageService } from '../../storage/storage.service.js';
import {
  collect,
  configOf,
  httpFailure,
  seedConfiguration,
  silentLogger,
  testEnv,
  uploadedFile,
} from '../skills/testing.helper-spec.js';
import { DocumentsService } from './documents.service.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let t: TestDatabase;
let dataDir: string;
let storage: StorageService;
let service: DocumentsService;

beforeEach(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'documents-service-'));
  storage = new StorageService(configOf(testEnv(dataDir)), silentLogger);
  service = new DocumentsService(t.db, storage, silentLogger);
});

afterEach(async () => {
  await t.close();
  await rm(dataDir, { recursive: true, force: true });
});

const MARKDOWN = Array.from({ length: 120 }, (_, i) => `- rule ${i + 1}`).join('\n');
const CSV = `invoice_no,amount\n${Array.from({ length: 48 }, (_, i) => `INV-${i},10.00`).join('\n')}\n`;

async function upload(content: Buffer | string, name: string, mimetype?: string) {
  return DocumentRowSchema.parse(
    await service.upload(await uploadedFile(storage, content, name, mimetype)),
  );
}

describe('DocumentsService.upload', () => {
  it('stores the blob and both rows, and labels the content', async () => {
    const row = await upload(MARKDOWN, 'policy.md', 'text/markdown');
    expect(row).toMatchObject({
      filename: 'policy.md',
      sizeBytes: Buffer.byteLength(MARKDOWN),
      mediaType: 'text/markdown',
      typeLabel: 'Markdown · 120 lines',
      sha256: sha(MARKDOWN),
      attachedTo: [],
    });
    expect(await readFile(storage.path(row.sha256), 'utf8')).toBe(MARKDOWN);
    expect(await t.db.select().from(blobs).where(eq(blobs.sha256, row.sha256))).toEqual([
      expect.objectContaining({ size: Buffer.byteLength(MARKDOWN) }),
    ]);
    expect(await t.db.select().from(documents)).toEqual([
      expect.objectContaining({ id: row.id, mime: 'text/markdown', filename: 'policy.md' }),
    ]);

    const csv = await upload(CSV, 'invoices.csv', 'application/vnd.ms-excel');
    expect(csv).toMatchObject({ mediaType: 'text/csv', typeLabel: 'CSV · 48 rows · 2 columns' });
  });

  it('keeps only the base name of the uploaded file', async () => {
    expect((await upload('a', 'C:\\Users\\me\\notes.txt')).filename).toBe('notes.txt');
    expect((await upload('b', '../../etc/passwd')).filename).toBe('passwd');
    expect((await upload('c', '..')).filename).toBe('document');
    expect((await upload('d', 'tab\there.txt')).filename).toBe('tabhere.txt');
  });

  it('makes two rows over one blob for the same content', async () => {
    const first = await upload(MARKDOWN, 'policy.md');
    const second = await upload(MARKDOWN, 'policy-copy.md');
    expect(second.id).not.toBe(first.id);
    expect(second.sha256).toBe(first.sha256);
    expect(await t.db.select().from(blobs)).toHaveLength(1);
    expect(await service.count()).toBe(2);
  });
});

describe('DocumentsService reads', () => {
  it('lists by file name with "Attached to" from latest configuration versions only', async () => {
    const policy = await upload(MARKDOWN, 'vendor-policy.md');
    const invoices = await upload(CSV, 'invoices.csv');
    // with-docs dropped the policy in its latest version.
    const withDocs = await seedConfiguration(t.db, 'with-docs', [
      { documentIds: [policy.id, invoices.id] },
      { documentIds: [invoices.id] },
    ]);

    const rows = DocumentRowSchema.array().parse(await service.list());
    expect(rows.map((r) => [r.filename, r.attachedTo])).toEqual([
      ['invoices.csv', [{ configurationId: withDocs, name: 'with-docs' }]],
      ['vendor-policy.md', []],
    ]);
    expect(rows[0]!.typeLabel).toBe('CSV · 48 rows · 2 columns');
  });

  it('labels a listed document from its blob when the label is not cached', async () => {
    const row = await upload(CSV, 'invoices.csv');
    const fresh = new DocumentsService(t.db, storage, silentLogger);
    expect((await fresh.list())[0]).toMatchObject({ id: row.id, typeLabel: row.typeLabel });
    // A missing blob still lists, labelled by type and size.
    await rm(storage.path(row.sha256));
    const blind = new DocumentsService(t.db, storage, silentLogger);
    expect((await blind.list())[0]!.typeLabel).toBe(`CSV · ${Buffer.byteLength(CSV)} B`);
  });

  it('streams the content with its type and disposition', async () => {
    const md = await upload(MARKDOWN, 'policy.md');
    const content = await service.content(md.id);
    expect(content).toMatchObject({
      filename: 'policy.md',
      contentType: 'text/markdown; charset=utf-8',
      size: Buffer.byteLength(MARKDOWN),
      disposition: 'inline',
    });
    expect((await collect(content.stream)).toString('utf8')).toBe(MARKDOWN);

    const html = await upload('<script>alert(1)</script>', 'page.html', 'text/html');
    expect(await service.content(html.id)).toMatchObject({
      contentType: 'text/html; charset=utf-8',
      disposition: 'attachment',
    });

    expect(await httpFailure(service.content('doc_missing'))).toEqual({
      status: 404,
      body: { statusCode: 404, message: 'document doc_missing not found' },
    });
    await rm(storage.path(md.sha256));
    expect(await httpFailure(service.content(md.id))).toMatchObject({ status: 500 });
  });
});
