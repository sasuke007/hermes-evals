/**
 * Resource library: skills (two-step upload: validate, then confirm),
 * documents, MCP servers (save, test start) and secrets (names and set /
 * not set only; no value ever reaches the browser).
 *
 * Live mode calls the endpoints of plan section 11 through apiGet/apiSend and
 * parses every answer with its shared schema; fixtures mode (VITE_API_MODE=fixtures)
 * serves src/fixtures/resources.ts (src/api/README.md).
 */
import {
  DocumentRowSchema,
  McpServerRowSchema,
  McpTestViewSchema,
  ResourceCountsSchema,
  SecretRowSchema,
  SkillDetailSchema,
  SkillFileContentSchema,
  SkillRowSchema,
  SkillUploadValidationSchema,
} from '@hermes-evals/shared';
import type {
  DocumentRow,
  McpServerInput,
  McpServerRow,
  McpTestView,
  ResourceCounts,
  SecretRow,
  SkillDetail,
  SkillFileContent,
  SkillRow,
  SkillUploadValidation,
} from './types/resources';
import { API_BASE, apiGet, apiSend } from './client';
import { apiMode, fixture, fixtureFailure, hasScenario, notFound, withQuery } from './source';
import {
  documentsFixture,
  documentUploadFixture,
  MCP_INVOICE_DB,
  mcpSaveFixture,
  mcpServersFixture,
  mcpTestFixture,
  resourceCountsFixture,
  secretsFixture,
  type SkillUploadCase,
  skillConfirmFixture,
  skillDetailFixture,
  skillFileFixture,
  skillsFixture,
  skillValidationFixture,
} from '@/fixtures/resources';

/** The API's upload caps (plan 5.1, 5.2): the dialogs refuse a larger file before sending it. */
export const SKILL_ZIP_MAX_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

const noResources = () => hasScenario('empty') || hasScenario('first-launch');
/** INVOICE_DB_URL is missing from the worker: Secrets shows it not set and Test start fails. */
const secretMissing = () => hasScenario('secret-not-set') || hasScenario('mcp-test-failed');

/** Tab counts for the resource kinds nav. */
export function getResourceCounts(): Promise<ResourceCounts> {
  if (apiMode === 'live') return apiGet('/resources/counts', ResourceCountsSchema);
  return fixture(() => resourceCountsFixture(noResources()), {
    request: 'GET /api/resources/counts',
  });
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** GET /resources/skills: one row per name and version. */
export function listSkills(): Promise<SkillRow[]> {
  if (apiMode === 'live') return apiGet('/resources/skills', SkillRowSchema.array());
  return fixture(() => skillsFixture(noResources()), { request: 'GET /api/resources/skills' });
}

/** GET /resources/skills/:id: SKILL.md (front matter and body), the file tree and "Used by". */
export function getSkill(id: string): Promise<SkillDetail> {
  if (apiMode === 'live') return apiGet(`/resources/skills/${id}`, SkillDetailSchema);
  const request = `GET /api/resources/skills/${id}`;
  return fixture(
    () => {
      const detail = skillDetailFixture(id);
      if (!detail) throw notFound(request, `skill ${id}`);
      return detail;
    },
    { request },
  );
}

/** GET /resources/skills/:id/files/:path: one file of a skill (text, or size and hash only). */
export function getSkillFile(id: string, path: string): Promise<SkillFileContent> {
  if (apiMode === 'live') {
    return apiGet(
      `/resources/skills/${id}/files/${encodeURIComponent(path)}`,
      SkillFileContentSchema,
    );
  }
  const request = `GET /api/resources/skills/${id}/files/${path}`;
  return fixture(
    () => {
      const file = skillFileFixture(id, path);
      if (!file) throw notFound(request, `file ${path}`);
      return file;
    },
    { request },
  );
}

/** URL to download a skill as a zip (a plain link, not a fetch). */
export function skillZipUrl(id: string): string {
  return `${API_BASE}/resources/skills/${id}/zip`;
}

function uploadCase(): SkillUploadCase {
  if (hasScenario('upload-invalid')) return 'invalid';
  if (hasScenario('upload-new-version')) return 'new_version';
  if (hasScenario('upload-same-version-different-hash')) return 'conflict';
  return 'valid';
}

/**
 * POST /resources/skills/validate (multipart zip, 20 MB cap): the dry run.
 * Nothing is stored. The result lists checks and problems; `token` is null
 * when Confirm must stay disabled.
 */
export function validateSkillUpload(file: File): Promise<SkillUploadValidation> {
  if (apiMode === 'live') {
    const body = new FormData();
    body.append('file', file);
    return apiSend('POST', '/resources/skills/validate', body, SkillUploadValidationSchema);
  }
  return fixture(() => skillValidationFixture(uploadCase()), {
    request: 'POST /api/resources/skills/validate',
    latencyMs: 700,
  });
}

/** POST /resources/skills with the validation token: stores the skill and returns its row. */
export function confirmSkillUpload(token: string): Promise<SkillRow> {
  if (apiMode === 'live') return apiSend('POST', '/resources/skills', { token }, SkillRowSchema);
  return fixture(() => skillConfirmFixture(token), { request: 'POST /api/resources/skills' });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** GET /resources/documents. */
export function listDocuments(): Promise<DocumentRow[]> {
  if (apiMode === 'live') return apiGet('/resources/documents', DocumentRowSchema.array());
  return fixture(() => documentsFixture(noResources()), {
    request: 'GET /api/resources/documents',
  });
}

/** POST /resources/documents (multipart, 50 MB cap): no dialog, nothing to validate. */
export function uploadDocument(file: File): Promise<DocumentRow> {
  if (apiMode === 'live') {
    const body = new FormData();
    body.append('file', file);
    return apiSend('POST', '/resources/documents', body, DocumentRowSchema);
  }
  const request = 'POST /api/resources/documents';
  if (file.size > DOCUMENT_MAX_BYTES) {
    return fixtureFailure(request, 413, `${file.name} is larger than 50 MB`);
  }
  return fixture(() => documentUploadFixture(file.name, file.size, file.type), {
    request,
    latencyMs: 500,
  });
}

/** URL to download a document (a plain link, not a fetch). */
export function documentContentUrl(id: string): string {
  return `${API_BASE}/resources/documents/${id}/content`;
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/** GET /resources/mcp-servers. */
export function listMcpServers(): Promise<McpServerRow[]> {
  if (apiMode === 'live') return apiGet('/resources/mcp-servers', McpServerRowSchema.array());
  return fixture(
    () =>
      mcpServersFixture(noResources()).map((row) =>
        secretMissing() && row.id === MCP_INVOICE_DB.id
          ? { ...row, lastTest: mcpTestFixture(row, true) }
          : row,
      ),
    { request: 'GET /api/resources/mcp-servers' },
  );
}

/**
 * POST /resources/mcp-servers (new) or PUT /resources/mcp-servers/:id (edit).
 * Editing a definition a configuration uses creates the next version.
 */
export function saveMcpServer(input: McpServerInput, id?: string): Promise<McpServerRow> {
  if (apiMode === 'live') {
    return id
      ? apiSend('PUT', `/resources/mcp-servers/${id}`, input, McpServerRowSchema)
      : apiSend('POST', '/resources/mcp-servers', input, McpServerRowSchema);
  }
  const request = id ? `PUT /api/resources/mcp-servers/${id}` : 'POST /api/resources/mcp-servers';
  const taken = mcpServersFixture(noResources()).find((s) => s.name === input.name.trim());
  if (!id && taken) {
    return fixtureFailure(request, 409, `an MCP server named ${taken.name} already exists`);
  }
  return fixture(() => mcpSaveFixture(input, id), { request });
}

/**
 * Test start: runs the server once in a worker and lists the tools it exposes.
 * A saved server is tested by id (POST /resources/mcp-servers/:id/test); the
 * form tests an unsaved definition (POST /resources/mcp-servers/test).
 */
export function testMcpServer(target: { id: string } | McpServerInput): Promise<McpTestView> {
  const saved = 'id' in target;
  if (apiMode === 'live') {
    return saved
      ? apiSend('POST', `/resources/mcp-servers/${target.id}/test`, {}, McpTestViewSchema)
      : apiSend('POST', '/resources/mcp-servers/test', target, McpTestViewSchema);
  }
  const request = saved
    ? `POST /api/resources/mcp-servers/${target.id}/test`
    : 'POST /api/resources/mcp-servers/test';
  const definition = saved
    ? (mcpServersFixture(false).find((s) => s.id === target.id) ?? MCP_INVOICE_DB)
    : target;
  const needsSecret = definition.envNames.includes('INVOICE_DB_URL');
  return fixture(() => mcpTestFixture(definition, needsSecret && secretMissing()), {
    request,
    latencyMs: 1200,
  });
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * GET /resources/secrets: names referenced by MCP servers and whether the
 * service that reads each has it (the worker for stdio env, egress for http headers).
 */
export function listSecrets(): Promise<SecretRow[]> {
  if (apiMode === 'live') return apiGet('/resources/secrets', SecretRowSchema.array());
  return fixture(() => secretsFixture({ empty: noResources(), set: !secretMissing() }), {
    request: 'GET /api/resources/secrets',
  });
}

/** "Check again": asks the worker, and egress through it, to report their environment names now. */
export function checkSecrets(): Promise<SecretRow[]> {
  if (apiMode === 'live') {
    return apiGet(withQuery('/resources/secrets', { refresh: 'true' }), SecretRowSchema.array());
  }
  return fixture(
    () => secretsFixture({ empty: noResources(), set: !secretMissing(), checkedNow: true }),
    { request: 'GET /api/resources/secrets', latencyMs: 600 },
  );
}
