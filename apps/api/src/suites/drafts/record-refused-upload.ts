/**
 * Uploads refused for their size, kept on the draft task (Phase 5b question
 * 11, settled for Phase 7). multer refuses a file over
 * AUTHORING_LIMITS.suiteMaxFileBytes before the upload's handler runs, so
 * this interceptor, placed around the upload's own (SingleFileUpload), sees
 * the 413 and records the refusal (DraftFilesService.recordRefused) before
 * answering it unchanged. It reads the route's suite and key, the `kind` and
 * `path` fields multer parsed before the file part (a client sends them
 * first), and the file's own name when `path` is absent. A refusal it cannot
 * record (the fields sent after the file, an unknown task, a save running)
 * still answers the same 413.
 */
import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { catchError, from, type Observable } from 'rxjs';
import { z } from 'zod';
import {
  DraftFileUploadFieldsSchema,
  DraftTaskKeySchema,
  SuiteFolderSchema,
} from '@hermes-evals/shared';
import { uploadFileName } from '../../resources/skills/format.js';
import { uploadNameOf } from '../../resources/skills/multipart-upload.js';
import { DraftFilesService } from './draft-files.service.js';

const RouteSchema = z.object({ suite: SuiteFolderSchema, key: DraftTaskKeySchema });

const isTooLarge = (err: unknown): boolean =>
  err instanceof HttpException && err.getStatus() === Number(HttpStatus.PAYLOAD_TOO_LARGE);

@Injectable()
export class RecordRefusedUpload implements NestInterceptor {
  // No work in the constructor: the OpenAPI document builds the route's interceptors with stand-ins.
  constructor(
    @Inject(DraftFilesService) private readonly files: DraftFilesService,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<Request>();
    return next.handle().pipe(
      catchError((err: unknown) =>
        from(
          (async () => {
            if (isTooLarge(err)) await this.record(request);
            throw err;
          })(),
        ),
      ),
    );
  }

  /** Records the refusal of the request's upload, when the request says enough to place it. */
  private async record(request: Request): Promise<void> {
    const route = RouteSchema.safeParse(request.params);
    const fields = DraftFileUploadFieldsSchema.safeParse({ ...(request.body as object) });
    const sent = uploadNameOf(request);
    if (!route.success || !fields.success) return;
    const name = fields.data.path ?? (sent === undefined ? null : uploadFileName(sent, 'file'));
    if (name === null) return;
    try {
      await this.files.recordRefused(route.data.suite, route.data.key, {
        kind: fields.data.kind,
        name,
        sizeBytes: null,
      });
    } catch (err) {
      const where = `${route.data.suite}/${route.data.key}`;
      this.logger.warn(
        { err, context: RecordRefusedUpload.name },
        `an upload refused for its size was not recorded on ${where}`,
      );
    }
  }
}
