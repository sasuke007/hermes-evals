/**
 * The JSON Schemas of /api/docs, derived from the shared zod contracts rather
 * than restated as DTO classes, so the documentation cannot drift from what
 * the API validates and returns. Each named schema becomes one entry of
 * `components.schemas`; a schema that another named schema contains by
 * identity is emitted once and referenced.
 *
 * Request bodies are converted as the parser reads them (io 'input': defaults
 * optional, unknown keys allowed where the schema strips them), view models
 * as the API sends them (io 'output').
 */
import {
  ApiErrorBodySchema,
  ConfigDiffSchema,
  ConfigurationDetailSchema,
  ConfigurationDraftSchema,
  ConfigurationFormOptionsSchema,
  ConfigurationInputSchema,
  ConfigurationListRowSchema,
  ConfigurationSaveResultSchema,
  DocumentRowSchema,
  HealthResponseSchema,
  JsonValueSchema,
  McpServerInputSchema,
  McpServerRowSchema,
  McpTestViewSchema,
  ResourceCountsSchema,
  SandboxStatusSchema,
  SecretRowSchema,
  SkillConfirmRequestSchema,
  SkillDetailSchema,
  SkillFileContentSchema,
  SkillRowSchema,
  SkillUploadValidationSchema,
  SuiteDetailSchema,
  SuiteHistoryEntrySchema,
  SuiteListRowSchema,
  SuiteReloadRequestSchema,
  SuiteReloadResultSchema,
  SystemSummarySchema,
  TablePreviewSchema,
  TaskDetailSchema,
  TaskDiffSchema,
  TaskVersionEntrySchema,
  WorkerSchema,
} from '@hermes-evals/shared';
import { z, type ZodType } from 'zod';

/** View models, by the name the documentation shows. */
export const RESPONSE_SCHEMAS = {
  ApiErrorBody: ApiErrorBodySchema,
  HealthResponse: HealthResponseSchema,
  JsonValue: JsonValueSchema,
  SuiteListRow: SuiteListRowSchema,
  SuiteDetail: SuiteDetailSchema,
  SuiteHistoryEntry: SuiteHistoryEntrySchema,
  SuiteReloadResult: SuiteReloadResultSchema,
  TaskDetail: TaskDetailSchema,
  TaskVersionEntry: TaskVersionEntrySchema,
  TaskDiff: TaskDiffSchema,
  TablePreview: TablePreviewSchema,
  SkillRow: SkillRowSchema,
  SkillUploadValidation: SkillUploadValidationSchema,
  SkillDetail: SkillDetailSchema,
  SkillFileContent: SkillFileContentSchema,
  DocumentRow: DocumentRowSchema,
  McpServerRow: McpServerRowSchema,
  McpTestView: McpTestViewSchema,
  SecretRow: SecretRowSchema,
  ResourceCounts: ResourceCountsSchema,
  ConfigurationListRow: ConfigurationListRowSchema,
  ConfigurationDetail: ConfigurationDetailSchema,
  ConfigurationSaveResult: ConfigurationSaveResultSchema,
  ConfigurationDraft: ConfigurationDraftSchema,
  ConfigurationFormOptions: ConfigurationFormOptionsSchema,
  ConfigDiff: ConfigDiffSchema,
  SystemSummary: SystemSummarySchema,
  Worker: WorkerSchema,
  SandboxStatus: SandboxStatusSchema,
} as const satisfies Record<string, ZodType>;

/** Request bodies, by the name the documentation shows. */
export const REQUEST_SCHEMAS = {
  SuiteReloadRequest: SuiteReloadRequestSchema,
  SkillConfirmRequest: SkillConfirmRequestSchema,
  McpServerInput: McpServerInputSchema,
  ConfigurationInput: ConfigurationInputSchema,
} as const satisfies Record<string, ZodType>;

/** An OpenAPI 3.0 schema object, as loosely as @nestjs/swagger types it. */
export type JsonSchemaObject = Record<string, unknown>;

const NAMES = new Map<ZodType, string>([
  ...Object.entries(RESPONSE_SCHEMAS).map(([name, schema]) => [schema, name] as const),
  ...Object.entries(REQUEST_SCHEMAS).map(([name, schema]) => [schema, name] as const),
]);

/**
 * The component name of a registered schema. Throws for one that is not
 * registered, which fails at import: every documented route names a
 * schema this file converts.
 */
export function schemaName(schema: ZodType): string {
  const name = NAMES.get(schema);
  if (!name) throw new Error('this zod schema is not registered in src/openapi/schemas.ts');
  return name;
}

export const componentRef = (name: string): JsonSchemaObject => ({
  $ref: `#/components/schemas/${name}`,
});

function convert(
  schemas: Readonly<Record<string, ZodType>>,
  io: 'input' | 'output',
): Record<string, JsonSchemaObject> {
  const registry = z.registry<{ id: string }>();
  for (const [id, schema] of Object.entries(schemas)) registry.add(schema, { id });
  const { schemas: converted } = z.toJSONSchema(registry, {
    target: 'openapi-3.0',
    io,
    // A refinement or transform has no JSON Schema; the property stays, described by its base type.
    unrepresentable: 'any',
    uri: (id) => `#/components/schemas/${id}`,
  });
  return Object.fromEntries(
    Object.entries(converted).map(([id, schema]) => [id, withoutId(schema)]),
  );
}

/** `$id` is JSON Schema, not OpenAPI 3.0; the component's key already names the schema. */
function withoutId(schema: object): JsonSchemaObject {
  const copy: JsonSchemaObject = { ...schema };
  delete copy['$id'];
  return copy;
}

/** Every registered schema as `components.schemas`. Request and view-model names never overlap. */
export function openApiComponents(): Record<string, JsonSchemaObject> {
  return { ...convert(RESPONSE_SCHEMAS, 'output'), ...convert(REQUEST_SCHEMAS, 'input') };
}
