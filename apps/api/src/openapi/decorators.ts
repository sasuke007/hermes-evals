/**
 * Route decorators that document a handler with the shared zod contracts
 * (schemas.ts). They reference `components.schemas` by name, which
 * buildApiDocument fills in, so a controller states what it returns next to
 * the handler and never restates the shape.
 */
import { applyDecorators } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiProduces, ApiResponse } from '@nestjs/swagger';
import type { ZodType } from 'zod';
import { componentRef, schemaName, type JsonSchemaObject } from './schemas.js';

export interface JsonResponseOptions {
  description: string;
  /** Default 200. */
  status?: number;
  /** The body is a list of the schema. */
  array?: boolean;
  /** The body may be the JSON literal `null`. */
  nullable?: boolean;
}

/** A JSON response whose body parses with `schema`. */
export function ApiJsonResponse(schema: ZodType, options: JsonResponseOptions): MethodDecorator {
  const ref = componentRef(schemaName(schema));
  let body: JsonSchemaObject = options.array ? { type: 'array', items: ref } : ref;
  // OpenAPI 3.0 ignores siblings of $ref, so a nullable reference goes through allOf.
  if (options.nullable) body = { nullable: true, allOf: [body] };
  return ApiResponse({
    status: options.status ?? 200,
    description: options.description,
    schema: body,
  });
}

/** A JSON request body that parses with `schema`. */
export function ApiJsonBody(
  schema: ZodType,
  options: { description?: string; required?: boolean } = {},
): MethodDecorator {
  return ApiBody({
    schema: componentRef(schemaName(schema)),
    description: options.description,
    required: options.required ?? true,
  });
}

/** One file in the multipart field `field`. */
export function ApiFileUpload(field: string, description: string): MethodDecorator {
  return applyDecorators(
    ApiConsumes('multipart/form-data'),
    ApiBody({
      description,
      schema: {
        type: 'object',
        required: [field],
        properties: { [field]: { type: 'string', format: 'binary' } },
      },
    }),
  );
}

/**
 * A server-sent event stream (text/event-stream). Each message is
 * `event: <type>` and `data:` the whole event as JSON, which parses with
 * `schema`; comment lines keep the connection open.
 */
export function ApiEventStream(schema: ZodType, description: string): MethodDecorator {
  return applyDecorators(
    ApiProduces('text/event-stream'),
    ApiResponse({
      status: 200,
      description: `${description} Each message: \`event: <type>\` and \`data: <the event as JSON>\`; the schema is one event. A comment line keeps the connection open every 15 s.`,
      content: { 'text/event-stream': { schema: componentRef(schemaName(schema)) } },
    }),
  );
}

/** A file download: raw bytes of one of `mediaTypes`. */
export function ApiFileResponse(description: string, mediaTypes: string[]): MethodDecorator {
  return applyDecorators(
    ApiProduces(...mediaTypes),
    ApiResponse({ status: 200, description, schema: { type: 'string', format: 'binary' } }),
  );
}
