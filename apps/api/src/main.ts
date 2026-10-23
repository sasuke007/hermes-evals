import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.enableShutdownHooks();
  app.setGlobalPrefix('api');

  const config = app.get(ConfigService<Env, true>);
  app.enableCors({ origin: config.get('CORS_ORIGIN', { infer: true }) });

  const doc = new DocumentBuilder()
    .setTitle('Hermes Evals API')
    .setDescription(
      'Define tasks and configurations, run Hermes under each, compare with evidence.',
    )
    .setVersion('0.1.0')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc));

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  logger.log(`API listening on http://localhost:${port}/api · docs at /api/docs`);
}

await bootstrap();
