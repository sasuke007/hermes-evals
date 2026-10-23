import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.js';
import { DatabaseModule } from './database/database.module.js';
import { QueueModule } from './queue/queue.module.js';
import { HealthModule } from './health/health.module.js';

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
    HealthModule,
  ],
})
export class AppModule {}
