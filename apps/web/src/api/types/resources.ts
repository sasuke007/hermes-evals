/**
 * View models for the resource library: skills, documents, MCP servers and
 * secrets (Resources section, plan section 5). Secret values never appear in
 * any of these types; only names and whether the worker or egress has them.
 * The contracts live in @hermes-evals/shared; this file re-exports their types.
 * See src/api/types/suites.ts for the conventions shared by every types file.
 */
export type {
  ConfigurationLink,
  DocumentRow,
  McpServerInput,
  McpServerRow,
  McpTestView,
  McpToolView,
  ResourceCounts,
  ResourceFileKind,
  SecretExposure,
  SecretReference,
  SecretRow,
  SecretSource,
  SkillDetail,
  SkillFileContent,
  SkillFileEntry,
  SkillRow,
  SkillUploadValidation,
  UploadCheck,
  UploadProblem,
} from '@hermes-evals/shared';

/** The tabs of the resource library; the route's `tab` param. */
export type ResourceTab = 'skills' | 'documents' | 'mcp' | 'secrets';
