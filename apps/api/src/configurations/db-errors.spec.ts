/**
 * The database refusals a configuration write can meet, raised for real on
 * PGlite by the 0001 triggers, and the answers they become.
 */
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { sha } from '../../test/support/seed.js';
import { configurations, configurationVersions } from '../database/schema/index.js';
import { pgError, translateWriteError } from './db-errors.js';
import { seedLibrary, type Library } from './support-spec.js';

let t: TestDatabase;
let lib: Library;

beforeEach(async () => {
  t = await createTestDatabase();
  lib = await seedLibrary(t.db);
});

afterEach(async () => {
  await t.close();
});

/** Writes a configuration and its version straight to the database, bypassing the service's checks. */
async function rawInsert(
  name: string,
  refs: { skillIds?: string[]; mcpServerVersionIds?: string[] },
) {
  try {
    await t.db.transaction(async (tx) => {
      const [cfg] = await tx.insert(configurations).values({ name }).returning();
      await tx.insert(configurationVersions).values({
        configurationId: cfg!.id,
        version: 1,
        model: 'm',
        provider: 'nous',
        maxTurns: 20,
        timeBudgetS: 300,
        configHash: sha(name),
        ...refs,
      });
    });
  } catch (err) {
    return err;
  }
  throw new Error('expected the database to refuse the write');
}

describe('translateWriteError', () => {
  it('turns the refs trigger’s missing-reference refusal into 400', async () => {
    const err = await rawInsert('a', { skillIds: ['skl_gone'] });
    expect(pgError(err)?.code).toBe('23503');
    const http = translateWriteError(err, 'a');
    expect(http).toBeInstanceOf(BadRequestException);
    expect((http as BadRequestException).getResponse()).toMatchObject({ statusCode: 400 });
  });

  it('turns the two-MCP-versions refusal into 400 on mcpServerVersionIds', async () => {
    const err = await rawInsert('a', { mcpServerVersionIds: [lib.mcpV1, lib.mcpV2] });
    expect(pgError(err)?.code).toBe('23001');
    const http = translateWriteError(err, 'a') as BadRequestException;
    expect(http).toBeInstanceOf(BadRequestException);
    expect(http.getResponse()).toMatchObject({
      issues: [{ path: 'mcpServerVersionIds', message: 'two versions of the same MCP server' }],
    });
  });

  it('turns a lost race for a name into 409', async () => {
    await t.db.transaction(async (tx) => {
      const [cfg] = await tx.insert(configurations).values({ name: 'taken' }).returning();
      await tx.insert(configurationVersions).values({
        configurationId: cfg!.id,
        version: 1,
        model: 'm',
        provider: 'nous',
        maxTurns: 20,
        timeBudgetS: 300,
        configHash: sha('taken'),
      });
    });
    const err = await rawInsert('taken', {});
    expect(pgError(err)).toMatchObject({ code: '23505', constraint: 'configurations_name_uq' });
    const http = translateWriteError(err, 'taken') as ConflictException;
    expect(http).toBeInstanceOf(ConflictException);
    expect(http.getResponse()).toEqual({
      statusCode: 409,
      message: 'a configuration named taken already exists',
    });
  });

  it('passes HTTP errors and unrelated errors through', () => {
    const notFound = new NotFoundException();
    expect(translateWriteError(notFound, 'x')).toBe(notFound);
    const other = new Error('boom');
    expect(translateWriteError(other, 'x')).toBe(other);
    expect(pgError(other)).toBeNull();
  });
});
