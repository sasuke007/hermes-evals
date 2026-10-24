/**
 * The DB token: production and test clients both satisfy AppDb and AppTx, a
 * Nest testing module can swap in a PGlite database, and an unconfigured
 * database still lets modules start.
 */
import { Global, Inject, Injectable, Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { eq, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgTransaction } from 'drizzle-orm/node-postgres';
import type { PgliteDatabase, PgliteTransaction } from 'drizzle-orm/pglite';
import { PinoLogger } from 'nestjs-pino';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { HERMES_REVISION } from '../../test/support/seed.js';
import { DatabaseModule } from './database.module.js';
import { DB, unconfiguredDb } from './db.provider.js';
import { workers } from './schema/index.js';
import type { AppDb, AppSchema, AppTx } from './types.js';

type Relations = ExtractTablesWithRelations<AppSchema>;

describe('AppDb and AppTx', () => {
  it('are satisfied by the node-postgres and PGlite clients and their transactions', () => {
    expectTypeOf<NodePgDatabase<AppSchema>>().toExtend<AppDb>();
    expectTypeOf<PgliteDatabase<AppSchema>>().toExtend<AppDb>();
    expectTypeOf<NodePgTransaction<AppSchema, Relations>>().toExtend<AppTx>();
    expectTypeOf<PgliteTransaction<AppSchema, Relations>>().toExtend<AppTx>();
    // A transaction can be passed wherever a client is expected.
    expectTypeOf<AppTx>().toExtend<AppDb>();
    // And a transaction opened on an AppDb is an AppTx.
    expectTypeOf<Parameters<Parameters<AppDb['transaction']>[0]>[0]>().toEqualTypeOf<AppTx>();
  });
});

/** A service written the way every Phase 1 service is: the client comes through DB. */
@Injectable()
class WorkerNames {
  constructor(@Inject(DB) private readonly db: AppDb) {}

  async hostnames(): Promise<string[]> {
    const rows = await this.db.select({ hostname: workers.hostname }).from(workers);
    return rows.map((row) => row.hostname);
  }

  rename(id: string, hostname: string): Promise<void> {
    return this.db.transaction(async (tx: AppTx) => {
      await tx.update(workers).set({ hostname }).where(eq(workers.id, id));
    });
  }
}

/** What AppModule's ConfigModule and LoggerModule provide, with DATABASE_URL unset. */
@Global()
@Module({
  providers: [
    { provide: ConfigService, useValue: { get: () => undefined } },
    { provide: PinoLogger, useValue: { setContext: () => {}, info: () => {}, warn: () => {} } },
  ],
  exports: [ConfigService, PinoLogger],
})
class UnconfiguredInfraModule {}

describe('DB token', () => {
  let t: TestDatabase;

  beforeEach(async () => {
    t = await createTestDatabase();
  });

  afterEach(async () => {
    await t.close();
  });

  it('can be provided by a PGlite database in a testing module', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [WorkerNames, { provide: DB, useValue: t.db }],
    }).compile();
    const [worker] = await t.db
      .insert(workers)
      .values({
        hostname: 'worker-1',
        concurrency: 1,
        hermesVersion: '0.22.4',
        hermesRevision: HERMES_REVISION,
      })
      .returning();
    const service = moduleRef.get(WorkerNames);
    await service.rename(worker!.id, 'worker-2');
    expect(await service.hostnames()).toEqual(['worker-2']);
    await moduleRef.close();
  });

  it('can be overridden in a module that imports DatabaseModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [UnconfiguredInfraModule, DatabaseModule],
      providers: [WorkerNames],
    })
      .overrideProvider(DB)
      .useValue(t.db)
      .compile();
    expect(await moduleRef.get(WorkerNames).hostnames()).toEqual([]);
    await moduleRef.close();
  });
});

describe('unconfiguredDb', () => {
  it('answers 503 on use and stays inert when Nest probes it', async () => {
    const db = unconfiguredDb();
    expect(() => db.select()).toThrow(ServiceUnavailableException);
    expect(() => db.transaction(async () => {})).toThrow(/DATABASE_URL is not set/);
    expect(() => db.query).toThrow(ServiceUnavailableException);
    const probe = db as unknown as Record<string, unknown>;
    expect(probe.then).toBeUndefined();
    expect(probe.onModuleInit).toBeUndefined();
    expect(probe.onModuleDestroy).toBeUndefined();

    // A module whose DATABASE_URL is unset still compiles and starts.
    const moduleRef = await Test.createTestingModule({
      imports: [UnconfiguredInfraModule, DatabaseModule],
      providers: [WorkerNames],
    }).compile();
    await moduleRef.init();
    await expect(moduleRef.get(WorkerNames).hostnames()).rejects.toThrow(
      ServiceUnavailableException,
    );
    await moduleRef.close();
  });
});
