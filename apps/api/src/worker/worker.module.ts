import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../config/env.js';
import { DatabaseModule } from '../database/database.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { SandboxService } from '../sandbox/sandbox.service.js';
import { StorageModule } from '../storage/storage.module.js';
import { SuiteLoaderService } from '../suites/loader/suite-loader.service.js';
import { WorkerPresenceService } from './presence/worker-presence.service.js';
import { WorkerService } from './worker.service.js';

const isDev = process.env.NODE_ENV !== 'production';

/**
 * The worker process: everything that runs user code. It loads suites
 * (verifier scripts are user code), tests MCP servers and, from Phase 2,
 * executes trials, each in its own container through docker-guard.
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
  ],
  providers: [SandboxService, WorkerPresenceService, SuiteLoaderService, WorkerService],
})
export class WorkerModule {}
