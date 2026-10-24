import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.js';
import { BlobStore } from './blob-store.js';

/** Leftovers in DATA_DIR/tmp older than this are removed at start. */
const TMP_MAX_AGE_MS = 24 * 3600 * 1000;

/**
 * The blob store at DATA_DIR, as a Nest provider shared by the API and the
 * worker. Inject StorageService and call the BlobStore methods on it.
 */
@Injectable()
export class StorageService extends BlobStore implements OnModuleInit {
  constructor(
    config: ConfigService<Env, true>,
    private readonly logger: PinoLogger,
  ) {
    super(config.get('DATA_DIR', { infer: true }));
    this.logger.setContext(StorageService.name);
  }

  /** Clears what a crash left in DATA_DIR/tmp. A failure here never stops startup. */
  async onModuleInit(): Promise<void> {
    try {
      const removed = await this.sweepTmp(TMP_MAX_AGE_MS);
      if (removed > 0) this.logger.info({ removed }, 'removed stale temp entries');
    } catch (err) {
      this.logger.warn({ err, dataDir: this.dataDir }, 'could not sweep DATA_DIR/tmp');
    }
  }
}
