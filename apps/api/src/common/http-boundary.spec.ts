/**
 * The two global pieces AppModule installs around every route:
 * RequestedWithGuard (plan 6.1) and DatabaseErrorFilter. The filter is fed
 * real refusals: PGlite runs the migrations, constraints and 0001 triggers.
 */
import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Post,
  Put,
  type INestApplication,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiErrorBodySchema } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { sha } from '../../test/support/seed.js';
import { DB } from '../database/db.provider.js';
import { configurations, configurationVersions } from '../database/schema/index.js';
import type { AppDb } from '../database/types.js';
import { DatabaseErrorFilter, databaseErrorAnswer } from './database-error.filter.js';
import { pgError } from './pg-error.js';
import {
  MISSING_REQUESTED_WITH,
  RequestedWithGuard,
  UNSUPPORTED_BODY_TYPE,
  isAllowedBodyType,
  refusalOf,
} from './requested-with.guard.js';

const version = (configurationId: string, frozen = false) => ({
  configurationId,
  version: 1,
  model: 'openai/gpt-6.1-sol',
  provider: 'nous' as const,
  maxTurns: 20,
  timeBudgetS: 300,
  configHash: sha(configurationId),
  frozenAt: frozen ? new Date() : null,
});

/**
 * A configuration with its version 1, in one transaction: the latest-version
 * key is checked at commit. Returns the version id.
 */
async function insertConfiguration(db: AppDb, name: string, frozen = false): Promise<string> {
  return db.transaction(async (tx) => {
    const [cfg] = await tx.insert(configurations).values({ name }).returning();
    const [row] = await tx
      .insert(configurationVersions)
      .values(version(cfg!.id, frozen))
      .returning();
    return row!.id;
  });
}

/** Routes that make the database refuse, one per SQLSTATE the filter maps. */
@Controller('probe')
class ProbeController {
  constructor(@Inject(DB) private readonly db: AppDb) {}

  @Get()
  read(): { ok: true } {
    return { ok: true };
  }

  @Post()
  @HttpCode(200)
  write(@Body() body: unknown): { ok: true; body: unknown } {
    return { ok: true, body };
  }

  @Put()
  put(): { ok: true } {
    return { ok: true };
  }

  @Delete()
  remove(): { ok: true } {
    return { ok: true };
  }

  @Post('unique')
  async unique(): Promise<void> {
    await this.db.insert(configurations).values({ name: 'baseline' });
  }

  @Post('foreign-key')
  async foreignKey(): Promise<void> {
    await this.db.insert(configurationVersions).values(version('cfg_missing'));
  }

  @Post('check')
  async check(): Promise<void> {
    await this.db.insert(configurations).values({ name: 'Not A Slug' });
  }

  @Post('frozen')
  async frozen(): Promise<void> {
    const versionId = await insertConfiguration(this.db, 'frozen', true);
    await this.db
      .update(configurationVersions)
      .set({ maxTurns: 30 })
      .where(eq(configurationVersions.id, versionId));
  }

  @Post('chosen')
  async chosen(): Promise<void> {
    try {
      await this.db.insert(configurations).values({ name: 'baseline' });
    } catch (err) {
      throw new ConflictException(
        { statusCode: 409, message: 'the service chose this' },
        { cause: err },
      );
    }
  }

  @Post('plain')
  plain(): never {
    throw new Error('something else broke');
  }
}

let t: TestDatabase;
let app: INestApplication;

beforeAll(async () => {
  t = await createTestDatabase();
  await insertConfiguration(t.db, 'baseline');
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [
      { provide: DB, useValue: t.db },
      { provide: APP_GUARD, useClass: RequestedWithGuard },
      { provide: APP_FILTER, useClass: DatabaseErrorFilter },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.init();
}, 30_000);

afterAll(async () => {
  await app?.close();
  await t?.close();
});

const send = (path: string) =>
  request(app.getHttpServer())
    .post(`/api/probe${path}`)
    .set('X-Requested-With', 'hermes-evals')
    .send({});

describe('RequestedWithGuard', () => {
  it('lets reads through without the header', async () => {
    await request(app.getHttpServer()).get('/api/probe').expect(200, { ok: true });
  });

  it('refuses POST, PUT and DELETE without X-Requested-With', async () => {
    const http = request(app.getHttpServer());
    for (const call of [
      () => http.post('/api/probe').send({ a: 1 }),
      () => http.put('/api/probe').send({}),
      () => http.delete('/api/probe').set('content-type', 'application/json'),
      () => http.post('/api/probe').set('X-Requested-With', '  ').send({}),
    ]) {
      const res = await call().expect(403);
      expect(ApiErrorBodySchema.parse(res.body)).toEqual({
        statusCode: 403,
        message: MISSING_REQUESTED_WITH,
      });
    }
  });

  it('refuses a body a plain HTML form could send', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded']) {
      const res = await request(app.getHttpServer())
        .post('/api/probe')
        .set('X-Requested-With', 'x')
        .set('content-type', type)
        .send('a=1')
        .expect(403);
      expect(res.body).toEqual({ statusCode: 403, message: UNSUPPORTED_BODY_TYPE });
    }
    // No body type at all is refused too.
    await request(app.getHttpServer()).post('/api/probe').set('X-Requested-With', 'x').expect(403);
  });

  it('accepts JSON with the header, as liveSend sends it', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/probe')
      .set('X-Requested-With', 'hermes-evals')
      .set('content-type', 'application/json; charset=utf-8')
      .send(JSON.stringify({ a: 1 }))
      .expect(200);
    expect(res.body).toEqual({ ok: true, body: { a: 1 } });
    await request(app.getHttpServer())
      .delete('/api/probe')
      .set('X-Requested-With', 'x')
      .set('content-type', 'application/json')
      .expect(200);
  });

  it('accepts multipart with the header', async () => {
    await request(app.getHttpServer())
      .post('/api/probe')
      .set('X-Requested-With', 'x')
      .attach('file', Buffer.from('hello'), 'a.txt')
      .expect(200);
  });

  it('reads body types the way the rule says', () => {
    expect(isAllowedBodyType('application/json')).toBe(true);
    expect(isAllowedBodyType('Application/JSON; charset=utf-8')).toBe(true);
    expect(isAllowedBodyType('application/merge-patch+json')).toBe(true);
    expect(isAllowedBodyType('multipart/form-data; boundary=x')).toBe(true);
    expect(isAllowedBodyType('text/plain')).toBe(false);
    expect(isAllowedBodyType('application/jsonp')).toBe(false);
    expect(isAllowedBodyType(undefined)).toBe(false);
    expect(refusalOf('get', {})).toBeNull();
    expect(refusalOf('OPTIONS', {})).toBeNull();
    expect(refusalOf('patch', { 'x-requested-with': 'x' })).toBe(UNSUPPORTED_BODY_TYPE);
  });
});

describe('DatabaseErrorFilter', () => {
  it('answers a unique violation with 409 and what the constraint protects', async () => {
    const res = await send('/unique').expect(409);
    expect(ApiErrorBodySchema.parse(res.body)).toEqual({
      statusCode: 409,
      message: 'a configuration with this name already exists',
    });
  });

  it('answers a foreign key violation with 400', async () => {
    const res = await send('/foreign-key').expect(400);
    expect(res.body).toEqual({
      statusCode: 400,
      message: expect.stringMatching(/^a referenced record does not exist \(.+_fk(ey)?\)$/),
    });
  });

  it('answers a check violation with 400 naming the constraint, not the value', async () => {
    const res = await send('/check').expect(400);
    expect(res.body).toEqual({
      statusCode: 400,
      message: 'a value is outside what the database allows (configurations_name_ck)',
    });
    expect(JSON.stringify(res.body)).not.toContain('Not A Slug');
  });

  it("answers a trigger's restrict violation with 409 and the trigger's sentence", async () => {
    const res = await send('/frozen').expect(409);
    expect(res.body).toEqual({
      statusCode: 409,
      message: expect.stringMatching(
        /^configuration version \S+ is used by an experiment and cannot change; save a new version$/,
      ),
    });
  });

  it('keeps an answer a service chose, and the 500 of anything else', async () => {
    expect((await send('/chosen').expect(409)).body).toEqual({
      statusCode: 409,
      message: 'the service chose this',
    });
    expect((await send('/plain').expect(500)).body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
    });
  });

  it('maps only the integrity codes', () => {
    expect(databaseErrorAnswer(new Error('x'))).toBeNull();
    expect(databaseErrorAnswer(Object.assign(new Error('pipe'), { code: 'EPIPE' }))).toBeNull();
    expect(databaseErrorAnswer({ code: '40001', message: 'serialization' })).toBeNull();
    const wrapped = new Error('query failed', {
      cause: { code: '23505', constraint: 'mcp_servers_name_uq', message: 'dup' },
    });
    expect(pgError(wrapped)).toMatchObject({ code: '23505', constraint: 'mcp_servers_name_uq' });
    expect(databaseErrorAnswer(wrapped)?.getStatus()).toBe(409);
    expect(databaseErrorAnswer({ code: '23505', message: 'dup' })?.getResponse()).toEqual({
      statusCode: 409,
      message: 'this would duplicate an existing record',
    });
    expect(
      databaseErrorAnswer({
        code: '23503',
        constraint: 'x_fk',
        message:
          'update or delete on table "a" violates foreign key constraint "x_fk" on table "b"; Key is still referenced',
      })?.getResponse(),
    ).toEqual({ statusCode: 400, message: 'the record is still in use (x_fk)' });
  });
});
