/**
 * The configuration routes over HTTP: a Nest testing module with
 * ConfigurationsModule on PGlite, driven with supertest. Every success body
 * is parsed with its shared schema; errors keep the { statusCode, message,
 * issues? } shape.
 */
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PinoLogger } from 'nestjs-pino';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigDiffSchema,
  ConfigurationDetailSchema,
  ConfigurationDraftSchema,
  ConfigurationFormOptionsSchema,
  ConfigurationListRowSchema,
  ConfigurationSaveResultSchema,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { DB } from '../database/db.provider.js';
import { ConfigurationsModule } from './configurations.module.js';
import { configurationInput as input, seedLibrary, type Library } from './support-spec.js';

let t: TestDatabase;
let lib: Library;
let app: INestApplication;

beforeEach(async () => {
  t = await createTestDatabase();
  lib = await seedLibrary(t.db);

  /** What AppModule's DatabaseModule, ConfigModule and LoggerModule provide. */
  @Global()
  @Module({
    providers: [
      { provide: DB, useValue: t.db },
      { provide: ConfigService, useValue: { get: () => '/nonexistent/prices.yaml' } },
      { provide: PinoLogger, useValue: { setContext: () => {}, warn: () => {} } },
    ],
    exports: [DB, ConfigService, PinoLogger],
  })
  class InfraModule {}

  const moduleRef = await Test.createTestingModule({
    imports: [InfraModule, ConfigurationsModule],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
});

afterEach(async () => {
  await app.close();
  await t.close();
});

const http = () => request(app.getHttpServer());

async function create(overrides: Parameters<typeof input>[0] = {}) {
  const res = await http().post('/api/configurations').send(input(overrides)).expect(201);
  return ConfigurationSaveResultSchema.parse(res.body);
}

describe('POST /api/configurations', () => {
  it('creates version 1 and strips unknown keys', async () => {
    const res = await http()
      .post('/api/configurations')
      .send({ ...input({ skillIds: [lib.skillId] }), configHash: 'f'.repeat(64), extra: true })
      .expect(201);
    expect(ConfigurationSaveResultSchema.parse(res.body)).toMatchObject({
      version: 1,
      createdNewVersion: true,
    });
  });

  it('answers 400 with issues for an invalid body', async () => {
    const res = await http()
      .post('/api/configurations')
      .send({ ...input(), name: 'Not A Slug', maxTurns: 0 })
      .expect(400);
    expect(res.body.message).toBe('Validation failed');
    expect(res.body.issues.map((i: { path: string }) => i.path)).toEqual(['name', 'maxTurns']);
  });

  it('answers 400 naming a missing reference and 409 for a taken name', async () => {
    const missing = await http()
      .post('/api/configurations')
      .send(input({ documentIds: ['doc_gone'] }))
      .expect(400);
    expect(missing.body).toEqual({
      statusCode: 400,
      message: 'document doc_gone does not exist',
      issues: [{ path: 'documentIds', message: 'document doc_gone does not exist' }],
    });
    await create();
    const taken = await http().post('/api/configurations').send(input()).expect(409);
    expect(taken.body).toEqual({
      statusCode: 409,
      message: 'a configuration named baseline already exists',
    });
  });
});

describe('reads', () => {
  it('lists, shows a configuration and one of its versions', async () => {
    const saved = await create({ mcpServerVersionIds: [lib.mcpV1] });
    const list = await http().get('/api/configurations').expect(200);
    expect(ConfigurationListRowSchema.array().parse(list.body)).toHaveLength(1);

    const shown = await http().get(`/api/configurations/${saved.configurationId}`).expect(200);
    expect(ConfigurationDetailSchema.parse(shown.body).latest.mcpServers[0]!.name).toBe(
      'invoice-db',
    );
    const v1 = await http()
      .get(`/api/configurations/${saved.configurationId}/versions/1`)
      .expect(200);
    expect(ConfigurationDetailSchema.parse(v1.body).shown.version).toBe(1);

    await http().get(`/api/configurations/${saved.configurationId}/versions/2`).expect(404);
    const bad = await http()
      .get(`/api/configurations/${saved.configurationId}/versions/latest`)
      .expect(400);
    expect(bad.body.issues).toHaveLength(1);
    const missing = await http().get('/api/configurations/cfg_missing').expect(404);
    expect(missing.body).toEqual({
      statusCode: 404,
      message: 'configuration cfg_missing not found',
    });
  });

  it('diffs two or three versions and refuses any other count', async () => {
    const a = await create();
    const b = await create({ name: 'with-skill', skillIds: [lib.skillId] });
    const res = await http()
      .get(`/api/configurations/diff?versions=${a.versionId},${b.versionId}`)
      .expect(200);
    expect(ConfigDiffSchema.parse(res.body).differing).toEqual(['skills']);

    await http().get(`/api/configurations/diff?versions=${a.versionId}`).expect(400);
    await http().get('/api/configurations/diff').expect(400);
    await http().get(`/api/configurations/diff?versions=${a.versionId},${a.versionId}`).expect(400);
    await http().get(`/api/configurations/diff?versions=${a.versionId},x,y,z`).expect(400);
    await http().get(`/api/configurations/diff?versions=${a.versionId},cfgv_gone`).expect(404);
  });

  it('serves the form options', async () => {
    const res = await http().get('/api/configurations/form-options').expect(200);
    const options = ConfigurationFormOptionsSchema.parse(res.body);
    expect(options.mcpServers.map((m) => m.name)).toEqual(['invoice-db', 'vendor-api']);
  });
});

describe('edit and duplicate', () => {
  it('saves an edit, opens the edit draft and a duplicate draft', async () => {
    const saved = await create();
    const put = await http()
      .put(`/api/configurations/${saved.configurationId}`)
      .send(input({ timeBudgetS: 600 }))
      .expect(200);
    expect(ConfigurationSaveResultSchema.parse(put.body)).toEqual({
      ...saved,
      createdNewVersion: false,
    });

    const draft = await http()
      .get(`/api/configurations/${saved.configurationId}/draft`)
      .expect(200);
    expect(ConfigurationDraftSchema.parse(draft.body)).toMatchObject({
      mode: 'edit',
      values: { timeBudgetS: 600 },
    });

    const copy = await http()
      .post(`/api/configurations/${saved.configurationId}/duplicate`)
      .send({})
      .expect(200);
    expect(ConfigurationDraftSchema.parse(copy.body)).toMatchObject({
      mode: 'duplicate',
      values: { name: 'baseline-copy', duplicatedFromVersionId: saved.versionId },
    });
    await http().post('/api/configurations/cfg_gone/duplicate').expect(404);
    await http().put('/api/configurations/cfg_gone').send(input()).expect(404);
  });
});
