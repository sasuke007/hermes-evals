/**
 * Keeps other sites from driving the API (plan 6.1). The API has no login, by
 * requirement, so any page open in the user's browser could otherwise POST
 * to localhost and, say, reload suites, upload a skill or save a
 * configuration. A cross-origin page can send a form or a "simple" fetch
 * without asking first, but not one with a custom header or a JSON body: those
 * need a CORS preflight, which the API grants only to its own web origin.
 *
 * So every state-changing request (POST, PUT, PATCH, DELETE) must carry
 * `X-Requested-With` (any non-empty value) and a JSON or multipart body type.
 * Multipart is a simple type a plain HTML form can send, which is why the
 * header is required as well. The web's liveSend sends both, and the Swagger
 * UI adds them (openapi/document.ts). GET, HEAD and OPTIONS are never
 * refused: they change nothing.
 *
 * That holds only while the other site's requests are cross-origin. Against
 * DNS rebinding, which makes them same-origin, the Host allowlist
 * (host-allowlist.ts) refuses any request for a name the API is not reached
 * by, and this guard also refuses a state-changing request whose Origin is
 * not the web origin or an allowed host (a missing Origin is a non-browser
 * client, such as curl, and passes).
 */
import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Env } from '../config/env.js';
import { hostPolicy, isAllowedOrigin, type HostPolicy } from './host-allowlist.js';

export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

export const MISSING_REQUESTED_WITH = 'missing X-Requested-With header';
export const ORIGIN_NOT_ALLOWED = 'origin not allowed';
export const UNSUPPORTED_BODY_TYPE =
  'state-changing requests must send Content-Type application/json or multipart/form-data';

/** application/json, any +json type, or multipart/form-data, ignoring parameters such as charset. */
export function isAllowedBodyType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const media = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return (
    media === 'application/json' ||
    /^application\/[a-z0-9.+-]+\+json$/.test(media) ||
    media === 'multipart/form-data'
  );
}

/**
 * Why a request must be refused, or null when it may go on. With a policy,
 * a state-changing request's Origin, when it has one, must be allowed too.
 */
export function refusalOf(
  method: string,
  headers: Request['headers'],
  policy?: HostPolicy | null,
): string | null {
  if (!STATE_CHANGING_METHODS.has(method.toUpperCase())) return null;
  const requestedWith = headers['x-requested-with'];
  const value = Array.isArray(requestedWith) ? requestedWith.join('') : requestedWith;
  if (!value || value.trim() === '') return MISSING_REQUESTED_WITH;
  if (!isAllowedBodyType(headers['content-type'])) return UNSUPPORTED_BODY_TYPE;
  const origin = headers.origin;
  if (policy && origin !== undefined && !isAllowedOrigin(policy, origin)) {
    return ORIGIN_NOT_ALLOWED;
  }
  return null;
}

@Injectable()
export class RequestedWithGuard implements CanActivate {
  /** Null without configuration (a test module without ConfigModule): no Origin rule. */
  private readonly policy: HostPolicy | null;

  constructor(@Optional() @Inject(ConfigService) config?: ConfigService<Env, true>) {
    this.policy = config
      ? hostPolicy(
          config.get('CORS_ORIGIN', { infer: true }) ?? '',
          config.get('ALLOWED_HOSTS', { infer: true }),
        )
      : null;
  }

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const refusal = refusalOf(req.method, req.headers, this.policy);
    if (refusal) throw new ForbiddenException({ statusCode: 403, message: refusal });
    return true;
  }
}
