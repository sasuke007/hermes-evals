import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseErrorFilter } from './common/database-error.filter.js';
import { RequestedWithGuard } from './common/requested-with.guard.js';
import { validateEnv } from './config/env.js';
import { ConfigurationsModule } from './configurations/configurations.module.js';
import { DatabaseModule } from './database/database.module.js';
import { ExperimentCommandsModule } from './experiments/commands/experiment-commands.module.js';
import { ComparisonModule } from './experiments/comparison/comparison.module.js';
import { ExperimentViewsModule } from './experiments/experiment-views.module.js';
import { HealthModule } from './health/health.module.js';
import { ProvidersModule } from './providers/providers.module.js';
import { QueueModule } from './queue/queue.module.js';
import { CountsModule } from './resources/counts/counts.module.js';
import { DocumentsModule } from './resources/documents/documents.module.js';
import { McpModule } from './resources/mcp/mcp.module.js';
import { SecretsModule } from './resources/secrets/secrets.module.js';
import { SkillsModule } from './resources/skills/skills.module.js';
import { RunCommandsModule } from './runs/commands/run-commands.module.js';
import { RunViewsModule } from './runs/views/run-views.module.js';
import { SamplesModule } from './samples/samples.module.js';
import { StorageModule } from './storage/storage.module.js';
import { SuiteDraftsModule } from './suites/drafts/drafts.module.js';
import { SuiteDraftsService } from './suites/drafts/drafts.service.js';
import { SuiteImportModule } from './suites/import/suite-import.module.js';
import { DraftSaveModule } from './suites/save/draft-save.module.js';
import { SuitesModule } from './suites/suites.module.js';
import { SystemEventsModule } from './system/events/system-events.module.js';
import { SystemModule } from './system/system.module.js';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * The HTTP API. It reads and writes definitions in Postgres and blobs under
 * DATA_DIR, launches and controls experiments, and hands anything that runs
 * user code (loading suites, testing an MCP server, running a trial, scoring)
 * to the worker through pg-boss; it never reads SUITES_DIR or the trials
 * volume. Every state-changing route needs X-Requested-With
 * (RequestedWithGuard), and an integrity violation the services did not
 * foresee answers 4xx, not 500 (DatabaseErrorFilter).
 *
 * Order matters for three imports. ProvidersModule brings the global
 * NousLoginModule, which provides PROVIDER_READINESS_DEPS to the commands'
 * ProviderGate. ExperimentCommandsModule comes before ExperimentViewsModule:
 * Express matches routes in registration order, and GET /experiments/:id
 * would otherwise answer /experiments/new-options and /experiments/estimate.
 * SuiteDraftsModule comes before SuitesModule for the same reason: GET
 * /suites/:id would otherwise answer GET /suites/drafts. ComparisonModule is
 * global, so the views and the live stream share its cache; its route has
 * two segments after /experiments and no order concern.
 *
 * Suite authoring (Phase 5b, plan 4.6) is three modules: the drafts
 * (SuiteDraftsModule), the CSV, JSONL and zip imports, which add to a draft
 * through the drafts module's DraftImportPort, and the routes that need the
 * worker (DraftSaveModule: a draft task's self-check, the save, the rebase).
 * The API still never reads SUITES_DIR; the worker's save handler writes it.
 *
 * SamplesModule (Phase 8) seeds SAMPLES_DIR's samples at each start, after
 * every module's init (so after the migrations), in the background, and
 * serves GET /system/setup.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      envFilePath: ['.env', '../../.env'],
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        transport: isDev
          ? {
              target: 'pino-pretty',
              options: { singleLine: true, colorize: true },
            }
          : undefined,
      },
    }),
    DatabaseModule,
    QueueModule,
    StorageModule,
    HealthModule,
    SuiteDraftsModule,
    SuitesModule,
    SuiteImportModule.withDrafts({ imports: [SuiteDraftsModule], port: SuiteDraftsService }),
    DraftSaveModule,
    SkillsModule,
    DocumentsModule,
    McpModule,
    SecretsModule,
    CountsModule,
    ConfigurationsModule,
    SystemModule,
    SystemEventsModule,
    ProvidersModule,
    ExperimentCommandsModule,
    RunCommandsModule,
    ExperimentViewsModule,
    ComparisonModule,
    RunViewsModule,
    SamplesModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RequestedWithGuard },
    { provide: APP_FILTER, useClass: DatabaseErrorFilter },
  ],
})
export class AppModule {}
