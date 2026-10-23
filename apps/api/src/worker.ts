import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker/worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.init();
  app.get(Logger).log('worker started');
}

await bootstrap();
