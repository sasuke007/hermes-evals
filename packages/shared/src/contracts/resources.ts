/**
 * View models for the resource library: skills, documents, MCP servers and
 * secrets (Resources section, plan section 5). Secret values never appear in
 * any of these schemas; only names, and whether the service that reads each
 * one (the worker for stdio servers, egress for http servers) has it. MCP
 * server definitions are in ./mcp-servers.ts.
 * See ./common.ts for the conventions every contract file follows.
 */
import { z } from 'zod';
import { ENV_NAME_PATTERN } from '../records.js';
import { ApiErrorBodySchema, countView, isoTimeView, sha256View } from './common.js';

export const ResourceCountsSchema = z.object({
  skills: countView,
  documents: countView,
  mcpServers: countView,
  secrets: countView,
});
export type ResourceCounts = z.infer<typeof ResourceCountsSchema>;

export const ConfigurationLinkSchema = z.object({
  configurationId: z.string(),
  name: z.string(),
});
export type ConfigurationLink = z.infer<typeof ConfigurationLinkSchema>;

/**
 * The 409 of DELETE /resources/skills/:id and DELETE /resources/documents/:id
 * (Phase 5 section 6.1): only a skill or document no configuration version
 * uses can be deleted, and `usedBy` names the configurations that still do,
 * the same list as the row's `inUseBy`. A deletion answers 204; the
 * database refuses deleting one in use too (migration 0009).
 */
export const ResourceInUseBodySchema = ApiErrorBodySchema.extend({
  statusCode: z.literal(409),
  usedBy: z.array(ConfigurationLinkSchema).min(1),
});
export type ResourceInUseBody = z.infer<typeof ResourceInUseBodySchema>;

/**
 * Whether any configuration version names a skill or document (Phase 5b
 * question 8, Phase 7), on its row: `inUseBy` lists the configurations any
 * of whose versions name it, by name, and `inUse` is true exactly when it
 * is not empty. Not only the latest version, which `usedBy` and
 * `attachedTo` follow: a version keeps what it was saved with, so the
 * resource cannot be deleted while any version names it. The pages disable
 * Delete with that reason, and the API's 409 (ResourceInUseBody) lists the
 * same configurations.
 */
const resourceInUseFields = {
  inUse: z.boolean(),
  inUseBy: z.array(ConfigurationLinkSchema),
};

function checkInUse(row: { inUse: boolean; inUseBy: unknown[] }, ctx: z.RefinementCtx): void {
  if (row.inUse !== row.inUseBy.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['inUse'],
      message: 'inUse is true exactly when inUseBy names a configuration',
    });
  }
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** One uploaded skill version (a name and version is one row). */
export const SkillRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string(),
    contentHash: sha256View,
    fileCount: countView,
    unpackedBytes: countView,
    uploadedAt: isoTimeView,
    /** The configurations whose latest version uses it ("Used by"). */
    usedBy: z.array(ConfigurationLinkSchema),
    ...resourceInUseFields,
  })
  .superRefine(checkInUse);
export type SkillRow = z.infer<typeof SkillRowSchema>;

export const RESOURCE_FILE_KINDS = ['markdown', 'code', 'text', 'csv', 'binary'] as const;
export const ResourceFileKindSchema = z.enum(RESOURCE_FILE_KINDS);
export type ResourceFileKind = z.infer<typeof ResourceFileKindSchema>;

export const SkillFileEntrySchema = z.object({
  path: z.string(),
  sizeBytes: countView,
  kind: ResourceFileKindSchema,
});
export type SkillFileEntry = z.infer<typeof SkillFileEntrySchema>;

export const SkillDetailSchema = SkillRowSchema.extend({
  files: z.array(SkillFileEntrySchema),
  /** SKILL.md split into its front matter (verbatim YAML) and Markdown body. */
  skillMd: z.object({ frontMatter: z.string(), body: z.string() }),
});
export type SkillDetail = z.infer<typeof SkillDetailSchema>;

export const SkillFileContentSchema = z.object({
  path: z.string(),
  kind: ResourceFileKindSchema,
  sizeBytes: countView,
  /** Text content; null for binary files (size and hash only). */
  content: z.string().nullable(),
  sha256: sha256View,
});
export type SkillFileContent = z.infer<typeof SkillFileContentSchema>;

/** One line of the validation checklist in ResourceUploadDialog. */
export const UploadCheckSchema = z.object({
  label: z.string(),
  value: z.string(),
  ok: z.boolean(),
});
export type UploadCheck = z.infer<typeof UploadCheckSchema>;

export const UploadProblemSchema = z.object({
  title: z.string(),
  detail: z.string(),
});
export type UploadProblem = z.infer<typeof UploadProblemSchema>;

/**
 * Result of POST /resources/skills/validate. Nothing is stored yet.
 * - `valid`: a new name, or a new version of nothing; Confirm upload.
 * - `new_version`: the name exists and SKILL.md declares a new version; "Upload as 1.1.0".
 * - `conflict`: same name and version as a stored skill with a different hash; Confirm disabled.
 * - `invalid`: problems listed; Confirm disabled.
 */
export const SkillUploadValidationSchema = z.object({
  /** Short-lived token Confirm sends back; null when the upload cannot be confirmed. */
  token: z.string().nullable(),
  fileName: z.string(),
  sizeBytes: countView,
  outcome: z.enum(['valid', 'new_version', 'conflict', 'invalid']),
  name: z.string().nullable(),
  version: z.string().nullable(),
  description: z.string().nullable(),
  contentHash: sha256View.nullable(),
  checks: z.array(UploadCheckSchema),
  problems: z.array(UploadProblemSchema),
  /** The stored version this upload collides with or follows. */
  existing: z.object({ id: z.string(), version: z.string(), contentHash: sha256View }).nullable(),
  fileTree: z.array(z.object({ path: z.string(), sizeBytes: countView })),
  unpackedBytes: countView,
});
export type SkillUploadValidation = z.infer<typeof SkillUploadValidationSchema>;

/** Body of POST /resources/skills: confirms a validated upload. */
export const SkillConfirmRequestSchema = z.strictObject({
  token: z.string().min(1),
});
export type SkillConfirmRequest = z.infer<typeof SkillConfirmRequestSchema>;

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export const DocumentRowSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    sizeBytes: countView,
    mediaType: z.string(),
    /** e.g. "PDF · 6 pages". */
    typeLabel: z.string(),
    sha256: sha256View,
    uploadedAt: isoTimeView,
    /** The configurations whose latest version attaches it ("Attached to"). */
    attachedTo: z.array(ConfigurationLinkSchema),
    ...resourceInUseFields,
  })
  .superRefine(checkInUse);
export type DocumentRow = z.infer<typeof DocumentRowSchema>;

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export const SecretReferenceSchema = z
  .object({
    kind: z.literal('mcp_server'),
    id: z.string(),
    name: z.string(),
    via: z.enum(['env', 'header']),
    /** The header the value is sent as, when via = 'header'; null for env. */
    header: z.string().nullable(),
  })
  .refine((r) => (r.via === 'header') === (r.header !== null), {
    path: ['header'],
    message: 'header is set exactly when via is header',
  });
export type SecretReference = z.infer<typeof SecretReferenceSchema>;

/**
 * Who reads a secret's value. stdio env values come from the worker and are
 * set in the trial's environment, so the agent can read them; http header
 * values come from egress and never enter the run (plan section 5.3).
 */
export const SECRET_SOURCES = ['worker', 'egress'] as const;
export type SecretSource = (typeof SECRET_SOURCES)[number];
export const SECRET_EXPOSURES = ['readable_by_agent', 'egress_only'] as const;
export type SecretExposure = (typeof SECRET_EXPOSURES)[number];
/** The exposure that follows from each source. */
export const SECRET_EXPOSURE_BY_SOURCE = {
  worker: 'readable_by_agent',
  egress: 'egress_only',
} as const satisfies Record<SecretSource, SecretExposure>;

/**
 * One secret name referenced by MCP servers, and whether the service that
 * reads it has it. One row per name and source: a name used both as a stdio
 * env variable and as an http header variable is two rows.
 */
export const SecretRowSchema = z
  .object({
    name: z.string().regex(ENV_NAME_PATTERN),
    set: z.boolean(),
    source: z.enum(SECRET_SOURCES),
    /** `readable_by_agent` for source worker, `egress_only` for source egress. */
    exposure: z.enum(SECRET_EXPOSURES),
    /** env references for source worker, header references for source egress. */
    referencedBy: z.array(SecretReferenceSchema),
    lastCheckedAt: isoTimeView,
    /** When the service reported it: "at worker start" or "on request". */
    checkedWhen: z.string(),
  })
  .superRefine((row, ctx) => {
    if (row.exposure !== SECRET_EXPOSURE_BY_SOURCE[row.source]) {
      ctx.addIssue({
        code: 'custom',
        path: ['exposure'],
        message: `source ${row.source} means exposure ${SECRET_EXPOSURE_BY_SOURCE[row.source]}`,
      });
    }
    const via = row.source === 'worker' ? 'env' : 'header';
    if (row.referencedBy.some((r) => r.via !== via)) {
      ctx.addIssue({
        code: 'custom',
        path: ['referencedBy'],
        message: `source ${row.source} is referenced via ${via} only`,
      });
    }
  });
export type SecretRow = z.infer<typeof SecretRowSchema>;
