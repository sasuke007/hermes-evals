/**
 * The form's drafts (duplicate, edit), the diff table and the list, on
 * PGlite with the real migrations and triggers. Every view is checked
 * against its shared schema.
 */
import { count, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigDiffSchema,
  ConfigurationDetailSchema,
  ConfigurationDraftSchema,
  ConfigurationListRowSchema,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { configurations } from '../database/schema/index.js';
import { ConfigurationReadsService } from './configuration-reads.service.js';
import { ConfigurationWritesService } from './configuration-writes.service.js';
import {
  freezeVersion,
  configurationInput as input,
  httpError,
  seedLibrary,
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

describe('duplicate', () => {
  it('prefills a draft, stores nothing, and records where the saved copy came from', async () => {
    const base = await writes.create(input());
    const draft = ConfigurationDraftSchema.parse(await reads.duplicateDraft(base.configurationId));
    expect(draft).toMatchObject({
      mode: 'duplicate',
      source: {
        configurationId: base.configurationId,
        versionId: base.versionId,
        name: 'baseline',
        version: 1,
      },
      createsNewVersion: false,
      nextVersion: null,
      experimentsKeepingVersion: [],
    });
    expect(draft.values).toMatchObject({
      name: 'baseline-copy',
      toolsets: ['file', 'terminal'],
      duplicatedFromVersionId: base.versionId,
    });
    expect(await t.db.select({ n: count() }).from(configurations)).toEqual([{ n: 1 }]);

    const copy = await writes.create(
      input({ ...draft.values, name: 'with-skill', skillIds: [lib.skillId] }),
    );
    const shown = await detail(copy.configurationId);
    expect(shown.latest.change).toBe(
      'Duplicated from baseline v1; added skill invoice-method@1.0.0',
    );
    expect(shown.duplicatedFrom).toEqual({
      configurationId: base.configurationId,
      versionId: base.versionId,
      name: 'baseline',
      version: 1,
    });
    expect(shown.differsFromSource).toEqual(['skills']);
    expect((await versionRow(copy.versionId)).duplicatedFromVersionId).toBe(base.versionId);

    // The edit draft keeps the origin, and an edit cannot change it.
    const edit = ConfigurationDraftSchema.parse(await reads.editDraft(copy.configurationId));
    expect(edit.values.duplicatedFromVersionId).toBe(base.versionId);
    await writes.update(
      copy.configurationId,
      input({
        name: 'with-skill',
        skillIds: [lib.skillId],
        maxTurns: 30,
        duplicatedFromVersionId: null,
      }),
    );
    expect((await versionRow(copy.versionId)).duplicatedFromVersionId).toBe(base.versionId);
    expect((await versionRow(copy.versionId)).changeNote).toBe(
      'Duplicated from baseline v1; added skill invoice-method@1.0.0; changed max turns',
    );
  });

  it('picks a free copy name', async () => {
    const base = await writes.create(input());
    await writes.create(input({ name: 'baseline-copy' }));
    const draft = await reads.duplicateDraft(base.configurationId);
    expect(draft.values.name).toBe('baseline-copy-2');
  });

  it('answers 400 when the source version does not exist, and 404 for an unknown configuration', async () => {
    const err = await httpError(writes.create(input({ duplicatedFromVersionId: 'cfgv_missing' })));
    expect(err.status).toBe(400);
    expect(err.body.message).toBe('configuration version cfgv_missing does not exist');
    expect((await httpError(reads.duplicateDraft('cfg_missing'))).status).toBe(404);
  });
});

describe('edit draft', () => {
  it('says whether saving creates the next version', async () => {
    const saved = await writes.create(input({ documentIds: [lib.documentId] }));
    const open = ConfigurationDraftSchema.parse(await reads.editDraft(saved.configurationId));
    expect(open).toMatchObject({
      mode: 'edit',
      createsNewVersion: false,
      nextVersion: null,
      experimentsKeepingVersion: [],
    });
    expect(open.values).toEqual({
      name: 'baseline',
      model: 'openai/gpt-6.1-sol',
      provider: 'nous',
      baseUrl: null,
      toolsets: ['file', 'terminal'],
      memoryEnabled: false,
      skillIds: [],
      documentIds: [lib.documentId],
      mcpServerVersionIds: [],
      maxTurns: 20,
      timeBudgetS: 300,
      duplicatedFromVersionId: null,
    });
    await freeze(saved.versionId);
    const frozen = await reads.editDraft(saved.configurationId);
    expect(frozen).toMatchObject({ createsNewVersion: true, nextVersion: 2 });
  });
});

describe('diff', () => {
  it('compares two or three versions field by field, in the order asked', async () => {
    const base = await writes.create(input());
    const skill = await writes.create(input({ name: 'with-skill', skillIds: [lib.skillId] }));
    const mcp = await writes.create(input({ name: 'with-mcp', mcpServerVersionIds: [lib.mcpV1] }));
    const diff = ConfigDiffSchema.parse(
      await reads.diff([base.versionId, skill.versionId, mcp.versionId]),
    );
    expect(diff.columns.map((c) => c.name)).toEqual(['baseline', 'with-skill', 'with-mcp']);
    expect(diff.differing).toEqual(['skills', 'mcp_servers']);
    expect(diff.rows.find((r) => r.field === 'mcp_servers')!.values).toEqual([
      '—',
      '—',
      'invoice-db (stdio)',
    ]);
    expect(diff.rows.find((r) => r.field === 'toolsets')).toEqual({
      field: 'toolsets',
      values: ['file, terminal', 'file, terminal', 'file, terminal'],
      differs: false,
    });

    const missing = await httpError(reads.diff([base.versionId, 'cfgv_missing']));
    expect(missing).toEqual({
      status: 404,
      body: { statusCode: 404, message: 'configuration version cfgv_missing not found' },
    });
  });

  it('compares two versions of one configuration', async () => {
    const saved = await writes.create(input());
    await freeze(saved.versionId);
    const v2 = await writes.update(saved.configurationId, input({ timeBudgetS: 600 }));
    const diff = await reads.diff([saved.versionId, v2.versionId]);
    expect(diff.columns.map((c) => c.version)).toEqual([1, 2]);
    expect(diff.differing).toEqual(['time_budget_s']);
  });
});

describe('lists', () => {
  it('lists every configuration at its latest version, in creation order', async () => {
    const a = await writes.create(input({ name: 'zeta' }));
    await writes.create(input({ name: 'alpha' }));
    await freeze(a.versionId);
    await writes.update(a.configurationId, input({ name: 'zeta', maxTurns: 50 }));
    const rows = ConfigurationListRowSchema.array().parse(await reads.list());
    expect(rows.map((r) => [r.name, r.latest.version])).toEqual([
      ['zeta', 2],
      ['alpha', 1],
    ]);
    const [latest] = await t.db
      .select({ v: configurations.latestVersion })
      .from(configurations)
      .where(eq(configurations.id, a.configurationId));
    expect(latest!.v).toBe(2);
  });
});
