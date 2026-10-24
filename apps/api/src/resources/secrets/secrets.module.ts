import { Module } from '@nestjs/common';
import { SecretsController } from './secrets.controller.js';
import { SecretsService } from './secrets.service.js';

/** /resources/secrets. Needs the global DatabaseModule (DB). */
@Module({
  controllers: [SecretsController],
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SecretsModule {}
