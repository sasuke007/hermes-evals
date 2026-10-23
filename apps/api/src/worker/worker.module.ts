import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from '../config/env.js';
import { DatabaseModule } from '../database/database.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { SandboxService } from '../sandbox/sandbox.service.js';
import { WorkerService } from './worker.service.js';

const isDev = process.env.NODE_ENV !== 'production';

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
  ],
  providers: [SandboxService, WorkerService],
})
export class WorkerModule {}
