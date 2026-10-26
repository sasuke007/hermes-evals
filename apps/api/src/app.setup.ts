import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AUTHORING_LIMITS } from '@hermes-evals/shared';
import { hostAllowlist, hostPolicy } from './common/host-allowlist.js';
import type { Env } from './config/env.js';
import { setupApiDocs } from './openapi/document.js';

/**
 * The largest JSON body. Express's default, 100 kB, is below one draft text
 * (a prompt, reference.json or task.yaml of up to 1 MiB characters, plan
 * 4.6); a draft task's update may carry several, in multi-byte UTF-8 and
 * with JSON's escapes. Files are multipart, with limits of their own.
 */
export const JSON_BODY_LIMIT_BYTES = 8 * AUTHORING_LIMITS.draftTextMaxChars;

/**
 * What the API process sets up around AppModule: the Host allowlist first
 * (DNS rebinding, plan 6.1), so it covers every route, the docs and 404s;
 * the JSON body limit; the /api prefix; CORS for the web origin only (so
 * another site's preflight fails) and the docs at /api/docs. Shared by
 * main.ts and the full-application e2e specs.
 */
export function configureApi(app: NestExpressApplication): void {
  const config = app.get(ConfigService<Env, true>);
  const corsOrigin = config.get('CORS_ORIGIN', { infer: true });
  app.use(hostAllowlist(hostPolicy(corsOrigin, config.get('ALLOWED_HOSTS', { infer: true }))));
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT_BYTES });
  app.setGlobalPrefix('api');
  app.enableCors({ origin: corsOrigin });
  setupApiDocs(app);
}
