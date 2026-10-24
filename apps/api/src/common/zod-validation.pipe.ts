import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Validates a request body, query or params against a zod schema and returns
 * the parsed (typed, defaulted) value. Used per handler: @Body(new ZodValidationPipe(Schema)).
 * A failure is a 400 with the API's error body, `{ statusCode, message, issues }`,
 * one issue per problem with its dotted path (`headers.0.env`).
 */
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Validation failed',
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    return result.data;
  }
}
