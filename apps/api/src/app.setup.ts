import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostAllowlist, hostPolicy } from './common/host-allowlist.js';
import type { Env } from './config/env.js';
import { setupApiDocs } from './openapi/document.js';

/**
 * What the API process sets up around AppModule: the Host allowlist first
 * (DNS rebinding, plan 6.1), so it covers every route, the docs and 404s;
 * the /api prefix; CORS for the web origin only (so another site's preflight
 * fails) and the docs at /api/docs. Shared by main.ts and the
 * full-application e2e spec.
 */
export function configureApi(app: INestApplication): void {
  const config = app.get(ConfigService<Env, true>);
  const corsOrigin = config.get('CORS_ORIGIN', { infer: true });
  app.use(hostAllowlist(hostPolicy(corsOrigin, config.get('ALLOWED_HOSTS', { infer: true }))));
  app.setGlobalPrefix('api');
  app.enableCors({ origin: corsOrigin });
  setupApiDocs(app);
}
