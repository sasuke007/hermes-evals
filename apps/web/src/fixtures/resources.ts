/**
 * Resource library fixtures: the skill invoice-method, the document
 * vendor-policy-v3.pdf, the MCP server invoice-db and its secret
 * INVOICE_DB_URL (UI design brief section 7; Resources artboards and the
 * Library states board).
 *
 * Scenarios handled here (see scenarios.ts): empty, upload-invalid,
 * upload-new-version, upload-same-version-different-hash, mcp-test-failed,
 * secret-not-set.
 */
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
} from '@/api/types/resources';
import { at, sha, ulid } from './suites';

// ---------------------------------------------------------------------------
// Ids shared with the configuration fixtures
// ---------------------------------------------------------------------------

export const SKILL_INVOICE_METHOD_ID = 'skill_01JAX9C41E07';
export const SKILL_INVOICE_METHOD_110_ID = 'skill_01JBG5E8A12C';
export const SKILL_INVOICE_METHOD_HASH = sha('invoice-method-1.0.0', '9c41e07d5f3a', 'b7a2');
export const SKILL_INVOICE_METHOD_110_HASH = sha('invoice-method-1.1.0', '5e8a12c4b0d9', '0f3d');

export const DOCUMENT_POLICY_ID = 'doc_01JAX3BE7D1F';
export const DOCUMENT_POLICY_HASH = sha('vendor-policy-v3.pdf', '3be7d1f0', '91ac');

export const MCP_INVOICE_DB_ID = 'mcp_01JAYINVDB0';
export const MCP_INVOICE_DB_V1_ID = 'mcpv_01JAYINVDB1';

/** Configuration ids, duplicated here so resources can name what uses them without an import cycle. */
export const CONFIG_IDS = {
  baseline: 'cfg_01JAX7BASE0',
  'with-skill': 'cfg_01JAX9SKILL',
  'with-mcp': 'cfg_01JAYMCPDB0',
} as const;

const SKILL_DESCRIPTION =
  'Method for reconciling vendor invoices: always check credit notes, duplicates and partial payments before totalling';

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

const SKILL_FILES: SkillDetail['files'] = [
  { path: 'SKILL.md', sizeBytes: 2150, kind: 'markdown' },
  { path: 'checklist.md', sizeBytes: 1434, kind: 'markdown' },
  { path: 'examples/reconcile.py', sizeBytes: 10035, kind: 'code' },
  { path: 'examples/sample.csv', sizeBytes: 5018, kind: 'csv' },
];

const SKILL_FRONT_MATTER = `name: invoice-method
version: 1.0.0
description: ${SKILL_DESCRIPTION}`;

const SKILL_BODY = `# Invoice method

Before computing any total from an invoice export, work through these checks in order.

1. Load the whole file with \`read_file\`. Do not sample it with \`head\`.
2. Find duplicates: the same vendor, amount and PO number under different invoice numbers.
3. Apply each credit note to the invoice it references.
4. Subtract partial payments from the invoice balance.
5. Exclude disputed invoices from payable totals unless the task says otherwise.

See \`checklist.md\` for the column names this method expects, and \`examples/reconcile.py\` for a reference implementation.
`;

const FILE_CONTENTS: Record<string, string> = {
  'SKILL.md': `---\n${SKILL_FRONT_MATTER}\n---\n\n${SKILL_BODY}`,
  'checklist.md': `# Columns this method expects

- \`invoice_no\`: unique per invoice, never reused for a credit note
- \`vendor_name\`: compare case-insensitively
- \`amount\`: gross, VAT included
- \`po_number\`: may be empty
- \`status\`: open, paid or disputed
`,
  'examples/reconcile.py': `import csv
from collections import defaultdict


def duplicates(rows):
    seen = defaultdict(list)
    for row in rows:
        seen[(row["vendor_name"], row["amount"], row["po_number"])].append(row["invoice_no"])
    return sorted(sorted(ids) for ids in seen.values() if len(ids) > 1)


if __name__ == "__main__":
    rows = list(csv.DictReader(open("invoices.csv")))
    print(duplicates(rows))
`,
  'examples/sample.csv': `invoice_no,vendor_name,amount,po_number,status
INV-9001,Example Vendor,100.00,PO-1,open
INV-9002,Example Vendor,100.00,PO-1,open
`,
};

const SKILL_USED_BY = [{ configurationId: CONFIG_IDS['with-skill'], name: 'with-skill' }];

export const SKILL_INVOICE_METHOD: SkillRow = {
  id: SKILL_INVOICE_METHOD_ID,
  name: 'invoice-method',
  version: '1.0.0',
  description: SKILL_DESCRIPTION,
  contentHash: SKILL_INVOICE_METHOD_HASH,
  fileCount: 4,
  unpackedBytes: 18637,
  uploadedAt: at(22, '09:48:21'),
  usedBy: SKILL_USED_BY,
};

export const SKILL_INVOICE_METHOD_110: SkillRow = {
  ...SKILL_INVOICE_METHOD,
  id: SKILL_INVOICE_METHOD_110_ID,
  version: '1.1.0',
  contentHash: SKILL_INVOICE_METHOD_110_HASH,
  uploadedAt: at(23, '15:46:02'),
  usedBy: [],
};

export function skillsFixture(empty: boolean): SkillRow[] {
  return empty ? [] : [SKILL_INVOICE_METHOD];
}

export function skillDetailFixture(id: string): SkillDetail | null {
  const row = [SKILL_INVOICE_METHOD, SKILL_INVOICE_METHOD_110].find((s) => s.id === id);
  if (!row) return null;
  const frontMatter =
    row.version === '1.0.0' ? SKILL_FRONT_MATTER : SKILL_FRONT_MATTER.replace('1.0.0', '1.1.0');
  return { ...row, files: SKILL_FILES, skillMd: { frontMatter, body: SKILL_BODY } };
}

export function skillFileFixture(id: string, path: string): SkillFileContent | null {
  const detail = skillDetailFixture(id);
  const entry = detail?.files.find((f) => f.path === path);
  if (!detail || !entry) return null;
  return {
    path,
    kind: entry.kind,
    sizeBytes: entry.sizeBytes,
    content: FILE_CONTENTS[path] ?? null,
    sha256: sha(`${id}/${path}`),
  };
}

const FILE_TREE = SKILL_FILES.map((f) => ({ path: f.path, sizeBytes: f.sizeBytes }));

/** Which upload the ResourceUploadDialog validates in each scenario. */
export type SkillUploadCase = 'valid' | 'new_version' | 'conflict' | 'invalid';

export function skillValidationFixture(kase: SkillUploadCase): SkillUploadValidation {
  if (kase === 'invalid') {
    return {
      token: null,
      fileName: 'invoice-method-folder.zip',
      sizeBytes: 8090,
      outcome: 'invalid',
      name: null,
      version: null,
      description: null,
      contentHash: null,
      checks: [],
      problems: [
        {
          title: 'No SKILL.md at the zip root.',
          detail:
            "Found invoice-method/SKILL.md one folder down. Zip the folder's contents rather than the folder.",
        },
        {
          title: 'No version in metadata.',
          detail: 'Add version: to the SKILL.md front matter.',
        },
      ],
      existing: null,
      fileTree: FILE_TREE.map((f) => ({ ...f, path: `invoice-method/${f.path}` })),
      unpackedBytes: 18637,
    };
  }
  const next = kase === 'new_version' || kase === 'conflict';
  const version = kase === 'new_version' ? '1.1.0' : '1.0.0';
  const contentHash = next ? SKILL_INVOICE_METHOD_110_HASH : SKILL_INVOICE_METHOD_HASH;
  return {
    token: kase === 'conflict' ? null : `upl_${kase}_${contentHash.slice(0, 8)}`,
    fileName: 'invoice-method.zip',
    sizeBytes: next ? 7987 : 7782,
    outcome: kase,
    name: 'invoice-method',
    version,
    description: SKILL_DESCRIPTION,
    contentHash,
    checks: [
      { label: 'SKILL.md', value: 'found at zip root', ok: true },
      { label: 'name', value: 'invoice-method', ok: true },
      { label: 'version', value: version, ok: kase !== 'conflict' },
      { label: 'description', value: SKILL_DESCRIPTION, ok: true },
      { label: 'files', value: '4 files · 18.2 KB unpacked', ok: true },
      { label: 'content hash', value: `sha256:${contentHash}`, ok: true },
    ],
    problems:
      kase === 'conflict'
        ? [
            {
              title: 'Version 1.0.0 already exists with a different hash.',
              detail: 'Bump version: in SKILL.md.',
            },
          ]
        : [],
    existing: next
      ? { id: SKILL_INVOICE_METHOD_ID, version: '1.0.0', contentHash: SKILL_INVOICE_METHOD_HASH }
      : null,
    fileTree: FILE_TREE,
    unpackedBytes: 18637,
  };
}

/** The row Confirm stores for a validation token. */
export function skillConfirmFixture(token: string): SkillRow {
  if (token.startsWith('upl_new_version')) return SKILL_INVOICE_METHOD_110;
  return { ...SKILL_INVOICE_METHOD, usedBy: [] };
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * vendor-policy-v3.pdf is attached to no configuration: the brief's
 * configurations hold no documents, so with-skill differs from baseline only
 * in its skill.
 */
export const DOCUMENT_POLICY: DocumentRow = {
  id: DOCUMENT_POLICY_ID,
  filename: 'vendor-policy-v3.pdf',
  sizeBytes: 219136,
  mediaType: 'application/pdf',
  typeLabel: 'PDF · 6 pages',
  sha256: DOCUMENT_POLICY_HASH,
  uploadedAt: at(22, '09:30:44'),
  attachedTo: [],
};

export function documentsFixture(empty: boolean): DocumentRow[] {
  return empty ? [] : [DOCUMENT_POLICY];
}

const TYPE_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'text/markdown': 'Markdown',
  'text/plain': 'Text',
  'text/csv': 'CSV',
};

/** The row an uploaded file becomes. */
export function documentUploadFixture(name: string, sizeBytes: number, type: string): DocumentRow {
  const mediaType = type || 'application/octet-stream';
  return {
    id: ulid('doc', `${name}:${sizeBytes}`),
    filename: name,
    sizeBytes,
    mediaType,
    typeLabel: TYPE_LABELS[mediaType] ?? 'File',
    sha256: sha(`${name}:${sizeBytes}`),
    uploadedAt: at(23, '15:48:12'),
    attachedTo: [],
  };
}

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

const ALL_TOOLS = ['list_invoices', 'get_invoice', 'update_invoice', 'delete_invoice'];

export const MCP_TEST_PASSED: McpTestView = {
  status: 'passed',
  requestedAt: at(22, '17:04:40'),
  finishedAt: at(22, '17:04:42'),
  startedMs: 1800,
  tools: ALL_TOOLS.map((name) => ({
    name,
    description: null,
    included: name === 'list_invoices' || name === 'get_invoice',
  })),
};

export const MCP_TEST_FAILED: McpTestView = {
  status: 'failed',
  requestedAt: at(23, '15:47:03'),
  finishedAt: at(23, '15:47:04'),
  startedMs: null,
  error: 'Exited with code 1 after 0.6 s · no tools listed',
  exitCode: 1,
  stderrTail: `Error: INVOICE_DB_URL is not set
    at loadConfig (/usr/lib/node_modules/invoice-db-mcp/dist/config.js:12:11)`,
  missingSecretNames: ['INVOICE_DB_URL'],
};

export const MCP_INVOICE_DB_INPUT: McpServerInput = {
  name: 'invoice-db',
  transport: 'stdio',
  command: 'npx',
  args: ['invoice-db-mcp'],
  envNames: ['INVOICE_DB_URL'],
  url: null,
  headerNames: [],
  include: ['list_invoices', 'get_invoice'],
  exclude: [],
  timeoutS: 30,
};

export const MCP_INVOICE_DB: McpServerRow = {
  ...MCP_INVOICE_DB_INPUT,
  id: MCP_INVOICE_DB_ID,
  versionId: MCP_INVOICE_DB_V1_ID,
  version: 1,
  definedAt: at(22, '17:05:12'),
  frozen: true,
  usedBy: [{ configurationId: CONFIG_IDS['with-mcp'], name: 'with-mcp' }],
  lastTest: MCP_TEST_PASSED,
};

export function mcpServersFixture(empty: boolean): McpServerRow[] {
  return empty ? [] : [MCP_INVOICE_DB];
}

/** Save: a new server gets version 1; editing a frozen one creates the next version. */
export function mcpSaveFixture(input: McpServerInput, id?: string): McpServerRow {
  if (id === MCP_INVOICE_DB_ID) {
    return {
      ...MCP_INVOICE_DB,
      ...input,
      versionId: ulid('mcpv', `${id}:2`),
      version: 2,
      definedAt: at(23, '15:49:30'),
      frozen: false,
      lastTest: { status: 'untested' },
    };
  }
  return {
    ...input,
    id: ulid('mcp', input.name),
    versionId: ulid('mcpv', `${input.name}:1`),
    version: 1,
    definedAt: at(23, '15:49:30'),
    frozen: false,
    usedBy: [],
    lastTest: { status: 'untested' },
  };
}

/** Test start: lists the tools the server exposes, marking which the filter includes. */
export function mcpTestFixture(input: McpServerInput, failed: boolean): McpTestView {
  if (failed) return MCP_TEST_FAILED;
  const include = input.include.length ? input.include : ALL_TOOLS;
  return {
    status: 'passed',
    requestedAt: at(23, '15:47:03'),
    finishedAt: at(23, '15:47:05'),
    startedMs: 1800,
    tools: ALL_TOOLS.map((name) => ({
      name,
      description: null,
      included: include.includes(name) && !input.exclude.includes(name),
    })),
  };
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export function secretsFixture(options: { empty: boolean; set: boolean; checkedNow?: boolean }) {
  if (options.empty) return [] as SecretRow[];
  const row: SecretRow = {
    name: 'INVOICE_DB_URL',
    set: options.set,
    source: 'worker environment',
    referencedBy: [{ kind: 'mcp_server', id: MCP_INVOICE_DB_ID, name: 'invoice-db', via: 'env' }],
    lastCheckedAt: options.checkedNow ? at(23, '15:50:02') : at(23, '15:02:00'),
    checkedWhen: options.checkedNow ? 'on request' : 'at worker start',
  };
  return [row];
}

export function resourceCountsFixture(empty: boolean): ResourceCounts {
  return empty
    ? { skills: 0, documents: 0, mcpServers: 0, secrets: 0 }
    : { skills: 1, documents: 1, mcpServers: 1, secrets: 1 };
}
