import { Module } from '@nestjs/common';
import { NousLoginModule } from './nous-login.module.js';
import { ProvidersController } from './providers.controller.js';
import { ProvidersService } from './providers.service.js';

/**
 * GET /providers and the Nous Portal login routes (plan 6.1). Needs
 * DatabaseModule (global) and ConfigModule; brings NousLoginModule, which is
 * global, so importing this module also provides PROVIDER_READINESS_DEPS to
 * the experiment commands.
 */
@Module({
  imports: [NousLoginModule],
  controllers: [ProvidersController],
  providers: [ProvidersService],
  exports: [ProvidersService],
})
export class ProvidersModule {}
