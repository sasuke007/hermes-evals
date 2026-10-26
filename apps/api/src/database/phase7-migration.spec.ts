/**
 * Migration 0010 (Phase 7): an http MCP header pair's optional prefix in
 * the headers CHECK (Phase 6 question 6), the uploads a draft task refused
 * for their size (Phase 5b question 11), and a zip draft's suite.yaml as
 * the zip held it (Phase 5b question 17). Checked on a fresh database, and
 * on one migrated by the Phase 5b build that already holds an MCP
 * definition and a zip draft, which keep their rows and their hash.
 */
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTHORING_LIMITS,
  canonicalMcpHeaders,
  type DraftRefusedUpload,
  type McpHeader,
  type McpServerInput,
} from '@hermes-evals/shared';
import {
  createTestDatabase,
  createTestDatabaseUpTo,
  rejection,
  SQLSTATE,
  type TestDatabase,
  type TestDb,
} from '../../test/support/database.js';
import { sha } from '../../test/support/seed.js';
import { definitionHash } from '../resources/mcp/definition.js';
import { newId } from './ids.js';
import { mcpServers, mcpServerVersions, suiteDrafts, suiteDraftTasks } from './schema/index.js';

let t: TestDatabase | undefined;

afterEach(async () => {
  await t?.close();
  t = undefined;
});

const TOKEN: McpHeader = { header: 'Authorization', env: 'VENDOR_DIRECTORY_TOKEN' };

/** The sample http server as Phase 6 defined it (docker/mcp/vendor-directory), before prefixes. */
const VENDOR_DIRECTORY: McpServerInput = {
  name: 'vendor-directory',
  transport: 'http',
  command: null,
  args: [],
  envNames: [],
  url: 'http://vendor-directory:8000/mcp',
  headers: [TOKEN],
  include: [],
  exclude: [],
  timeoutS: 60,
};

/**
 * Its definition hash as every build before Phase 7 computed and stored it:
 * sha256 of the canonical JSON (sorted keys) of the definition with header
 * names lower-cased and pairs as `{ header, env }`.
 */
const VENDOR_DIRECTORY_HASH = '516575f17807476ca732421ddfec5b58fc92e6c290c35d1b0dfdfbd08c15663d';

/** Inserts an http MCP server `name` whose version 1 has `headers`; resolves its version id. */
async function httpServer(db: TestDb, name: string, headers: unknown): Promise<string> {
  return db.transaction(async (tx) => {
    const [server] = await tx.insert(mcpServers).values({ name }).returning();
    const [version] = await tx
      .insert(mcpServerVersions)
      .values({
        mcpServerId: server!.id,
        version: 1,
        transport: 'http',
        url: 'http://vendor-directory:8000/mcp',
        headers: headers as McpHeader[],
        definitionHash: sha(name),
      })
      .returning();
    return version!.id;
  });
}

const REFUSED: DraftRefusedUpload = {
  path: 'fixtures/ledger-2025.parquet',
  kind: 'fixture',
  sizeBytes: 32_715_571,
  limitBytes: AUTHORING_LIMITS.suiteMaxFileBytes,
  refusedAt: '2026-10-26T16:31:00.000Z',
};

/** A zip draft of a new suite with one added task. */
async function zipDraft(db: TestDb, suiteYaml: string | null) {
  const [draft] = await db
    .insert(suiteDrafts)
    .values({
      sourcePath: 'imported',
      name: 'imported',
      origin: 'zip',
      versionLabel: '0.1',
      suiteYaml,
    })
    .returning();
  const [task] = await db
    .insert(suiteDraftTasks)
    .values({ draftId: draft!.id, key: 'total_due', position: 0, state: 'added' })
    .returning();
  return { draft: draft!, task: task! };
}

describe('migration 0010 rules', () => {
  it('lets a header pair carry a printable prefix, or none', async () => {
    t = await createTestDatabase();
    await httpServer(t.db, 'plain', [TOKEN]);
    const bearer = await httpServer(t.db, 'bearer', [{ ...TOKEN, prefix: 'Bearer ' }]);
    const [row] = await t.db
      .select({ headers: mcpServerVersions.headers })
      .from(mcpServerVersions)
      .where(eq(mcpServerVersions.id, bearer));
    expect(row!.headers).toEqual([{ ...TOKEN, prefix: 'Bearer ' }]);
    await httpServer(t.db, 'longest', [{ ...TOKEN, prefix: '~'.repeat(64) }]);
  });

  it('refuses a prefix that is empty, too long, not text, null, or holds a control character', async () => {
    t = await createTestDatabase();
    const bad: unknown[] = ['', 'x'.repeat(65), 7, null, 'Bearer\r\nX-Evil: 1', 'Bearer\t', 'é'];
    for (const [i, prefix] of bad.entries()) {
      const refused = await rejection(httpServer(t.db, `bad-${i}`, [{ ...TOKEN, prefix }]));
      expect(refused.code, JSON.stringify(prefix)).toBe(SQLSTATE.checkViolation);
      expect(refused.message).toMatch(/mcp_server_versions_headers_ck/);
    }
  });

  it('keeps the uploads a draft task refused, none to start with', async () => {
    t = await createTestDatabase();
    const { task } = await zipDraft(t.db, null);
    expect(task.refusedUploads).toEqual([]);
    const [kept] = await t.db
      .update(suiteDraftTasks)
      .set({ refusedUploads: [REFUSED] })
      .where(eq(suiteDraftTasks.id, task.id))
      .returning();
    expect(kept!.refusedUploads).toEqual([REFUSED]);
    const notList = await rejection(
      t.db.execute(sql`update suite_draft_tasks set refused_uploads = '{}'::jsonb`),
    );
    expect(notList.code).toBe(SQLSTATE.checkViolation);
    expect(notList.message).toMatch(/suite_draft_tasks_refused_uploads_ck/);
  });

  it("keeps a zip draft's suite.yaml as the zip held it, and only a zip draft's", async () => {
    t = await createTestDatabase();
    const text =
      'name: imported\n# kept as written\nversion_label: "0.1"\ndescription: >-\n  Folded\n';
    const { draft } = await zipDraft(t.db, text);
    expect(draft.suiteYaml).toBe(text);
    const empty = await rejection(
      t.db.insert(suiteDrafts).values({
        sourcePath: 'blank',
        name: 'blank',
        origin: 'empty',
        versionLabel: '0.1',
        suiteYaml: 'name: blank\n',
      }),
    );
    expect(empty.code).toBe(SQLSTATE.checkViolation);
    expect(empty.message).toMatch(/suite_drafts_suite_yaml_ck/);
  });
});

describe('migration 0010 on a Phase 5b database', () => {
  it(
    'keeps every definition and draft, and an unchanged definition its hash',
    { timeout: 30_000 },
    async () => {
      const partial = await createTestDatabaseUpTo('0009_phase5b_authoring');
      t = partial;
      // As the Phase 5b build stored them, by column, before 0010's columns exist.
      const versionId = await httpServer(partial.db, 'vendor-directory', [TOKEN]);
      await partial.pg.query(`update mcp_server_versions set definition_hash = $1 where id = $2`, [
        definitionHash(VENDOR_DIRECTORY),
        versionId,
      ]);
      const draftId = newId();
      await partial.pg.query(
        `insert into suite_drafts (id, source_path, name, origin, version_label)
         values ($1, 'imported', 'imported', 'zip', '0.1')`,
        [draftId],
      );
      await partial.pg.query(
        `insert into suite_draft_tasks (id, draft_id, key, position, state)
         values ($1, $2, 'total_due', 0, 'added')`,
        [newId(), draftId],
      );
      const before = await partial.pg.query('select * from mcp_server_versions order by id');

      await partial.migrateRest();

      expect(
        (await partial.pg.query('select * from mcp_server_versions order by id')).rows,
      ).toEqual(before.rows);
      const [draft] = await partial.db.select().from(suiteDrafts);
      expect(draft!.suiteYaml).toBeNull();
      const [task] = await partial.db.select().from(suiteDraftTasks);
      expect(task!.refusedUploads).toEqual([]);
      // A definition without a prefix hashes as it always did, so reloading
      // it makes no new MCP server version.
      expect(definitionHash(VENDOR_DIRECTORY)).toBe(VENDOR_DIRECTORY_HASH);
      expect(canonicalMcpHeaders(VENDOR_DIRECTORY.headers)).toEqual([
        { header: 'authorization', env: 'VENDOR_DIRECTORY_TOKEN' },
      ]);
    },
  );
});
