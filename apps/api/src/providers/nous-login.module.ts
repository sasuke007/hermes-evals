import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { PROVIDER_READINESS_DEPS } from '../experiments/commands/provider-gate.js';
import { NOUS_LOGIN_CLIENT, NousLoginClient } from './nous-login.client.js';
import { nousReadinessDeps } from './readiness.js';

/** NOUS_LOGIN_URL's default, for test harnesses whose ConfigService knows no keys. */
const DEFAULT_NOUS_LOGIN_URL = 'http://nous-login:8650';

/**
 * The nous-login client (NOUS_LOGIN_CLIENT) and the readiness deps every
 * provider check uses (PROVIDER_READINESS_DEPS: the launch, Resume and Retry
 * gate in the API, the provider guard in the worker). Global, so the API's
 * ProvidersModule and the commands share one client, and the worker gets the
 * same rule by importing this module alone. Needs ConfigModule.
 */
@Global()
@Module({
  providers: [
    {
      provide: NOUS_LOGIN_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new NousLoginClient(
          config.get('NOUS_LOGIN_URL', { infer: true }) ?? DEFAULT_NOUS_LOGIN_URL,
        ),
    },
    {
      provide: PROVIDER_READINESS_DEPS,
      inject: [NOUS_LOGIN_CLIENT],
      useFactory: (client: NousLoginClient) => nousReadinessDeps(client),
    },
  ],
  exports: [NOUS_LOGIN_CLIENT, PROVIDER_READINESS_DEPS],
})
export class NousLoginModule {}
