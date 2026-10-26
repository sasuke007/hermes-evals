/**
 * The multipart body of a task import (SA.9): the CSV or JSONL file in field
 * `file`, the shared settings as JSON in the text field `settings`, and the
 * workspace files to share in field `workspace` (one part per file). Every
 * file goes to its own scratch directory under DATA_DIR/tmp (the skill
 * uploads' ScratchDiskStorage) and is removed once the handler is done.
 *
 * multer's per-file cap is a suite file's (AUTHORING_LIMITS.suiteMaxFileBytes);
 * the task file's own, smaller cap is the parser's, which words it for the
 * upload step instead of answering 413.
 */
import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { finalize, type Observable } from 'rxjs';
import { AUTHORING_LIMITS } from '@hermes-evals/shared';
import { formatBytes } from '../../resources/skills/format.js';
import { badRequest, payloadTooLarge } from '../../resources/skills/http.js';
import {
  removeUpload,
  ScratchDiskStorage,
  type UploadedFileRef,
} from '../../resources/skills/multipart-upload.js';
import { StorageService } from '../../storage/storage.service.js';

/** Workspace files one import may share. */
export const MAX_WORKSPACE_FILES = 50;

/** The files of a task import, as `@UploadedFiles()` hands them over. */
export interface TaskImportFiles {
  file?: UploadedFileRef[];
  workspace?: UploadedFileRef[];
}

@Injectable()
export class TaskImportUpload implements NestInterceptor {
  private readonly multer: NestInterceptor;

  constructor(storage: StorageService) {
    const Multer = FileFieldsInterceptor(
      [
        { name: 'file', maxCount: 1 },
        { name: 'workspace', maxCount: MAX_WORKSPACE_FILES },
      ],
      {
        storage: new ScratchDiskStorage(storage),
        limits: {
          fileSize: AUTHORING_LIMITS.suiteMaxFileBytes,
          files: 1 + MAX_WORKSPACE_FILES,
          fields: 4,
          fieldSize: 2 * 1024 * 1024,
        },
        // Browsers send file names as UTF-8; busboy would read them as latin1.
        defParamCharset: 'utf8',
      },
    );
    this.multer = new Multer();
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<Request>();
    let handled: Observable<unknown>;
    try {
      handled = (await this.multer.intercept(context, next)) as Observable<unknown>;
    } catch (err) {
      await removeAll(request);
      if (err instanceof PayloadTooLargeException) {
        throw payloadTooLarge(
          `a file is larger than ${formatBytes(AUTHORING_LIMITS.suiteMaxFileBytes)}`,
        );
      }
      if (err instanceof BadRequestException) {
        throw badRequest(
          `send the task file in the multipart field 'file' and at most ${MAX_WORKSPACE_FILES} workspace files in 'workspace' (${err.message})`,
        );
      }
      throw err;
    }
    return handled.pipe(finalize(() => void removeAll(request)));
  }
}

/** Removes every uploaded file's scratch directory. */
async function removeAll(request: Request): Promise<void> {
  const files = (request.files ?? {}) as TaskImportFiles;
  await Promise.all([...(files.file ?? []), ...(files.workspace ?? [])].map(removeUpload));
}
