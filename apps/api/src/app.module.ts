import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { DatabaseErrorFilter } from './common/database-error.filter.js';
import { RequestedWithGuard } from './common/requested-with.guard.js';
import { validateEnv } from './config/env.js';
import { ConfigurationsModule } from './configurations/configurations.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { QueueModule } from './queue/queue.module.js';
import { CountsModule } from './resources/counts/counts.module.js';
import { DocumentsModule } from './resources/documents/documents.module.js';
import { McpModule } from './resources/mcp/mcp.module.js';
import { SecretsModule } from './resources/secrets/secrets.module.js';
import { SkillsModule } from './resources/skills/skills.module.js';
import { StorageModule } from './storage/storage.module.js';
import { SuitesModule } from './suites/suites.module.js';
import { SystemModule } from './system/system.module.js';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * The HTTP API. It reads and writes definitions in Postgres and blobs under
 * DATA_DIR, and hands anything that runs user code (loading suites, testing
 * an MCP server) to the worker through pg-boss; it never reads SUITES_DIR.
 * Every state-changing route needs X-Requested-With (RequestedWithGuard), and
 * an integrity violation the services did not foresee answers 4xx, not 500
 * (DatabaseErrorFilter).
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
    SuitesModule,
    SkillsModule,
    DocumentsModule,
    McpModule,
    SecretsModule,
    CountsModule,
    ConfigurationsModule,
    SystemModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: RequestedWithGuard },
    { provide: APP_FILTER, useClass: DatabaseErrorFilter },
  ],
})
export class AppModule {}
