/**
 * The document endpoints over HTTP with real multipart uploads, on PGlite
 * and a temporary DATA_DIR. Bodies are checked against the shared contract.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { DocumentRowSchema } from '@hermes-evals/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { binaryBody, classicPdf, startResourcesApp } from '../skills/testing.helper-spec.js';
import { DOCUMENT_MAX_BYTES } from './documents.controller.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let t: TestDatabase;
let dataDir: string;
let app: INestApplication;

beforeEach(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'documents-http-'));
  app = await startResourcesApp(t.db, dataDir);
});

afterEach(async () => {
  await app.close();
  await t.close();
  await rm(dataDir, { recursive: true, force: true });
});

const http = () => request(app.getHttpServer());

/** Upload scratch directories left in DATA_DIR/tmp. */
async function scratchLeft(): Promise<string[]> {
  return (await readdir(join(dataDir, 'tmp'))).filter((name) => name.startsWith('upload-'));
}

describe('POST /api/resources/documents', () => {
  it('stores a PDF, lists it and serves it back inline', async () => {
    const pdf = classicPdf(6);
    const created = await http()
      .post('/api/resources/documents')
      .attach('file', pdf, { filename: 'vendor-policy-v3.pdf', contentType: 'application/pdf' })
      .expect(201);
    const row = DocumentRowSchema.parse(created.body);
    expect(row).toMatchObject({
      filename: 'vendor-policy-v3.pdf',
      sizeBytes: pdf.length,
      mediaType: 'application/pdf',
      typeLabel: 'PDF · 6 pages',
      attachedTo: [],
    });
    await expect.poll(scratchLeft).toEqual([]);

    const list = await http().get('/api/resources/documents').expect(200);
    expect(DocumentRowSchema.array().parse(list.body)).toEqual([row]);

    const content = await http()
      .get(`/api/resources/documents/${row.id}/content`)
      .buffer(true)
      .parse(binaryBody)
      .expect(200);
    expect(content.headers).toMatchObject({
      'content-type': 'application/pdf',
      'content-length': String(pdf.length),
      'content-disposition': `inline; filename="vendor-policy-v3.pdf"; filename*=UTF-8''vendor-policy-v3.pdf`,
      'x-content-type-options': 'nosniff',
    });
    expect(Buffer.compare(content.body as Buffer, pdf)).toBe(0);
  });

  it('sends other types as attachments, with a UTF-8 file name', async () => {
    const created = await http()
      .post('/api/resources/documents')
      .attach('file', Buffer.from('<h1>Leverandør</h1>'), {
        filename: 'leverandør "notes".html',
        contentType: 'text/html',
      })
      .expect(201);
    const row = DocumentRowSchema.parse(created.body);
    expect(row.filename).toBe('leverandør "notes".html');
    const content = await http().get(`/api/resources/documents/${row.id}/content`).expect(200);
    expect(content.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(content.headers['content-disposition']).toBe(
      `attachment; filename="leverand_r _notes_.html"; filename*=UTF-8''leverand%C3%B8r%20%22notes%22.html`,
    );
  });

  it('answers 400 without a file and 404 for an unknown document', async () => {
    const none = await http().post('/api/resources/documents').send({}).expect(400);
    expect(none.body).toEqual({
      statusCode: 400,
      message: "attach the document as the multipart field 'file'",
    });
    const missing = await http().get('/api/resources/documents/doc_missing/content').expect(404);
    expect(missing.body).toEqual({ statusCode: 404, message: 'document doc_missing not found' });
  });

  it('answers 413 over 50 MB and keeps no part of the upload', async () => {
    const res = await http()
      .post('/api/resources/documents')
      .attach('file', Buffer.alloc(DOCUMENT_MAX_BYTES + 1), 'huge.bin')
      .expect(413);
    expect(res.body).toEqual({ statusCode: 413, message: 'the file is larger than 50 MB' });
    await expect.poll(scratchLeft).toEqual([]);
    expect(await readdir(join(dataDir, 'blobs')).catch(() => [])).toEqual([]);
  });
});
