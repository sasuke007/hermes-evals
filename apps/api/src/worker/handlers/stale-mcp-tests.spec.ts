/** The stale `running` reconciler on PGlite, with pg-boss's job lookup answered by hand. */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { mcpServerVersions } from '../../database/schema/index.js';
import { McpServersService } from '../../resources/mcp/mcp-servers.service.js';
import { INVOICE_DB } from '../../resources/mcp/mcp-testing.support-spec.js';
import { reconcileStaleMcpTests, STALE_TEST_ERROR, type JobLookup } from './stale-mcp-tests.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REQUESTED = '2026-10-24T09:00:00.000Z';
const NOW = new Date('2026-10-24T09:10:00.000Z');

let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
});

afterEach(async () => {
  await t.close();
});

/** findJobs by id, from a table of job states; an id not in it is a job pg-boss deleted. */
const jobs = (states: Record<string, string>): JobLookup =>
  ({
    findJobs: async (_queue: string, query: { id: string }) =>
      query.id in states ? [{ id: query.id, state: states[query.id] }] : [],
  }) as unknown as JobLookup;

async function serverWith(name: string, lastTest: unknown): Promise<string> {
  const row = await new McpServersService(t.db).create({ ...INVOICE_DB, name });
  await t.db
    .update(mcpServerVersions)
    .set({ lastTest: lastTest as never })
    .where(eq(mcpServerVersions.id, row.versionId));
  return row.versionId;
}

const lastTestOf = async (versionId: string) =>
  (await t.db.select().from(mcpServerVersions).where(eq(mcpServerVersions.id, versionId)))[0]!
    .lastTest;

const running = (jobId: string) => ({ status: 'running', job_id: jobId, requested_at: REQUESTED });

describe('reconcileStaleMcpTests', () => {
  it('fails running records whose job ended or is gone, and leaves live jobs and results alone', async () => {
    const gone = await serverWith('gone', running('job-gone'));
    const crashed = await serverWith('crashed', running('job-failed'));
    const live = await serverWith('live', running('job-active'));
    const passed = {
      status: 'passed',
      job_id: 'job-done',
      requested_at: REQUESTED,
      finished_at: REQUESTED,
      started_ms: 10,
      tools: [],
    };
    const done = await serverWith('done', passed);

    const changed = await reconcileStaleMcpTests(
      t.db,
      jobs({ 'job-failed': 'failed', 'job-active': 'active', 'job-done': 'completed' }),
      () => NOW,
    );

    expect(changed).toBe(2);
    for (const [versionId, jobId] of [
      [gone, 'job-gone'],
      [crashed, 'job-failed'],
    ] as const) {
      expect(await lastTestOf(versionId)).toEqual({
        status: 'failed',
        job_id: jobId,
        requested_at: REQUESTED,
        finished_at: NOW.toISOString(),
        error: STALE_TEST_ERROR,
        exit_code: null,
        missing_secret_names: [],
      });
    }
    // Another worker may still be running it.
    expect(await lastTestOf(live)).toEqual(running('job-active'));
    expect(await lastTestOf(done)).toEqual(passed);
  });

  it('changes nothing when no test is running', async () => {
    await serverWith('idle', { status: 'untested' });
    expect(await reconcileStaleMcpTests(t.db, jobs({}))).toBe(0);
  });
});
