/**
 * Runs the samples seed once per API start (Phase 8 G3), after every
 * module's init, so the migrations have run. It runs in the background:
 * the API answers at once, and System shows the seed `running` until it
 * ends. It never fails the start: whatever goes wrong is logged and kept
 * in the report System reads (GET /system/setup).
 */
import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { seedCounts, type SeedItem } from '@hermes-evals/shared';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.js';
import { ConfigurationWritesService } from '../configurations/configuration-writes.service.js';
import { DB } from '../database/db.provider.js';
import { MigrationService } from '../database/migration.service.js';
import type { AppDb } from '../database/types.js';
import { DocumentsService } from '../resources/documents/documents.service.js';
import { McpServersService } from '../resources/mcp/mcp-servers.service.js';
import { SkillsService } from '../resources/skills/skills.service.js';
import { StorageService } from '../storage/storage.service.js';
import { reasonOf } from './seed-resources.js';
import { SeedReporter } from './seed-report.js';
import { seedSamples } from './seed.js';

/** Why the seed cannot start without a migrated database, by MigrationService's state. */
const NO_DATABASE = {
  not_configured: 'no database: DATABASE_URL is not set',
  unavailable: 'the database was not reachable at start; restart the api to seed the samples',
} as const;

@Injectable()
export class SampleSeedService implements OnApplicationBootstrap {
  private running: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly reporter: SeedReporter,
    private readonly migrations: MigrationService,
    @Inject(DB) private readonly db: AppDb,
    private readonly storage: StorageService,
    private readonly skills: SkillsService,
    private readonly documents: DocumentsService,
    private readonly mcpServers: McpServersService,
    private readonly configurations: ConfigurationWritesService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SampleSeedService.name);
  }

  onApplicationBootstrap(): void {
    if (!this.config.get('SEED_SAMPLES', { infer: true })) {
      this.logger.info('samples seed off (SEED_SAMPLES=false)');
      return;
    }
    this.running = this.run();
  }

  /** Settles when this start's seed has ended, however it ended. For tests and shutdown. */
  settled(): Promise<void> {
    return this.running;
  }

  /** One seed over SAMPLES_DIR, reported as it goes. Never rejects. */
  async run(): Promise<void> {
    const samplesDir = this.config.get('SAMPLES_DIR', { infer: true });
    this.reporter.start();
    const state = this.migrations.status();
    if (state !== 'ok') {
      this.stop(NO_DATABASE[state]);
      return;
    }
    this.logger.info({ samplesDir }, 'samples seed started');
    try {
      await seedSamples(
        {
          db: this.db,
          storage: this.storage,
          skills: this.skills,
          documents: this.documents,
          mcpServers: this.mcpServers,
          configurations: this.configurations,
          report: (item) => this.record(item),
        },
        samplesDir,
      );
    } catch (err) {
      this.stop(reasonOf(err), err);
      return;
    }
    this.reporter.finish();
    this.logger.info(seedCounts(this.reporter.report()), 'samples seed done');
  }

  private record(item: SeedItem): void {
    this.reporter.add(item);
    const log = { kind: item.kind, name: item.name, outcome: item.outcome, detail: item.detail };
    if (item.outcome === 'failed') this.logger.warn(log, 'sample not seeded');
    else this.logger.info(log, `sample ${item.outcome}`);
  }

  private stop(error: string, err?: unknown): void {
    this.reporter.fail(error);
    this.logger.error({ err, error, ...seedCounts(this.reporter.report()) }, 'samples seed failed');
  }
}
