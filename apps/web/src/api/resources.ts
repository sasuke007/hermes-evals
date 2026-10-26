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
import {
  apiMode,
  fixture,
  fixtureFailure,
  fixtureWorld,
  hasScenario,
  notFound,
  withQuery,
} from './source';
import type { SkillUploadCase } from '@/fixtures/resources';

/** The API's upload caps (plan 5.1, 5.2): the dialogs refuse a larger file before sending it. */
export const SKILL_ZIP_MAX_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;

const noResources = () => hasScenario('empty') || hasScenario('first-launch');
/** INVOICE_DB_URL is missing from the worker: Secrets shows it not set and Test start fails. */
const secretMissing = () => hasScenario('secret-not-set') || hasScenario('mcp-test-failed');

/** Tab counts for the resource kinds nav. */
export function getResourceCounts(): Promise<ResourceCounts> {
  if (apiMode === 'live') return apiGet('/resources/counts', ResourceCountsSchema);
  return fixture((w) => w.resources.resourceCountsFixture(noResources()), {
    request: 'GET /api/resources/counts',
  });
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** GET /resources/skills: one row per name and version. */
export function listSkills(): Promise<SkillRow[]> {
  if (apiMode === 'live') return apiGet('/resources/skills', SkillRowSchema.array());
  return fixture((w) => w.resources.skillsFixture(noResources()), {
    request: 'GET /api/resources/skills',
  });
}

/** GET /resources/skills/:id: SKILL.md (front matter and body), the file tree and "Used by". */
export function getSkill(id: string): Promise<SkillDetail> {
  if (apiMode === 'live') return apiGet(`/resources/skills/${id}`, SkillDetailSchema);
  const request = `GET /api/resources/skills/${id}`;
  return fixture(
    (w) => {
      const detail = w.resources.skillDetailFixture(id);
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
    (w) => {
      const file = w.resources.skillFileFixture(id, path);
      if (!file) throw notFound(request, `file ${path}`);
      return file;
    },
    { request },
  );
}

/**
 * Names joined as the API joins them in a refusal: `a`, `a and b`, `a, b and c`
 * (resources/skills/configuration-links.ts).
 */
const listed = (names: readonly string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** The API's 409 sentence for a skill or document a configuration version names. */
const inUseDetail = (what: string, names: readonly string[]): string =>
  `${what} is part of a saved version of ${listed(names)}, and a configuration version keeps what it was saved with, so it cannot be deleted`;

/**
 * DELETE /resources/skills/:id (Phase 5 section 6.1): only a skill no configuration version
 * names; 409 naming the configurations otherwise (ResourceInUseBody, whose message the
 * ApiError carries). The row's `inUse` says the same beforehand (Phase 5b #8), so the page
 * disables Delete; the fixtures refuse a skill any configuration version names.
 */
export async function deleteSkill(id: string): Promise<void> {
  if (apiMode === 'live') return apiSend('DELETE', `/resources/skills/${id}`);
  const request = `DELETE /api/resources/skills/${id}`;
  const row = (await fixtureWorld()).resources.skillsFixture(false).find((s) => s.id === id);
  if (row?.inUse) {
    const names = row.inUseBy.map((c) => c.name);
    return fixtureFailure(request, 409, inUseDetail(`skill ${row.name} ${row.version}`, names));
  }
  return fixture(undefined, { request });
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
  return fixture((w) => w.resources.skillValidationFixture(uploadCase()), {
    request: 'POST /api/resources/skills/validate',
    latencyMs: 700,
  });
}

/** POST /resources/skills with the validation token: stores the skill and returns its row. */
export function confirmSkillUpload(token: string): Promise<SkillRow> {
  if (apiMode === 'live') return apiSend('POST', '/resources/skills', { token }, SkillRowSchema);
  return fixture((w) => w.resources.skillConfirmFixture(token), {
    request: 'POST /api/resources/skills',
  });
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/** GET /resources/documents. */
export function listDocuments(): Promise<DocumentRow[]> {
  if (apiMode === 'live') return apiGet('/resources/documents', DocumentRowSchema.array());
  return fixture((w) => w.resources.documentsFixture(noResources()), {
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
  return fixture((w) => w.resources.documentUploadFixture(file.name, file.size, file.type), {
    request,
    latencyMs: 500,
  });
}

/** DELETE /resources/documents/:id: as deleteSkill, for a document. */
export async function deleteDocument(id: string): Promise<void> {
  if (apiMode === 'live') return apiSend('DELETE', `/resources/documents/${id}`);
  const request = `DELETE /api/resources/documents/${id}`;
  const row = (await fixtureWorld()).resources.documentsFixture(false).find((d) => d.id === id);
  if (row?.inUse) {
    const names = row.inUseBy.map((c) => c.name);
    return fixtureFailure(request, 409, inUseDetail(`document ${row.filename}`, names));
  }
  return fixture(undefined, { request });
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
    ({ resources }) =>
      resources
        .mcpServersFixture(noResources())
        .map((row) =>
          secretMissing() && row.id === resources.MCP_INVOICE_DB.id
            ? { ...row, lastTest: resources.mcpTestFixture(row, true) }
            : row,
        ),
    { request: 'GET /api/resources/mcp-servers' },
  );
}

/**
 * Fixtures mode's stand-in for the API's memory of passing unsaved tests (Phase 5 question
 * 14): by the definition as sent, so a save of the same definition keeps the result.
 */
const passedUnsaved = new Map<string, Extract<McpTestView, { status: 'passed' }>>();
const definitionKey = (input: McpServerInput): string => JSON.stringify(input);
/** A stand-in definition hash for fixtures: 64 hex digits from the definition's text. */
function fixtureDefinitionHash(input: McpServerInput): string {
  let h = 0x811c9dc5;
  for (const ch of definitionKey(input)) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0').repeat(8);
}

/**
 * POST /resources/mcp-servers (new) or PUT /resources/mcp-servers/:id (edit).
 * Editing a definition a configuration uses creates the next version. A save whose
 * definition passed Test start unsaved keeps that result as the row's last test.
 */
export async function saveMcpServer(input: McpServerInput, id?: string): Promise<McpServerRow> {
  if (apiMode === 'live') {
    return id
      ? apiSend('PUT', `/resources/mcp-servers/${id}`, input, McpServerRowSchema)
      : apiSend('POST', '/resources/mcp-servers', input, McpServerRowSchema);
  }
  const request = id ? `PUT /api/resources/mcp-servers/${id}` : 'POST /api/resources/mcp-servers';
  const { resources } = await fixtureWorld();
  const taken = resources
    .mcpServersFixture(noResources())
    .find((s) => s.name === input.name.trim());
  if (!id && taken) {
    return fixtureFailure(request, 409, `an MCP server named ${taken.name} already exists`);
  }
  const kept = passedUnsaved.get(definitionKey(input));
  return fixture(
    () => {
      const row = resources.mcpSaveFixture(input, id);
      if (!kept) return row;
      const { definitionHash: _hash, ...lastTest } = kept;
      return { ...row, lastTest };
    },
    { request },
  );
}

/**
 * Test start: runs the server once in a worker and lists the tools it exposes.
 * A saved server is tested by id (POST /resources/mcp-servers/:id/test); the
 * form tests an unsaved definition (POST /resources/mcp-servers/test).
 */
export async function testMcpServer(target: { id: string } | McpServerInput): Promise<McpTestView> {
  const saved = 'id' in target;
  if (apiMode === 'live') {
    return saved
      ? apiSend('POST', `/resources/mcp-servers/${target.id}/test`, {}, McpTestViewSchema)
      : apiSend('POST', '/resources/mcp-servers/test', target, McpTestViewSchema);
  }
  const request = saved
    ? `POST /api/resources/mcp-servers/${target.id}/test`
    : 'POST /api/resources/mcp-servers/test';
  const { resources } = await fixtureWorld();
  const definition = saved
    ? (resources.mcpServersFixture(false).find((s) => s.id === target.id) ??
      resources.MCP_INVOICE_DB)
    : target;
  const needsSecret = definition.envNames.includes('INVOICE_DB_URL');
  return fixture(
    (): McpTestView => {
      const result = resources.mcpTestFixture(definition, needsSecret && secretMissing());
      if (saved || result.status === 'untested') return result;
      // An unsaved test names the definition's hash; a passing one is kept for its save.
      const named = { ...result, definitionHash: fixtureDefinitionHash(target) };
      if (named.status === 'passed') passedUnsaved.set(definitionKey(target), named);
      return named;
    },
    { request, latencyMs: 1200 },
  );
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
  return fixture(
    (w) => w.resources.secretsFixture({ empty: noResources(), set: !secretMissing() }),
    {
      request: 'GET /api/resources/secrets',
    },
  );
}

/** "Check again": asks the worker, and egress through it, to report their environment names now. */
export function checkSecrets(): Promise<SecretRow[]> {
  if (apiMode === 'live') {
    return apiGet(withQuery('/resources/secrets', { refresh: 'true' }), SecretRowSchema.array());
  }
  return fixture(
    (w) =>
      w.resources.secretsFixture({ empty: noResources(), set: !secretMissing(), checkedNow: true }),
    { request: 'GET /api/resources/secrets', latencyMs: 600 },
  );
}
