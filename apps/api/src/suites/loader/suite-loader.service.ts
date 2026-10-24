/**
 * The suite loader as a Nest provider for the worker. It needs the DB token,
 * StorageService (the blob store at DATA_DIR) and SUITES_DIR. The worker
 * calls loadAtStartup() once migrations have run, and registers the
 * load-suites handler (load-suites.handler.ts) with this instance.
 */
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { SuiteReloadResult } from '@hermes-evals/shared';
import type { Env } from '../../config/env.js';
import { DB } from '../../database/db.provider.js';
import type { AppDb } from '../../database/types.js';
import { StorageService } from '../../storage/storage.service.js';
import { SuiteLoader } from './suite-loader.js';

@Injectable()
export class SuiteLoaderService extends SuiteLoader {
  private readonly log: PinoLogger;

  constructor(
    @Inject(DB) db: AppDb,
    @Inject(StorageService) storage: StorageService,
    @Inject(ConfigService) config: ConfigService<Env, true>,
    @Inject(PinoLogger) logger: PinoLogger,
  ) {
    super({ db, blobs: storage, suitesDir: config.get('SUITES_DIR', { infer: true }), logger });
    this.log = logger;
    this.log.setContext(SuiteLoaderService.name);
  }

  /**
   * The load every worker start performs (plan 4.4: suites load at start).
   * Never throws: a start with an unreadable SUITES_DIR or an unreachable
   * database logs the reason and leaves the last loaded versions served.
   */
  async loadAtStartup(): Promise<SuiteReloadResult | null> {
    try {
      return await this.loadAll();
    } catch (err) {
      this.log.error({ err }, 'suites could not be loaded at start');
      return null;
    }
  }
}
