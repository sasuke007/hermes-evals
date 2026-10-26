/**
 * Skill loading (Phase 6 P5) on PGlite with the real migrations and
 * triggers: how a version stores `preload` or `on_demand`, what it hashes
 * to, how edits, duplicates and the diff carry it, and the 400 for on demand
 * loading without a skill. Every view is checked against its shared schema.
 */
import { count, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ConfigDiffSchema,
  ConfigurationDetailSchema,
  ConfigurationDraftSchema,
  ConfigurationInputSchema,
  ConfigurationListRowSchema,
  SKILL_LOADING_NEEDS_SKILLS,
  type ConfigurationInput,
} from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../test/support/database.js';
import { newId } from '../database/ids.js';
import { configurations, configurationVersions } from '../database/schema/index.js';
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
const versionRow = (versionId: string) => storedVersion(t.db, versionId);

/**
 * The config hash Phase 5 (commit 660fff1) stored for the library's
 * invoice-method@1.0.0, vendor-policy-v3.pdf and invoice-db v1 with the
 * input() defaults, computed with that commit's configHash.
 */
const PHASE5_HASH = '6a8b127b407e237376b018142aeaa7cd48a6394c45e32ced24c738c558912bb8';

const withLibrary = (overrides: Partial<ConfigurationInput> = {}) =>
  input({
    skillIds: [lib.skillId],
    documentIds: [lib.documentId],
    mcpServerVersionIds: [lib.mcpV1],
    ...overrides,
  });

describe('saving', () => {
  it('stores on demand, shows it on every view, and hashes it apart from preload', async () => {
    const pre = await writes.create(input({ name: 'with-skill', skillIds: [lib.skillId] }));
    const onDemand = await writes.create(
      input({ name: 'on-demand', skillIds: [lib.skillId], skillLoading: 'on_demand' }),
    );
    expect((await versionRow(pre.versionId)).skillLoading).toBe('preload');
    expect((await versionRow(onDemand.versionId)).skillLoading).toBe('on_demand');

    const rows = ConfigurationListRowSchema.array().parse(await reads.list());
    expect(rows.map((r) => [r.name, r.latest.skillLoading])).toEqual([
      ['with-skill', 'preload'],
      ['on-demand', 'on_demand'],
    ]);
    const shown = await detail(onDemand.configurationId);
    expect(shown.latest).toMatchObject({ skillLoading: 'on_demand', change: 'Created' });
    expect((await versionRow(onDemand.versionId)).configHash).not.toBe(
      (await versionRow(pre.versionId)).configHash,
    );
  });

  it('hashes a preload version exactly as Phase 5 stored it', async () => {
    // input() always fills skillLoading; a body without it parses to preload too.
    const body: Record<string, unknown> = { ...withLibrary() };
    delete body.skillLoading;
    const saved = await writes.create(ConfigurationInputSchema.parse(body));
    expect(await versionRow(saved.versionId)).toMatchObject({
      skillLoading: 'preload',
      configHash: PHASE5_HASH,
    });
  });

  it('answers 400 for on demand loading without a skill, and stores nothing', async () => {
    const body = { ...input(), skillLoading: 'on_demand' as const };
    // The request pipe refuses it first...
    const parsed = ConfigurationInputSchema.safeParse(body);
    expect(parsed.success ? [] : parsed.error.issues.map((i) => [i.path, i.message])).toEqual([
      [['skillLoading'], SKILL_LOADING_NEEDS_SKILLS],
    ]);
    // ...and the service holds a caller inside the API to the same rule.
    const refused = {
      status: 400,
      body: {
        statusCode: 400,
        message: SKILL_LOADING_NEEDS_SKILLS,
        issues: [{ path: 'skillLoading', message: SKILL_LOADING_NEEDS_SKILLS }],
      },
    };
    expect(await httpError(writes.create(body))).toEqual(refused);
    expect(await t.db.select({ n: count() }).from(configurations)).toEqual([{ n: 0 }]);

    // Removing the last skill of an on demand configuration is refused the same way.
    const saved = await writes.create(
      input({ skillIds: [lib.skillId], skillLoading: 'on_demand' }),
    );
    expect(await httpError(writes.update(saved.configurationId, body))).toEqual(refused);
    expect(await versionRow(saved.versionId)).toMatchObject({
      skillIds: [lib.skillId],
      skillLoading: 'on_demand',
    });
  });
});

describe('a version stored before Phase 6', () => {
  /** A version inserted naming only the columns Phase 5 had, as a pre-0008 row was. */
  async function phase5Version(): Promise<{ configurationId: string; versionId: string }> {
    return t.db.transaction(async (tx) => {
      const [configuration] = await tx
        .insert(configurations)
        .values({ name: 'baseline' })
        .returning({ id: configurations.id });
      const id = newId();
      const ids = (list: string[]) => sql.raw(`'{${list.join(',')}}'`);
      await tx.execute(sql`
        insert into configuration_versions
          (id, configuration_id, version, model, provider, toolsets, skill_ids, document_ids,
           mcp_server_version_ids, max_turns, time_budget_s, config_hash, change_note)
        values (${id}, ${configuration!.id}, 1, 'openai/gpt-6.1-sol', 'nous', ${ids(['file', 'terminal'])},
          ${ids([lib.skillId])}, ${ids([lib.documentId])}, ${ids([lib.mcpV1])}, 20, 300,
          ${PHASE5_HASH}, 'Created')`);
      return { configurationId: configuration!.id, versionId: id };
    });
  }

  it('reads as preload, keeps its hash on an unchanged save, and changes mode as a new version', async () => {
    const old = await phase5Version();
    expect((await detail(old.configurationId)).latest).toMatchObject({
      skillLoading: 'preload',
      configHash: PHASE5_HASH,
    });
    const same = await writes.update(old.configurationId, withLibrary());
    expect(same).toMatchObject({ versionId: old.versionId, createdNewVersion: false });
    expect((await versionRow(old.versionId)).configHash).toBe(PHASE5_HASH);

    await freezeVersion(t.db, old.versionId);
    const next = await writes.update(
      old.configurationId,
      withLibrary({ skillLoading: 'on_demand' }),
    );
    expect(next).toMatchObject({ version: 2, createdNewVersion: true });
    const v2 = await versionRow(next.versionId);
    expect(v2).toMatchObject({
      skillLoading: 'on_demand',
      changeNote: 'set skill loading to on demand',
    });
    expect(v2.configHash).not.toBe(PHASE5_HASH);
    expect(await versionRow(old.versionId)).toMatchObject({
      skillLoading: 'preload',
      configHash: PHASE5_HASH,
    });
  });
});

describe('drafts and the diff', () => {
  it('copies the mode into the edit and duplicate drafts, and names a change', async () => {
    const source = await writes.create(
      input({ name: 'on-demand', skillIds: [lib.skillId], skillLoading: 'on_demand' }),
    );
    const edit = ConfigurationDraftSchema.parse(await reads.editDraft(source.configurationId));
    expect(edit.values.skillLoading).toBe('on_demand');
    const draft = ConfigurationDraftSchema.parse(
      await reads.duplicateDraft(source.configurationId),
    );
    expect(draft.values).toMatchObject({
      name: 'on-demand-copy',
      skillIds: [lib.skillId],
      skillLoading: 'on_demand',
    });

    const same = await writes.create(input(draft.values));
    const sameShown = await detail(same.configurationId);
    expect(sameShown.latest).toMatchObject({
      skillLoading: 'on_demand',
      change: 'Duplicated from on-demand v1',
    });
    expect(sameShown.differsFromSource).toEqual([]);
    expect(sameShown.latest.configHash).toBe(
      (await detail(source.configurationId)).latest.configHash,
    );

    const preload = await writes.create(
      input({ ...draft.values, name: 'preload', skillLoading: 'preload' }),
    );
    const preloadShown = await detail(preload.configurationId);
    expect(preloadShown.latest.change).toBe(
      'Duplicated from on-demand v1; set skill loading to preload',
    );
    expect(preloadShown.differsFromSource).toEqual(['skill_loading']);
  });

  it('diffs skill loading as its own row', async () => {
    const base = await writes.create(input());
    const pre = await writes.create(input({ name: 'with-skill', skillIds: [lib.skillId] }));
    const onDemand = await writes.create(
      input({ name: 'on-demand', skillIds: [lib.skillId], skillLoading: 'on_demand' }),
    );
    const pair = ConfigDiffSchema.parse(await reads.diff([pre.versionId, onDemand.versionId]));
    expect(pair.differing).toEqual(['skill_loading']);
    expect(pair.rows.find((r) => r.field === 'skill_loading')).toEqual({
      field: 'skill_loading',
      values: ['preload', 'on demand'],
      differs: true,
    });
    const three = ConfigDiffSchema.parse(
      await reads.diff([base.versionId, pre.versionId, onDemand.versionId]),
    );
    expect(three.differing).toEqual(['skills', 'skill_loading']);
    expect(three.rows.find((r) => r.field === 'skill_loading')!.values).toEqual([
      'preload',
      'preload',
      'on demand',
    ]);
    // Unused, so the stored rows are what the views read.
    expect(
      (await t.db.select({ mode: configurationVersions.skillLoading }).from(configurationVersions))
        .map((r) => r.mode)
        .sort(),
    ).toEqual(['on_demand', 'preload', 'preload']);
  });
});
