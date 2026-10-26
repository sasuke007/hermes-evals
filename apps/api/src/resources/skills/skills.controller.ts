import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ApiNoContentResponse, ApiNotFoundResponse, ApiParam, ApiTags } from '@nestjs/swagger';
import {
  ResourceInUseBodySchema,
  SkillConfirmRequestSchema,
  SkillDetailSchema,
  SkillFileContentSchema,
  SkillRowSchema,
  SkillUploadValidationSchema,
  type SkillConfirmRequest,
  type SkillDetail,
  type SkillFileContent,
  type SkillRow,
  type SkillUploadValidation,
} from '@hermes-evals/shared';
import { ZodValidationPipe } from '../../common/zod-validation.pipe.js';
import {
  ApiFileResponse,
  ApiFileUpload,
  ApiJsonBody,
  ApiJsonResponse,
} from '../../openapi/decorators.js';
import { badRequest, contentDisposition, streamFailure } from './http.js';
import { SingleFileUpload, type UploadedFileRef } from './multipart-upload.js';
import { SkillsService } from './skills.service.js';

/** The zip upload cap (plan 5.1). */
export const SKILL_ZIP_MAX_BYTES = 20 * 1024 * 1024;

@ApiTags('resources')
@Controller('resources/skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Get()
  @ApiJsonResponse(SkillRowSchema, { array: true, description: 'Every stored skill version' })
  list(): Promise<SkillRow[]> {
    return this.skills.list();
  }

  /** Step 1 of 2: checks a zip (multipart field `file`) and stores nothing. */
  @Post('validate')
  @HttpCode(200)
  @UseInterceptors(SingleFileUpload('file', SKILL_ZIP_MAX_BYTES))
  @ApiFileUpload('file', 'The skill as a zip, at most 20 MB')
  @ApiJsonResponse(SkillUploadValidationSchema, {
    description: 'What the zip holds and whether it can be stored; a token to confirm with',
  })
  validate(@UploadedFile() file: UploadedFileRef | undefined): Promise<SkillUploadValidation> {
    if (!file) throw badRequest("attach the skill zip as the multipart field 'file'");
    return this.skills.validate(file);
  }

  /** Step 2 of 2: stores the upload a validation token names. */
  @Post()
  @ApiJsonBody(SkillConfirmRequestSchema)
  @ApiJsonResponse(SkillRowSchema, { status: 201, description: 'The stored skill' })
  confirm(
    @Body(new ZodValidationPipe(SkillConfirmRequestSchema)) body: SkillConfirmRequest,
  ): Promise<SkillRow> {
    return this.skills.confirm(body.token);
  }

  @Get(':id')
  @ApiJsonResponse(SkillDetailSchema, { description: 'The skill, its SKILL.md and its files' })
  detail(@Param('id') id: string): Promise<SkillDetail> {
    return this.skills.detail(id);
  }

  /** Only a skill no configuration version names (Phase 5 section 6.1). */
  @Delete(':id')
  @HttpCode(204)
  @ApiNoContentResponse({ description: 'Deleted' })
  @ApiNotFoundResponse({ description: 'No such skill' })
  @ApiJsonResponse(ResourceInUseBodySchema, {
    status: 409,
    description:
      "A configuration version names the skill: the configurations in `usedBy` (the row's `inUseBy`)",
  })
  remove(@Param('id') id: string): Promise<void> {
    return this.skills.remove(id);
  }

  /** `path` is one URL-encoded segment, e.g. examples%2Freconcile.py. */
  @Get(':id/files/:path')
  @ApiParam({ name: 'path', description: 'Path in the skill, URL-encoded as one segment' })
  @ApiJsonResponse(SkillFileContentSchema, {
    description: 'One file of the skill; content is null for binary or large files',
  })
  file(@Param('id') id: string, @Param('path') path: string): Promise<SkillFileContent> {
    return this.skills.file(id, path);
  }

  @Get(':id/zip')
  @ApiFileResponse('The stored skill as a zip', ['application/zip'])
  async zip(@Param('id') id: string): Promise<StreamableFile> {
    const { stream, filename } = await this.skills.zip(id);
    return new StreamableFile(stream, {
      type: 'application/zip',
      disposition: contentDisposition('attachment', filename),
    }).setErrorHandler(streamFailure);
  }
}
