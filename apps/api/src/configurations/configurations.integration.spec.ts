/**
 * Saving configuration versions on PGlite, with the real migrations and
 * triggers: create, edit in place, edit after an experiment froze the
 * version, rename, the reference rules and the MCP freeze. Every view is
 * checked against its shared schema. Drafts and diffs: drafts-diff.integration.spec.ts.
 */
import { count } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigurationDetailSchema,
  ConfigurationListRowSchema,
  ConfigurationSaveResultSchema,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { blob, HERMES_REVISION, sha } from '../../test/support/seed.js';
import {
  configurations,
  configurationVersions,
  documents,
  skills,
  workers,
} from '../database/schema/index.js';
import { ConfigurationReadsService } from './configuration-reads.service.js';
import { ConfigurationWritesService } from './configuration-writes.service.js';
import { sanitisedNameClashes } from './references.js';
import { configHash } from './settings.js';
import {
  freezeVersion,
  configurationInput as input,
  httpError,
  mcpFrozenAt,
  seedLibrary,
  seedStdioMcpServer,
  versionRow as storedVersion,
  type Library,
} from './support-spec.js';

let t: TestDatabase;
let lib: Library;
let writes: ConfigurationWritesService;
let reads: ConfigurationReadsService;

beforeEach(async () => {
  t = await createTestDatabase();
  lib = await seedLibrary(t.db);
  writes = new ConfigurationWritesService(t.db);
  reads = new ConfigurationReadsService(t.db);
});

afterEach(async () => {
  await t.close();
});

const detail = async (id: string, version?: number) =>
  ConfigurationDetailSchema.parse(await reads.detail(id, version));

const freeze = (versionId: string) => freezeVersion(t.db, versionId);
const versionRow = (versionId: string) => storedVersion(t.db, versionId);

/** invoice-method 1.1.0 beside the library's 1.0.0. */
async function secondSkillVersion(): Promise<string> {
  const [row] = await t.db
    .insert(skills)
    .values({
      name: 'invoice-method',
      version: '1.1.0',
      description: 'Reconcile invoices against the ledger before answering.',
      contentHash: sha('skill invoice-method 1.1.0'),
      fileCount: 3,
      sizeBytes: 4096,
    })
    .returning({ id: skills.id });
  return row!.id;
}

/** Another document with the library document's filename and other content. */
async function sameNamedDocument(): Promise<string> {
  const [row] = await t.db
    .insert(documents)
    .values({
      filename: 'vendor-policy-v3.pdf',
      mime: 'application/pdf',
      size: 5,
      sha256: await blob(t.db, 'other'),
    })
    .returning({ id: documents.id });
  return row!.id;
}

const TWO_SKILL_VERSIONS = [
  {
    path: 'skillIds',
    message:
      'skill invoice-method is included twice (1.0.0, 1.1.0); a configuration uses one version of each skill',
  },
];
const TWO_SAME_NAMED_DOCUMENTS = [
  {
    path: 'documentIds',
    message:
      'two documents are named vendor-policy-v3.pdf; each is copied to workspace/docs/<filename>, so names must differ',
  },
];

describe('create', () => {
  it('stores the configuration and its version 1 with normalised settings and a hash', async () => {
    const saved = ConfigurationSaveResultSchema.parse(
      await writes.create(input({ model: '  openai/gpt-6.1-sol ', skillIds: [lib.skillId] })),
    );
    expect(saved).toMatchObject({ version: 1, createdNewVersion: true });

    const [row] = ConfigurationListRowSchema.array().parse(await reads.list());
    expect(row).toMatchObject({
      id: saved.configurationId,
      name: 'baseline',
      usedInExperiments: 0,
    });
    expect(row!.latest).toMatchObject({
      versionId: saved.versionId,
      version: 1,
      latest: true,
      frozenAt: null,
      model: 'openai/gpt-6.1-sol',
      toolsets: ['file', 'terminal'],
      skills: [{ skillId: lib.skillId, name: 'invoice-method', version: '1.0.0' }],
      change: 'Created',
      experimentCount: 0,
    });

    const shown = await detail(saved.configurationId);
    expect(shown.versions).toHaveLength(1);
    expect(shown.duplicatedFrom).toBeNull();
    expect(shown.differsFromSource).toEqual([]);
    expect(shown.usedIn).toEqual([]);
    const stored = await versionRow(saved.versionId);
    expect(stored.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.duplicatedFromVersionId).toBeNull();
  });

  it('gives the same hash to the same settings under another name', async () => {
    const a = await writes.create(input({ name: 'a', toolsets: ['file', 'terminal'] }));
    const b = await writes.create(input({ name: 'b', toolsets: ['terminal', 'file'] }));
    const c = await writes.create(input({ name: 'c', maxTurns: 21 }));
    const hash = async (id: string) => (await versionRow(id)).configHash;
    expect(await hash(a.versionId)).toBe(await hash(b.versionId));
    expect(await hash(c.versionId)).not.toBe(await hash(a.versionId));
    const shown = await detail(a.configurationId);
    expect(shown.latest.configHash).toBe(
      configHash({
        model: 'openai/gpt-6.1-sol',
        provider: 'nous',
        baseUrl: null,
        toolsets: ['file', 'terminal'],
        memoryEnabled: false,
        skills: [],
        skillLoading: 'preload',
        documents: [],
        mcpServers: [],
        maxTurns: 20,
        timeBudgetS: 300,
      }),
    );
  });

  it('answers 409 for a taken name and stores nothing', async () => {
    await writes.create(input());
    const err = await httpError(writes.create(input({ model: 'other' })));
    expect(err.status).toBe(409);
    expect(err.body).toEqual({
      statusCode: 409,
      message: 'a configuration named baseline already exists',
    });
    expect(await t.db.select({ n: count() }).from(configurationVersions)).toEqual([{ n: 1 }]);
  });

  it('answers 400 naming each missing reference, and stores nothing', async () => {
    const err = await httpError(
      writes.create(
        input({
          skillIds: ['skl_missing'],
          documentIds: [lib.documentId, 'doc_missing'],
          mcpServerVersionIds: ['mcpv_missing'],
        }),
      ),
    );
    expect(err.status).toBe(400);
    expect(err.body.message).toBe(
      'skill skl_missing does not exist; document doc_missing does not exist; MCP server version mcpv_missing does not exist',
    );
    expect(err.body.issues).toEqual([
      { path: 'skillIds', message: 'skill skl_missing does not exist' },
      { path: 'documentIds', message: 'document doc_missing does not exist' },
      { path: 'mcpServerVersionIds', message: 'MCP server version mcpv_missing does not exist' },
    ]);
    expect(await t.db.select({ n: count() }).from(configurations)).toEqual([{ n: 0 }]);
  });

  it('answers 400 for two versions of one MCP server', async () => {
    const err = await httpError(
      writes.create(input({ mcpServerVersionIds: [lib.mcpV1, lib.mcpV2] })),
    );
    expect(err.status).toBe(400);
    expect(err.body.message).toBe(
      'MCP server invoice-db is included twice (v1, v2); a configuration uses one version of each server',
    );
    expect(err.body.issues).toEqual([
      {
        path: 'mcpServerVersionIds',
        message:
          'MCP server invoice-db is included twice (v1, v2); a configuration uses one version of each server',
      },
    ]);
    expect(await mcpFrozenAt(t.db, lib.mcpV1)).toBeNull();
  });

  // Hermes names an MCP tool mcp__<sanitised server>__<tool>: invoice-db and
  // invoice_db would both register mcp__invoice_db__get_invoice.
  it('answers 400 naming both MCP servers whose names sanitise alike, and stores nothing', async () => {
    const underscored = await seedStdioMcpServer(t.db, 'invoice_db');
    const err = await httpError(
      writes.create(input({ mcpServerVersionIds: [lib.mcpV1, underscored, lib.httpMcpV1] })),
    );
    const message =
      'MCP servers invoice-db and invoice_db cannot be used together: their names sanitise alike, so Hermes would name the tools of both mcp__invoice_db__<tool>; keep one, or rename one';
    expect(err.status).toBe(400);
    expect(err.body).toEqual({
      statusCode: 400,
      message,
      issues: [{ path: 'mcpServerVersionIds', message }],
    });
    expect(await t.db.select({ n: count() }).from(configurations)).toEqual([{ n: 0 }]);
    expect(await mcpFrozenAt(t.db, lib.mcpV1)).toBeNull();
    expect(await mcpFrozenAt(t.db, underscored)).toBeNull();
    // Either one alone, beside a server whose name differs, saves.
    expect(
      (await writes.create(input({ mcpServerVersionIds: [underscored, lib.httpMcpV1] }))).version,
    ).toBe(1);
  });

  // Nothing in the database backs these two: each run would copy whichever
  // file landed last into home/skills/<name>/ or workspace/docs/<filename>.
  it('answers 400 for two versions of one skill, and stores nothing', async () => {
    const skill110 = await secondSkillVersion();
    const err = await httpError(writes.create(input({ skillIds: [lib.skillId, skill110] })));
    expect(err.status).toBe(400);
    expect(err.body.issues).toEqual(TWO_SKILL_VERSIONS);
    expect(await t.db.select({ n: count() }).from(configurations)).toEqual([{ n: 0 }]);
  });

  it('answers 400 for two documents with one filename, and stores nothing', async () => {
    const doc2 = await sameNamedDocument();
    const err = await httpError(writes.create(input({ documentIds: [lib.documentId, doc2] })));
    expect(err.status).toBe(400);
    expect(err.body.issues).toEqual(TWO_SAME_NAMED_DOCUMENTS);
    expect(await t.db.select({ n: count() }).from(configurations)).toEqual([{ n: 0 }]);
  });

  it('answers 400 for a toolset the runtime does not offer', async () => {
    const err = await httpError(writes.create(input({ toolsets: ['file', 'teleport'] })));
    expect(err.status).toBe(400);
    expect(err.body.message).toMatch(
      /^unknown toolset teleport; Hermes offers: web, browser, terminal/,
    );

    // A live worker's list replaces the fallback.
    await t.db.insert(workers).values({
      hostname: 'worker-1',
      concurrency: 1,
      hermesVersion: '0.22.4',
      hermesRevision: HERMES_REVISION,
      toolsets: ['file', 'terminal'],
    });
    const narrowed = await httpError(writes.create(input({ toolsets: ['file', 'web'] })));
    expect(narrowed.body.message).toBe('unknown toolset web; the worker reports: file, terminal');
  });

  it('freezes the MCP definitions a saved version uses', async () => {
    expect(await mcpFrozenAt(t.db, lib.mcpV2)).toBeNull();
    const saved = await writes.create(input({ mcpServerVersionIds: [lib.mcpV2] }));
    expect(await mcpFrozenAt(t.db, lib.mcpV2)).toBeInstanceOf(Date);
    expect(await mcpFrozenAt(t.db, lib.mcpV1)).toBeNull();
    const shown = await detail(saved.configurationId);
    expect(shown.latest.mcpServers).toEqual([
      {
        mcpServerId: lib.mcpServerId,
        versionId: lib.mcpV2,
        name: 'invoice-db',
        version: 2,
        transport: 'stdio',
        // The names of this very version, for the exposure note (Phase 5 section 6.1).
        envNames: ['INVOICE_DB_URL'],
        headers: [],
      },
    ]);
  });
});

describe('edit', () => {
  it('updates a version no experiment used in place and recomputes its hash', async () => {
    const saved = await writes.create(input());
    const before = await versionRow(saved.versionId);
    const result = await writes.update(
      saved.configurationId,
      input({ model: 'anthropic/claude-x', skillIds: [lib.skillId] }),
    );
    expect(result).toEqual({
      configurationId: saved.configurationId,
      versionId: saved.versionId,
      version: 1,
      createdNewVersion: false,
    });
    const after = await versionRow(saved.versionId);
    expect(after.model).toBe('anthropic/claude-x');
    expect(after.skillIds).toEqual([lib.skillId]);
    expect(after.configHash).not.toBe(before.configHash);
    // Version 1 still says how it began.
    expect(after.changeNote).toBe('Created');
    expect(await t.db.select({ n: count() }).from(configurationVersions)).toEqual([{ n: 1 }]);
  });

  it('saves an edit of a frozen version as the next version; the old one stays', async () => {
    const saved = await writes.create(input());
    await freeze(saved.versionId);
    const before = await versionRow(saved.versionId);

    const result = await writes.update(
      saved.configurationId,
      input({ model: 'anthropic/claude-x', skillIds: [lib.skillId] }),
    );
    expect(result).toMatchObject({ version: 2, createdNewVersion: true });
    expect(result.versionId).not.toBe(saved.versionId);
    expect(await versionRow(saved.versionId)).toEqual(before);

    const shown = await detail(saved.configurationId);
    expect(shown.versions.map((v) => [v.version, v.latest])).toEqual([
      [2, true],
      [1, false],
    ]);
    expect(shown.latest).toMatchObject({
      versionId: result.versionId,
      model: 'anthropic/claude-x',
      frozenAt: null,
      change: 'changed model; added skill invoice-method@1.0.0',
    });
    const v1 = await detail(saved.configurationId, 1);
    expect(v1.shown).toMatchObject({ version: 1, model: 'openai/gpt-6.1-sol', latest: false });
    expect(v1.latest.version).toBe(2);
    expect((await httpError(reads.detail(saved.configurationId, 3))).status).toBe(404);

    // Version 2 is not frozen: the next edit changes it in place, described against v1.
    const again = await writes.update(
      saved.configurationId,
      input({ model: 'anthropic/claude-x', skillIds: [lib.skillId], memoryEnabled: true }),
    );
    expect(again).toMatchObject({
      versionId: result.versionId,
      version: 2,
      createdNewVersion: false,
    });
    expect((await versionRow(result.versionId)).changeNote).toBe(
      'changed model; turned memory on; added skill invoice-method@1.0.0',
    );
  });

  it('creates nothing when the settings are unchanged, and renames without a version', async () => {
    const saved = await writes.create(input());
    await freeze(saved.versionId);
    const same = await writes.update(
      saved.configurationId,
      input({ toolsets: ['file', 'terminal'] }),
    );
    expect(same).toMatchObject({
      versionId: saved.versionId,
      version: 1,
      createdNewVersion: false,
    });

    const renamed = await writes.update(saved.configurationId, input({ name: 'control' }));
    expect(renamed).toMatchObject({ versionId: saved.versionId, createdNewVersion: false });
    const shown = await detail(saved.configurationId);
    expect(shown.name).toBe('control');
    expect(shown.latest.name).toBe('control');
    expect(shown.versions).toHaveLength(1);
  });

  it('answers 409 when renaming to a taken name, and 404 for an unknown configuration', async () => {
    await writes.create(input({ name: 'taken' }));
    const saved = await writes.create(input());
    const err = await httpError(writes.update(saved.configurationId, input({ name: 'taken' })));
    expect(err.status).toBe(409);
    expect((await detail(saved.configurationId)).name).toBe('baseline');
    expect((await httpError(writes.update('cfg_missing', input()))).status).toBe(404);
  });

  it('applies the reference rules to edits too', async () => {
    const saved = await writes.create(input());
    const err = await httpError(
      writes.update(saved.configurationId, input({ mcpServerVersionIds: [lib.mcpV1, lib.mcpV2] })),
    );
    expect(err.status).toBe(400);
    const underscored = await seedStdioMcpServer(t.db, 'invoice_db');
    const clash = await httpError(
      writes.update(
        saved.configurationId,
        input({ mcpServerVersionIds: [underscored, lib.mcpV2] }),
      ),
    );
    expect(clash.status).toBe(400);
    expect(clash.body.message).toMatch(
      /^MCP servers invoice_db and invoice-db cannot be used together/,
    );
    expect((await detail(saved.configurationId)).latest.mcpServers).toEqual([]);
    const missing = await httpError(
      writes.update(saved.configurationId, input({ skillIds: ['nope'] })),
    );
    expect(missing.body.message).toBe('skill nope does not exist');
  });

  it('refuses two versions of one skill or two same-named documents on edit, changing nothing', async () => {
    const saved = await writes.create(
      input({ skillIds: [lib.skillId], documentIds: [lib.documentId] }),
    );
    const before = await versionRow(saved.versionId);
    const skill110 = await secondSkillVersion();
    const doc2 = await sameNamedDocument();

    const skillsErr = await httpError(
      writes.update(saved.configurationId, input({ skillIds: [lib.skillId, skill110] })),
    );
    expect(skillsErr.status).toBe(400);
    expect(skillsErr.body.issues).toEqual(TWO_SKILL_VERSIONS);
    const docsErr = await httpError(
      writes.update(saved.configurationId, input({ documentIds: [lib.documentId, doc2] })),
    );
    expect(docsErr.status).toBe(400);
    expect(docsErr.body.issues).toEqual(TWO_SAME_NAMED_DOCUMENTS);

    const after = await versionRow(saved.versionId);
    expect(after).toMatchObject({
      skillIds: before.skillIds,
      documentIds: before.documentIds,
      configHash: before.configHash,
    });
  });
});

describe('sanitisedNameClashes', () => {
  it('groups distinct names that sanitise alike, in first-seen order', () => {
    expect(sanitisedNameClashes(['a-b', 'c', 'a_b', 'c-d', 'a-b'])).toEqual([
      { sanitised: 'a_b', names: ['a-b', 'a_b'] },
    ]);
    expect(sanitisedNameClashes(['x-y-z', 'x_y-z', 'x-y_z'])).toEqual([
      { sanitised: 'x_y_z', names: ['x-y-z', 'x_y-z', 'x-y_z'] },
    ]);
  });

  it('finds nothing among names that differ once sanitised, or one name twice', () => {
    expect(sanitisedNameClashes(['invoice-db', 'vendor-api', 'invoice-db'])).toEqual([]);
    expect(sanitisedNameClashes([])).toEqual([]);
  });
});
