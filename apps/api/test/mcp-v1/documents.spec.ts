/**
 * The documents of mcp-v1's docs-export arm (samples/documents/mcp-v1,
 * Phase 6b R3 and R4): the ledger and the vendor list, uploaded through POST
 * /api/resources/documents as a user would, are stored under their own names
 * with the media types the materialiser copies into workspace/docs/, and
 * read back byte for byte.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { DocumentRowSchema } from '@hermes-evals/shared';
import request from 'supertest';
import { binaryBody, startResourcesApp } from '../../src/resources/skills/testing.helper-spec.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { listFiles } from '../invoices-v1/support.js';
import { DOCUMENTS_DIR } from './support.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let dataDir: string;
let app: INestApplication;

beforeEach(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'mcp-v1-documents-'));
  app = await startResourcesApp(t.db, dataDir);
});

afterEach(async () => {
  await app.close();
  await t.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('samples/documents/mcp-v1', () => {
  it('holds the ledger and the vendor list, and nothing else', async () => {
    expect(await listFiles(DOCUMENTS_DIR)).toEqual(['invoices.csv', 'vendors.json']);
  });

  it.each([
    ['invoices.csv', 'text/csv', /^CSV · 120 rows · 9 columns$/],
    ['vendors.json', 'application/json', /^JSON · /],
  ] as const)(
    '%s uploads as a document and reads back byte for byte',
    async (name, type, label) => {
      const content = await readFile(join(DOCUMENTS_DIR, name));
      const uploaded = await request(app.getHttpServer())
        .post('/api/resources/documents')
        .attach('file', content, { filename: name, contentType: type })
        .expect(201);
      const row = DocumentRowSchema.parse(uploaded.body);
      expect(row).toMatchObject({
        filename: name,
        mediaType: type,
        sizeBytes: content.length,
        sha256: createHash('sha256').update(content).digest('hex'),
      });
      expect(row.typeLabel).toMatch(label);
      const back = await request(app.getHttpServer())
        .get(`/api/resources/documents/${row.id}/content`)
        .buffer(true)
        .parse(binaryBody)
        .expect(200);
      expect(Buffer.from(back.body as Buffer).equals(content)).toBe(true);
    },
  );
});
