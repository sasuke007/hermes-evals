/**
 * The skill endpoints over HTTP with real multipart uploads: a Nest app with
 * SkillsModule and DocumentsModule on PGlite and a temporary DATA_DIR.
 * Every body is checked against the shared contract, and every error body is
 * the API's `{ statusCode, message, issues? }`.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import {
  SkillDetailSchema,
  SkillFileContentSchema,
  SkillRowSchema,
  SkillUploadValidationSchema,
} from '@hermes-evals/shared';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { SKILL_ZIP_MAX_BYTES } from './skills.controller.js';
import { skillContentHash } from './skill-files.js';
import {
  binaryBody,
  invoiceMethodZip,
  seedConfiguration,
  startResourcesApp,
} from './testing.helper-spec.js';
import { unpackSkillZip } from './zip-reader.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let t: TestDatabase;
let dataDir: string;
let app: INestApplication;

beforeEach(async () => {
  t = await createTestDatabase();
  dataDir = await mkdtemp(join(tmpdir(), 'skills-http-'));
  app = await startResourcesApp(t.db, dataDir);
});

afterEach(async () => {
  await app.close();
  await t.close();
  await rm(dataDir, { recursive: true, force: true });
});

const http = () => request(app.getHttpServer());

/** What is left in DATA_DIR/tmp besides the skill uploads waiting for confirm. */
async function scratchLeft(): Promise<string[]> {
  return (await readdir(join(dataDir, 'tmp'))).filter((name) => name !== 'skill-uploads');
}

describe('POST /api/resources/skills/validate, then POST /api/resources/skills', () => {
  it('validates a zip, confirms it, and serves the stored skill', async () => {
    const zip = await invoiceMethodZip();
    const validated = await http()
      .post('/api/resources/skills/validate')
      .attach('file', zip, { filename: 'invoice-method.zip', contentType: 'application/zip' })
      .expect(200);
    const report = SkillUploadValidationSchema.parse(validated.body);
    expect(report).toMatchObject({
      outcome: 'valid',
      fileName: 'invoice-method.zip',
      sizeBytes: zip.length,
      name: 'invoice-method',
    });
    // The multipart scratch copy is gone once the response is out.
    await expect.poll(scratchLeft).toEqual([]);

    const confirmed = await http()
      .post('/api/resources/skills')
      .send({ token: report.token })
      .expect(201);
    const row = SkillRowSchema.parse(confirmed.body);
    expect(row).toMatchObject({ name: 'invoice-method', contentHash: report.contentHash });
    const configId = await seedConfiguration(t.db, 'with-skill', [{ skillIds: [row.id] }]);

    const list = await http().get('/api/resources/skills').expect(200);
    const links = [{ configurationId: configId, name: 'with-skill' }];
    expect(row).toMatchObject({ inUse: false, inUseBy: [] });
    expect(SkillRowSchema.array().parse(list.body)).toEqual([
      { ...row, usedBy: links, inUse: true, inUseBy: links },
    ]);

    const detail = await http().get(`/api/resources/skills/${row.id}`).expect(200);
    expect(SkillDetailSchema.parse(detail.body).files.map((f) => f.path)).toEqual([
      'SKILL.md',
      'checklist.csv',
      'examples/reconcile.py',
      'logo.bin',
    ]);

    const file = await http()
      .get(`/api/resources/skills/${row.id}/files/${encodeURIComponent('examples/reconcile.py')}`)
      .expect(200);
    expect(SkillFileContentSchema.parse(file.body)).toMatchObject({
      kind: 'code',
      content: 'print("reconcile")\n',
    });

    const download = await http()
      .get(`/api/resources/skills/${row.id}/zip`)
      .buffer(true)
      .parse(binaryBody)
      .expect(200);
    expect(download.headers['content-type']).toBe('application/zip');
    expect(download.headers['content-disposition']).toBe(
      `attachment; filename="invoice-method-1.0.0.zip"; filename*=UTF-8''invoice-method-1.0.0.zip`,
    );
    const zipPath = join(dataDir, 'download.zip');
    await writeFile(zipPath, download.body as Buffer);
    const unpacked = await unpackSkillZip(zipPath, await mkdtemp(join(dataDir, 'unzipped-')));
    expect(unpacked.ok && skillContentHash(unpacked.files)).toBe(row.contentHash);
  });

  it('reads the browser file name as UTF-8', async () => {
    const res = await http()
      .post('/api/resources/skills/validate')
      .attach('file', await invoiceMethodZip(), 'fakturametode-ø.zip')
      .expect(200);
    expect(SkillUploadValidationSchema.parse(res.body).fileName).toBe('fakturametode-ø.zip');
  });

  it('answers 400 without a file in the field `file`', async () => {
    const none = await http().post('/api/resources/skills/validate').send({}).expect(400);
    expect(none.body).toEqual({
      statusCode: 400,
      message: "attach the skill zip as the multipart field 'file'",
    });
    const wrongField = await http()
      .post('/api/resources/skills/validate')
      .attach('upload', await invoiceMethodZip(), 'invoice-method.zip')
      .expect(400);
    expect(wrongField.body).toEqual({
      statusCode: 400,
      message: "send one file, in the multipart field 'file'",
    });
    const two = await http()
      .post('/api/resources/skills/validate')
      .attach('file', await invoiceMethodZip(), 'a.zip')
      .attach('file', await invoiceMethodZip(), 'b.zip')
      .expect(400);
    expect(two.body).toEqual({
      statusCode: 400,
      message: "send one file, in the multipart field 'file'",
    });
    await expect.poll(scratchLeft).toEqual([]);
  });

  it('answers 413 over 20 MB and keeps no part of the upload', async () => {
    const res = await http()
      .post('/api/resources/skills/validate')
      .attach('file', Buffer.alloc(SKILL_ZIP_MAX_BYTES + 1), 'big.zip')
      .expect(413);
    expect(res.body).toEqual({ statusCode: 413, message: 'the file is larger than 20 MB' });
    await expect.poll(scratchLeft).toEqual([]);
  });

  it('reports a file that is not a zip as invalid', async () => {
    const res = await http()
      .post('/api/resources/skills/validate')
      .attach('file', Buffer.from('just text'), 'notes.zip')
      .expect(200);
    const report = SkillUploadValidationSchema.parse(res.body);
    expect(report).toMatchObject({ outcome: 'invalid', token: null });
    expect(report.problems[0]!.title).toBe('Not a zip file.');
  });

  it('validates the confirm body and answers 404 for an unknown token', async () => {
    const empty = await http().post('/api/resources/skills').send({}).expect(400);
    expect(empty.body).toMatchObject({
      statusCode: 400,
      message: 'Validation failed',
      issues: [expect.objectContaining({ path: 'token' })],
    });
    await http().post('/api/resources/skills').send({ token: 'x', extra: 1 }).expect(400);
    const unknown = await http()
      .post('/api/resources/skills')
      .send({ token: 'a'.repeat(64) })
      .expect(404);
    expect(unknown.body).toEqual({
      statusCode: 404,
      message: 'no skill upload has this token; validate the zip again',
    });
  });

  it('answers 404 for an unknown skill or a file not in its tree', async () => {
    const missing = await http().get('/api/resources/skills/skl_missing').expect(404);
    expect(missing.body).toEqual({ statusCode: 404, message: 'skill skl_missing not found' });
    await http().get('/api/resources/skills/skl_missing/zip').expect(404);

    const report = SkillUploadValidationSchema.parse(
      (
        await http()
          .post('/api/resources/skills/validate')
          .attach('file', await invoiceMethodZip(), 'invoice-method.zip')
      ).body,
    );
    const row = SkillRowSchema.parse(
      (await http().post('/api/resources/skills').send({ token: report.token })).body,
    );
    for (const path of ['..%2F..%2Fetc%2Fpasswd', 'examples', 'nope.md']) {
      const res = await http().get(`/api/resources/skills/${row.id}/files/${path}`).expect(404);
      expect(res.body).toEqual({ statusCode: 404, message: expect.any(String) });
    }
  });
});
