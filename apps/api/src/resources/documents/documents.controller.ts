import {
  Controller,
  Get,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DocumentRowSchema, type DocumentRow } from '@hermes-evals/shared';
import type { Response } from 'express';
import { ApiFileResponse, ApiFileUpload, ApiJsonResponse } from '../../openapi/decorators.js';
import { badRequest, contentDisposition, streamFailure } from '../skills/http.js';
import { SingleFileUpload, type UploadedFileRef } from '../skills/multipart-upload.js';
import { DocumentsService } from './documents.service.js';

/** The document upload cap (plan 5.2). */
export const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

@ApiTags('resources')
@Controller('resources/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  @ApiJsonResponse(DocumentRowSchema, { array: true, description: 'Every stored document' })
  list(): Promise<DocumentRow[]> {
    return this.documents.list();
  }

  /** Stores the file in multipart field `file` (50 MB cap; 413 above it). */
  @Post()
  @UseInterceptors(SingleFileUpload('file', DOCUMENT_MAX_BYTES))
  @ApiFileUpload('file', 'The document, at most 50 MB')
  @ApiJsonResponse(DocumentRowSchema, { status: 201, description: 'The stored document' })
  upload(@UploadedFile() file: UploadedFileRef | undefined): Promise<DocumentRow> {
    if (!file) throw badRequest("attach the document as the multipart field 'file'");
    return this.documents.upload(file);
  }

  /**
   * The file itself. Types a browser can only display (PDF, images, plain
   * text) open inline; anything else downloads. nosniff stops a browser from
   * reading a stored file as HTML.
   */
  @Get(':id/content')
  @ApiFileResponse('The document file', [
    'application/pdf',
    'text/plain',
    'application/octet-stream',
  ])
  async content(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const content = await this.documents.content(id);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(content.stream, {
      type: content.contentType,
      length: content.size,
      disposition: contentDisposition(content.disposition, content.filename),
    }).setErrorHandler(streamFailure);
  }
}
