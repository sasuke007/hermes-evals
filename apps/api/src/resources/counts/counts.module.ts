import { Module } from '@nestjs/common';
import { SecretsModule } from '../secrets/secrets.module.js';
import { CountsController } from './counts.controller.js';
import { CountsService } from './counts.service.js';

/** /resources/counts. Needs the global DatabaseModule (DB). */
@Module({
  imports: [SecretsModule],
  controllers: [CountsController],
  providers: [CountsService],
})
export class CountsModule {}
