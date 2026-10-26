/**
 * DELETE /api/resources/skills/:id and /api/resources/documents/:id (Phase 5
 * section 6.1) over HTTP, on PGlite and a temporary DATA_DIR: an unused one
 * goes with 204; one any configuration version names stays, with a 409 that
 * names those configurations; a configuration saved with it between the
 * check and the delete is caught by migration 0009's guard.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  DocumentRowSchema,
  ResourceInUseBodySchema,
  SkillRowSchema,
  SkillUploadValidationSchema,
} from '@hermes-evals/shared';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { documents } from '../../database/schema/index.js';
import { deleteUnused } from './configuration-links.js';
import { invoiceMethodZip, seedConfiguration, startResourcesApp } from './testing.helper-spec.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let t: TestDatabase;
let dataDir: string;
let app: INestApplication;

beforeEach(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'resource-delete-'));
  app = await startResourcesApp(t.db, dataDir);
});

afterEach(async () => {
  await app.close();
  await t.close();
  await rm(dataDir, { recursive: true, force: true });
});

const http = () => request(app.getHttpServer());

async function storeSkill(): Promise<string> {
  const validated = await http()
    .post('/api/resources/skills/validate')
    .attach('file', await invoiceMethodZip(), 'invoice-method.zip')
    .expect(200);
  const { token } = SkillUploadValidationSchema.parse(validated.body);
  const confirmed = await http().post('/api/resources/skills').send({ token }).expect(201);
  return SkillRowSchema.parse(confirmed.body).id;
}

async function storeDocument(filename = 'vendor-policy.md'): Promise<string> {
  const created = await http()
    .post('/api/resources/documents')
    .attach('file', Buffer.from('# Vendor policy\n'), filename)
    .expect(201);
  return DocumentRowSchema.parse(created.body).id;
}

describe('DELETE /api/resources/skills/:id', () => {
  it('deletes a skill no configuration has used, then answers 404', async () => {
    const id = await storeSkill();
    const res = await http().delete(`/api/resources/skills/${id}`).expect(204);
    expect(res.body).toEqual({});
    expect((await http().get('/api/resources/skills').expect(200)).body).toEqual([]);
    const again = await http().delete(`/api/resources/skills/${id}`).expect(404);
    expect(again.body).toEqual({ statusCode: 404, message: `skill ${id} not found` });
  });

  it('refuses one an older configuration version keeps, naming the configuration', async () => {
    const id = await storeSkill();
    // with-skill dropped it in v2, so the list's "Used by" is empty, but v1 keeps it.
    const configurationId = await seedConfiguration(t.db, 'with-skill', [{ skillIds: [id] }, {}]);
    const [row] = SkillRowSchema.array().parse(
      (await http().get('/api/resources/skills').expect(200)).body,
    );
    expect(row!.usedBy).toEqual([]);
    const res = await http().delete(`/api/resources/skills/${id}`).expect(409);
    expect(ResourceInUseBodySchema.parse(res.body)).toEqual({
      statusCode: 409,
      message:
        'skill invoice-method 1.0.0 is part of a saved version of with-skill, and a ' +
        'configuration version keeps what it was saved with, so it cannot be deleted',
      usedBy: [{ configurationId, name: 'with-skill' }],
    });
    expect((await http().get('/api/resources/skills').expect(200)).body).toHaveLength(1);
  });
});

describe('DELETE /api/resources/documents/:id', () => {
  it('deletes a document no configuration has used, keeping its twin over the same blob', async () => {
    const id = await storeDocument();
    const twin = await storeDocument();
    await http().delete(`/api/resources/documents/${id}`).expect(204);
    const left = DocumentRowSchema.array().parse(
      (await http().get('/api/resources/documents').expect(200)).body,
    );
    expect(left.map((d) => d.id)).toEqual([twin]);
    await http().get(`/api/resources/documents/${twin}/content`).expect(200);
    await http().delete('/api/resources/documents/doc_missing').expect(404);
  });

  it('refuses one configurations use, naming each by name', async () => {
    const id = await storeDocument();
    const a = await seedConfiguration(t.db, 'docs-b', [{ documentIds: [id] }]);
    const b = await seedConfiguration(t.db, 'docs-a', [{ documentIds: [id] }]);
    const res = await http().delete(`/api/resources/documents/${id}`).expect(409);
    const body = ResourceInUseBodySchema.parse(res.body);
    expect(body.usedBy).toEqual([
      { configurationId: b, name: 'docs-a' },
      { configurationId: a, name: 'docs-b' },
    ]);
    expect(body.message).toMatch(
      /^document vendor-policy\.md is part of a saved version of docs-a and docs-b,/,
    );
  });

  it('answers 409 when a configuration is saved with it between the check and the delete', async () => {
    const id = await storeDocument();
    const attempt = deleteUnused(
      t.db,
      { column: 'documentIds', id, what: 'document vendor-policy.md' },
      async () => {
        await seedConfiguration(t.db, 'late', [{ documentIds: [id] }]);
        const gone = await t.db
          .delete(documents)
          .where(eq(documents.id, id))
          .returning({ id: documents.id });
        return gone.length > 0;
      },
    );
    await expect(attempt).rejects.toMatchObject({
      response: { statusCode: 409, usedBy: [{ name: 'late' }] },
    });
    expect(await t.db.select().from(documents).where(eq(documents.id, id))).toHaveLength(1);
  });
});
