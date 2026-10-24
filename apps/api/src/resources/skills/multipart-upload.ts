/**
 * Multipart uploads for the resource endpoints: one file per request, written
 * to its own scratch directory under DATA_DIR/tmp and removed once the
 * handler is done, whatever happened. Used by skill validation (the zip) and
 * document upload.
 *
 * multer itself is a dependency of @nestjs/platform-express, not of this
 * package, so its disk storage cannot be imported; ScratchDiskStorage is the
 * same idea against the StorageEngine interface. The size cap is multer's
 * own `limits.fileSize`, which stops reading at the cap and answers 413.
 */
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  Injectable,
  mixin,
  type NestInterceptor,
  PayloadTooLargeException,
  type Type,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import type { StorageEngine } from 'multer';
import { finalize, type Observable } from 'rxjs';
import type { BlobStore } from '../../storage/blob-store.js';
import { StorageService } from '../../storage/storage.service.js';
import { formatBytes } from './format.js';
import { badRequest, payloadTooLarge } from './http.js';

/** The uploaded file a handler receives; `path` is inside its own scratch directory. */
export type UploadedFileRef = Express.Multer.File;

/** multer storage engine: each file goes to DATA_DIR/tmp/upload-XXXXXX/file. */
export class ScratchDiskStorage implements StorageEngine {
  constructor(private readonly store: BlobStore) {}

  _handleFile(
    _req: Request,
    file: Express.Multer.File,
    callback: (error?: unknown, info?: Partial<Express.Multer.File>) => void,
  ): void {
    void this.store.tmpDir('upload').then(
      async (destination) => {
        const path = join(destination, 'file');
        let size = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            size += chunk.length;
            done(null, chunk);
          },
        });
        try {
          await pipeline(
            file.stream,
            counter,
            createWriteStream(path, { flags: 'wx', mode: 0o600 }),
          );
          callback(null, { destination, filename: 'file', path, size });
        } catch (err) {
          await rm(destination, { recursive: true, force: true });
          callback(err);
        }
      },
      (err: unknown) => callback(err),
    );
  }

  _removeFile(
    _req: Request,
    file: Express.Multer.File,
    callback: (error: Error | null) => void,
  ): void {
    removeUpload(file).then(
      () => callback(null),
      (err: unknown) => callback(err as Error),
    );
  }
}

/** Removes an uploaded file's scratch directory. */
export async function removeUpload(file: Partial<Express.Multer.File> | undefined): Promise<void> {
  if (file?.destination) await rm(file.destination, { recursive: true, force: true });
}

/**
 * Nest turns multer's refusals into HttpExceptions with an `error` field and
 * multer's wording; these are the same refusals in the API's error body.
 * Nest names an unexpected field "Unexpected file field - <name>".
 */
function multipartRefusal(err: BadRequestException, field: string): BadRequestException {
  if (/^(Unexpected file field|Too many files)\b/.test(err.message)) {
    return badRequest(`send one file, in the multipart field '${field}'`);
  }
  return badRequest(`the multipart body was refused: ${err.message}`);
}

/**
 * An interceptor that accepts one file in multipart field `field`, at most
 * `maxBytes` long, for `@UploadedFile()`. Over the cap it answers 413 with
 * the cap in the message. The scratch copy is removed after the handler.
 */
export function SingleFileUpload(field: string, maxBytes: number): Type<NestInterceptor> {
  @Injectable()
  class SingleFileUploadInterceptor implements NestInterceptor {
    private readonly multer: NestInterceptor;

    constructor(storage: StorageService) {
      const Multer = FileInterceptor(field, {
        storage: new ScratchDiskStorage(storage),
        limits: { fileSize: maxBytes, files: 1, fields: 8, parts: 9 },
        // Browsers send file names as UTF-8; busboy would read them as latin1.
        defParamCharset: 'utf8',
      });
      this.multer = new Multer();
    }

    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
      const request = context.switchToHttp().getRequest<Request>();
      let handled: Observable<unknown>;
      try {
        handled = (await this.multer.intercept(context, next)) as Observable<unknown>;
      } catch (err) {
        if (err instanceof PayloadTooLargeException) {
          throw payloadTooLarge(`the file is larger than ${formatBytes(maxBytes)}`);
        }
        if (err instanceof BadRequestException) throw multipartRefusal(err, field);
        throw err;
      }
      return handled.pipe(finalize(() => void removeUpload(request.file)));
    }
  }
  return mixin(SingleFileUploadInterceptor);
}
