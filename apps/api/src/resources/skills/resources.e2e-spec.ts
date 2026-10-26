/**
 * Skills and documents on a real Postgres 17 through node-postgres, for what
 * PGlite cannot show: two confirms of the same name and version racing on
 * separate connections (exactly one wins, the other hears 409), the column
 * types and array queries the services rely on, and a delete racing a
 * configuration saved with the resource (migration 0009's guard, as
 * node-postgres reports it, becomes the 409 that names the configuration).
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { DocumentRowSchema, ResourceInUseBodySchema, SkillRowSchema } from '@hermes-evals/shared';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../database/migrator.js';
import * as schema from '../../database/schema/index.js';
import { StorageService } from '../../storage/storage.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { deleteUnused } from './configuration-links.js';
import { SkillUploadStore } from './skill-uploads.js';
import { SkillsService } from './skills.service.js';
import {
  configOf,
  invoiceMethodZip,
  seedConfiguration,
  silentLogger,
  testEnv,
  uploadedFile,
} from './testing.helper-spec.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!SERVER_URL)('skills and documents on Postgres 17', () => {
  const database = `hermes_evals_resources_e2e_${process.pid}`;
  let pool: pg.Pool;
  let db: NodePgDatabase<typeof schema>;
  let dataDir: string;
  let storage: StorageService;
  let skills: SkillsService;
  let documents: DocumentsService;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: SERVER_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${database}`);
    await admin.query(`create database ${database}`);
    await admin.end();
    const parsed = new URL(SERVER_URL!);
    parsed.pathname = `/${database}`;
    await runMigrations(parsed.toString());
    pool = new pg.Pool({ connectionString: parsed.toString(), max: 5 });
    db = drizzle(pool, { schema });
    dataDir = await mkdtemp(join(tmpdir(), 'resources-e2e-'));
    const config = configOf(testEnv(dataDir));
    storage = new StorageService(config, silentLogger);
    skills = new SkillsService(
      db,
      storage,
      new SkillUploadStore(storage, config, silentLogger),
      silentLogger,
    );
    documents = new DocumentsService(db, storage, silentLogger);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    const admin = new pg.Client({ connectionString: SERVER_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${database} with (force)`);
    await admin.end();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const validate = async (zip: Buffer) =>
    skills.validate(await uploadedFile(storage, zip, 'invoice-method.zip', 'application/zip'));

  it('lets exactly one of two racing confirms of the same name and version win', async () => {
    const a = await validate(await invoiceMethodZip({ version: '3.0.0' }));
    const b = await validate(
      await invoiceMethodZip({ version: '3.0.0' }, [{ path: 'other.md', content: 'b\n' }]),
    );
    const results = await Promise.allSettled([skills.confirm(a.token!), skills.confirm(b.token!)]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0]).toBeInstanceOf(HttpException);
    expect((lost[0] as HttpException).getStatus()).toBe(409);
    const winner = SkillRowSchema.parse((won[0] as PromiseFulfilledResult<unknown>).value);
    // Only the winner's tree is stored.
    expect(await readdir(skills.skillsDir)).toEqual([winner.contentHash]);
  });

  it('reads sizes as numbers and "Used by" through array overlap', async () => {
    const report = await validate(await invoiceMethodZip({ name: 'audit-trail' }));
    const skill = await skills.confirm(report.token!);
    const doc = DocumentRowSchema.parse(
      await documents.upload(await uploadedFile(storage, 'a,b\n1,2\n', 'pairs.csv', 'text/csv')),
    );
    const configId = await seedConfiguration(db, 'e2e-config', [
      { skillIds: [skill.id], documentIds: [doc.id] },
    ]);

    const listed = SkillRowSchema.array().parse(await skills.list());
    expect(listed.find((r) => r.id === skill.id)).toMatchObject({
      unpackedBytes: report.unpackedBytes,
      usedBy: [{ configurationId: configId, name: 'e2e-config' }],
    });
    const docs = DocumentRowSchema.array().parse(await documents.list());
    expect(docs).toEqual([
      expect.objectContaining({
        id: doc.id,
        sizeBytes: 8,
        typeLabel: 'CSV · 1 row · 2 columns',
        attachedTo: [{ configurationId: configId, name: 'e2e-config' }],
      }),
    ]);
    expect(await skills.count()).toBe(2);
    expect(await documents.count()).toBe(1);
  });

  it('deletes an unused document and refuses one a configuration version names', async () => {
    const unused = await documents.upload(
      await uploadedFile(storage, '# terms\n', 'unused.md', 'text/markdown'),
    );
    await documents.remove(unused.id);
    expect((await documents.list()).some((d) => d.id === unused.id)).toBe(false);

    const kept = await documents.upload(
      await uploadedFile(storage, '# kept\n', 'kept.md', 'text/markdown'),
    );
    await seedConfiguration(db, 'e2e-keeps', [{ documentIds: [kept.id] }, {}]);
    const refused = await documents.remove(kept.id).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(HttpException);
    expect(ResourceInUseBodySchema.parse((refused as HttpException).getResponse())).toMatchObject({
      statusCode: 409,
      usedBy: [{ name: 'e2e-keeps' }],
    });
  });

  it('turns the guard of a configuration saved meanwhile into the same 409', async () => {
    const doc = await documents.upload(
      await uploadedFile(storage, '# late\n', 'late.md', 'text/markdown'),
    );
    const attempt = deleteUnused(
      db,
      { column: 'documentIds', id: doc.id, what: 'document late.md' },
      async () => {
        await seedConfiguration(db, 'e2e-late', [{ documentIds: [doc.id] }]);
        const gone = await db
          .delete(schema.documents)
          .where(eq(schema.documents.id, doc.id))
          .returning({ id: schema.documents.id });
        return gone.length > 0;
      },
    );
    await expect(attempt).rejects.toMatchObject({
      response: { statusCode: 409, usedBy: [{ name: 'e2e-late' }] },
    });
  });
});
