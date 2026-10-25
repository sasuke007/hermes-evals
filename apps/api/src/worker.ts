import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { WorkerModule } from './worker/worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  // A rejection that escaped every handler leaves the worker in a state nothing
  // accounts for. Log it, hand running attempts back as a shutdown does (for at
  // most 30 s), and exit non-zero: the container's restart policy starts a fresh
  // process, whose recovery pass at start (plan 8.6) stops and ends whatever
  // trials this one left, instead of carrying on half broken.
  let exiting = false;
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection; exiting so the worker restarts clean');
    if (exiting) return;
    exiting = true;
    setTimeout(() => process.exit(1), 30_000).unref();
    void app
      .close()
      .catch(() => {})
      .finally(() => process.exit(1));
  });
  app.enableShutdownHooks();
  await app.init();
  logger.log('worker started');
}

await bootstrap();
