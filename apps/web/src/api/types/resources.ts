/**
 * View models for the resource library: skills, documents, MCP servers and
 * secrets (Resources section, plan section 5). Secret values never appear in
 * any of these types; only names and whether the worker has them.
 * See src/api/types/suites.ts for the conventions shared by every types file.
 */
import type { McpTransport } from '@hermes-evals/shared';

export type ResourceTab = 'skills' | 'documents' | 'mcp' | 'secrets';

export interface ResourceCounts {
  skills: number;
  documents: number;
  mcpServers: number;
  secrets: number;
}

export interface ConfigurationLink {
  configurationId: string;
  name: string;
}

/** One uploaded skill version (a name and version is one row). */
export interface SkillRow {
  id: string;
  name: string;
  version: string;
  description: string;
  contentHash: string;
  fileCount: number;
  unpackedBytes: number;
  uploadedAt: string;
  usedBy: ConfigurationLink[];
}

export type ResourceFileKind = 'markdown' | 'code' | 'text' | 'csv' | 'binary';

export interface SkillFileEntry {
  path: string;
  sizeBytes: number;
  kind: ResourceFileKind;
}

export interface SkillDetail extends SkillRow {
  files: SkillFileEntry[];
  /** SKILL.md split into its front matter (verbatim YAML) and Markdown body. */
  skillMd: { frontMatter: string; body: string };
}

export interface SkillFileContent {
  path: string;
  kind: ResourceFileKind;
  sizeBytes: number;
  /** Text content; null for binary files (size and hash only). */
  content: string | null;
  sha256: string;
}

/** One line of the validation checklist in ResourceUploadDialog. */
export interface UploadCheck {
  label: string;
  value: string;
  ok: boolean;
}

export interface UploadProblem {
  title: string;
  detail: string;
}

/**
 * Result of POST /resources/skills/validate. Nothing is stored yet.
 * - `valid`: a new name, or a new version of nothing; Confirm upload.
 * - `new_version`: the name exists and SKILL.md declares a new version; "Upload as 1.1.0".
 * - `conflict`: same name and version as a stored skill with a different hash; Confirm disabled.
 * - `invalid`: problems listed; Confirm disabled.
 */
export interface SkillUploadValidation {
  /** Short-lived token Confirm sends back; null when the upload cannot be confirmed. */
  token: string | null;
  fileName: string;
  sizeBytes: number;
  outcome: 'valid' | 'new_version' | 'conflict' | 'invalid';
  name: string | null;
  version: string | null;
  description: string | null;
  contentHash: string | null;
  checks: UploadCheck[];
  problems: UploadProblem[];
  /** The stored version this upload collides with or follows. */
  existing: { id: string; version: string; contentHash: string } | null;
  fileTree: { path: string; sizeBytes: number }[];
  unpackedBytes: number;
}

export interface DocumentRow {
  id: string;
  filename: string;
  sizeBytes: number;
  mediaType: string;
  /** e.g. "PDF · 6 pages". */
  typeLabel: string;
  sha256: string;
  uploadedAt: string;
  attachedTo: ConfigurationLink[];
}

export interface McpToolView {
  name: string;
  description: string | null;
  /** Whether the server's include/exclude filter offers this tool to the agent. */
  included: boolean;
}

/** Result of the last "Test start" of a server definition. Never holds secret values. */
export type McpTestView =
  | { status: 'untested' }
  | { status: 'running'; requestedAt: string }
  | {
      status: 'passed';
      requestedAt: string;
      finishedAt: string;
      startedMs: number;
      tools: McpToolView[];
    }
  | {
      status: 'failed';
      requestedAt: string;
      finishedAt: string;
      startedMs: number | null;
      /** e.g. "Exited with code 1 after 0.6 s · no tools listed". */
      error: string;
      exitCode: number | null;
      stderrTail: string;
      /** Env or header names the worker environment lacks. Names only. */
      missingSecretNames: string[];
    };

/** An MCP server definition as the form edits it. */
export interface McpServerInput {
  name: string;
  transport: McpTransport;
  /** stdio only. */
  command: string | null;
  args: string[];
  /** Environment variable names (stdio). Values come from the worker environment. */
  envNames: string[];
  /** http only. */
  url: string | null;
  /** Header names (http). Values come from the worker environment. */
  headerNames: string[];
  include: string[];
  exclude: string[];
  timeoutS: number;
}

export interface McpServerRow extends McpServerInput {
  id: string;
  versionId: string;
  version: number;
  definedAt: string;
  /** True once a configuration version uses this definition; editing creates a new version. */
  frozen: boolean;
  usedBy: ConfigurationLink[];
  lastTest: McpTestView;
}

export interface SecretReference {
  kind: 'mcp_server';
  id: string;
  name: string;
  via: 'env' | 'header';
}

/** One secret name referenced by an MCP server, and whether the worker has it. */
export interface SecretRow {
  name: string;
  set: boolean;
  source: 'worker environment';
  referencedBy: SecretReference[];
  lastCheckedAt: string;
  /** When the worker reported it: "at worker start" or "on request". */
  checkedWhen: string;
}
