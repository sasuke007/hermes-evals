/**
 * The OpenAPI document served at /api/docs. Nest's scanner supplies routes,
 * parameters and tags; schemas.ts supplies the JSON Schemas, converted from
 * the shared zod contracts; this file joins them and adds what every route
 * shares: the error body, and the 403 of RequestedWithGuard on the routes
 * that change state.
 */
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { STATE_CHANGING_METHODS } from '../common/requested-with.guard.js';
import { componentRef, openApiComponents } from './schemas.js';

export const API_DOCS_PATH = 'api/docs';

const DESCRIPTION = [
  'Define tasks and configurations, run Hermes under each, compare with evidence.',
  '',
  'Every POST, PUT and DELETE must send an `X-Requested-With` header (any value) and a JSON or',
  'multipart body, so another site open in the browser cannot drive this unauthenticated API.',
  '"Try it out" on this page adds both. Errors answer `{ statusCode, message, issues? }`.',
].join('\n');

type Operation = {
  responses?: Record<string, unknown>;
};

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: componentRef('ApiErrorBody') } },
});

/** The full document: Nest's scan, the zod components, and the shared error responses. */
export function buildApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Hermes Evals API')
    .setDescription(DESCRIPTION)
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  document.components = {
    ...document.components,
    schemas: { ...document.components?.schemas, ...openApiComponents() },
  };
  for (const item of Object.values(document.paths)) {
    for (const [method, operation] of Object.entries(item) as [string, Operation][]) {
      if (!operation || typeof operation !== 'object' || !('responses' in operation)) continue;
      const responses = (operation.responses ??= {});
      if (STATE_CHANGING_METHODS.has(method.toUpperCase())) {
        responses['403'] ??= errorResponse(
          'Missing X-Requested-With header, or a body that is neither JSON nor multipart',
        );
      }
      responses['default'] ??= errorResponse('Error');
    }
  }
  return document;
}

/**
 * Runs in the browser, inside Swagger UI, before each "Try it out" request:
 * adds the header RequestedWithGuard asks for and, for a state-changing
 * request without a body, an empty JSON one. Swagger UI serialises it with
 * toString(), so it must not reference anything outside itself.
 */
export function swaggerRequestInterceptor(req: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): typeof req {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const headers = (req.headers ??= {});
    headers['X-Requested-With'] = 'swagger-ui';
    const hasType = Object.keys(headers).some((name) => name.toLowerCase() === 'content-type');
    if (!hasType && (req.body === undefined || req.body === null || req.body === '')) {
      headers['Content-Type'] = 'application/json';
      req.body = '{}';
    }
  }
  return req;
}

/** Serves the UI at /api/docs and the document at /api/docs-json. */
export function setupApiDocs(app: INestApplication): OpenAPIObject {
  const document = buildApiDocument(app);
  SwaggerModule.setup(API_DOCS_PATH, app, document, {
    swaggerOptions: { requestInterceptor: swaggerRequestInterceptor },
  });
  return document;
}
