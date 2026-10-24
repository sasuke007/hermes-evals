/**
 * Configuration routes (plan sections 6 and 11, UI_FLOWS 10). Request bodies
 * are checked with the shared schemas; every response is parsed with its
 * shared view-model schema on the way out, so the API cannot drift from the
 * contract the web reads (and unknown fields never leak).
 */
import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import {
  ConfigDiffSchema,
  ConfigurationDetailSchema,
  ConfigurationDraftSchema,
  ConfigurationFormOptionsSchema,
  ConfigurationInputSchema,
  ConfigurationListRowSchema,
  ConfigurationSaveResultSchema,
  type ConfigDiff,
  type ConfigurationDetail,
  type ConfigurationDraft,
  type ConfigurationFormOptions,
  type ConfigurationInput,
  type ConfigurationListRow,
  type ConfigurationSaveResult,
} from '@hermes-evals/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ApiJsonBody, ApiJsonResponse } from '../openapi/decorators.js';
import { ConfigurationReadsService } from './configuration-reads.service.js';
import { ConfigurationWritesService } from './configuration-writes.service.js';
import { ConfigurationFormOptionsService } from './form-options.service.js';

/** `?versions=a,b,c`: two or three distinct configuration version ids. */
export const DiffQuerySchema = z.object({
  versions: z
    .string({
      error: 'versions is required: two or three configuration version ids, comma-separated',
    })
    .transform((s) =>
      s
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v !== ''),
    )
    .pipe(
      z
        .array(z.string())
        .min(2, 'compare two or three configuration versions')
        .max(3, 'compare two or three configuration versions')
        .refine((ids) => new Set(ids).size === ids.length, 'a version is listed twice'),
    ),
});

/** `:version` of /configurations/:id/versions/:version, a positive version number. */
const VersionNumberSchema = z.coerce
  .number({ error: 'the version is a number, e.g. 2' })
  .int('the version is a whole number')
  .positive('versions start at 1');

@ApiTags('configurations')
@Controller('configurations')
export class ConfigurationsController {
  constructor(
    private readonly reads: ConfigurationReadsService,
    private readonly writes: ConfigurationWritesService,
    private readonly options: ConfigurationFormOptionsService,
  ) {}

  @Get()
  @ApiJsonResponse(ConfigurationListRowSchema, {
    array: true,
    description: 'Every configuration at its latest version',
  })
  async list(): Promise<ConfigurationListRow[]> {
    return z.array(ConfigurationListRowSchema).parse(await this.reads.list());
  }

  @Post()
  @ApiJsonBody(ConfigurationInputSchema)
  @ApiJsonResponse(ConfigurationSaveResultSchema, {
    status: 201,
    description: 'Creates a configuration and its version 1',
  })
  async create(
    @Body(new ZodValidationPipe(ConfigurationInputSchema)) input: ConfigurationInput,
  ): Promise<ConfigurationSaveResult> {
    return ConfigurationSaveResultSchema.parse(await this.writes.create(input));
  }

  // Literal paths before ':id', or Express would read them as ids.
  @Get('diff')
  @ApiQuery({
    name: 'versions',
    type: String,
    required: true,
    description: 'Two or three configuration version ids, comma-separated',
  })
  @ApiJsonResponse(ConfigDiffSchema, {
    description: 'One row per field across 2-3 configuration versions',
  })
  async diff(
    @Query(new ZodValidationPipe(DiffQuerySchema)) query: z.infer<typeof DiffQuerySchema>,
  ): Promise<ConfigDiff> {
    return ConfigDiffSchema.parse(await this.reads.diff(query.versions));
  }

  @Get('form-options')
  @ApiJsonResponse(ConfigurationFormOptionsSchema, {
    description: 'Models, providers, toolsets and resources the form offers',
  })
  async formOptions(): Promise<ConfigurationFormOptions> {
    return ConfigurationFormOptionsSchema.parse(await this.options.formOptions());
  }

  @Get(':id')
  @ApiJsonResponse(ConfigurationDetailSchema, {
    description: 'A configuration at its latest version, with history and usage',
  })
  async detail(@Param('id') id: string): Promise<ConfigurationDetail> {
    return ConfigurationDetailSchema.parse(await this.reads.detail(id));
  }

  @Put(':id')
  @ApiJsonBody(ConfigurationInputSchema)
  @ApiJsonResponse(ConfigurationSaveResultSchema, {
    description: 'Saves an edit: in place, or as the next version when frozen',
  })
  async update(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(ConfigurationInputSchema)) input: ConfigurationInput,
  ): Promise<ConfigurationSaveResult> {
    return ConfigurationSaveResultSchema.parse(await this.writes.update(id, input));
  }

  @Get(':id/versions/:version')
  @ApiJsonResponse(ConfigurationDetailSchema, {
    description: 'A configuration shown at one of its versions',
  })
  async version(
    @Param('id') id: string,
    @Param('version', new ZodValidationPipe(VersionNumberSchema)) version: number,
  ): Promise<ConfigurationDetail> {
    return ConfigurationDetailSchema.parse(await this.reads.detail(id, version));
  }

  /** Stores nothing, so 200 rather than 201. */
  @Post(':id/duplicate')
  @HttpCode(200)
  @ApiJsonResponse(ConfigurationDraftSchema, {
    description: 'A prefilled draft copying the latest version; nothing is stored',
  })
  async duplicate(@Param('id') id: string): Promise<ConfigurationDraft> {
    return ConfigurationDraftSchema.parse(await this.reads.duplicateDraft(id));
  }

  @Get(':id/draft')
  @ApiJsonResponse(ConfigurationDraftSchema, {
    description: 'The edit form for the latest version',
  })
  async draft(@Param('id') id: string): Promise<ConfigurationDraft> {
    return ConfigurationDraftSchema.parse(await this.reads.editDraft(id));
  }
}
