/**
 * Phase 5b end to end, the second world (phase5b.e2e-spec.ts has Flow E):
 *
 * - a suite imported from a .zip whose verify/ script is code: validation
 *   lists the script by path, size and hash, the import is refused until the
 *   scripts are trusted (R7), and v1 saves it byte for byte, its verifier
 *   self-checked by the loader;
 * - Reload all sends one load-suites job per directory and reports each
 *   folder's progress (Phase 4 #9);
 * - the round trip of plan 4.6: a copy of each of the five committed suites
 *   opened as a draft and saved with no edit reports `unchanged` and touches
 *   no file.
 *
 * The real AppModule and WorkerModule over a fresh Postgres 17 database, the
 * sandbox replaced as in Phases 2 to 6; every HTTP answer is parsed with its
 * shared schema.
 *
 *   TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres pnpm --filter @hermes-evals/api test:e2e
 */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DraftReviewSchema,
  DraftSummarySchema,
  SuiteDraftViewSchema,
  SuiteReloadProgressSchema,
  SuiteReloadResultSchema,
  SuiteZipValidationSchema,
} from '@hermes-evals/shared';
import { buildZip, zipItemsOfFolder } from '../src/suites/import/zip-testing.helper-spec.js';
import { Phase2World } from './support/phase2-app.js';
import { AuthoringClient, sha256, snapshot } from './support/phase5b-authoring.js';

const SERVER_URL = process.env.TEST_DATABASE_URL;
const REPO = join(import.meta.dirname, '..', '..', '..');
const COMPLETE = join(import.meta.dirname, 'fixtures', 'suites', 'complete');
/** The committed suites, copied (never the originals) under these folder names. */
const COMMITTED = ['invoices-v1', 'mcp-v1', 'memory-v1', 'knowledge-v1', 'tools-v1'];
const copyOf = (name: string) => `zz-smoke-${name}`;
const ZIPPED = 'zz-smoke-zip';

describe.skipIf(!SERVER_URL)('Phase 5b on Postgres 17: imports and round trips', () => {
  const world = new Phase2World(SERVER_URL!, 'phase5b_suites_e2e');
  const api = new AuthoringClient(() => world.api);
  let scratch = '';

  beforeAll(async () => {
    await world.start();
    for (const name of COMMITTED) {
      await cp(join(REPO, 'suites', name), join(world.suitesDir, copyOf(name)), {
        recursive: true,
      });
    }
    await world.startWorker();
    scratch = await mkdtemp(join(tmpdir(), 'hermes-evals-phase5b-zip-'));
  }, 180_000);

  afterAll(async () => {
    await world.stop();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }, 120_000);

  it('imports a suite zip with a verifier script only once its scripts are trusted', async () => {
    // A suite of one task whose second check is a verifier script.
    const source = join(scratch, 'zip-suite');
    await cp(join(COMPLETE, 'answer_verifier'), join(source, 'answer_verifier'), {
      recursive: true,
    });
    await writeFile(
      join(source, 'suite.yaml'),
      'name: zip-suite\nversion_label: "1.0"\ndescription: From a zip.\ntasks: [answer_verifier]\n',
    );
    const script = await readFile(join(source, 'answer_verifier', 'verify', 'check_count.py'));
    const zip = await buildZip(await zipItemsOfFolder(source, 'zip-suite/'));

    const checked = await api.upload(
      '/suites/import/validate',
      {},
      [{ field: 'file', name: 'zip-suite.zip', bytes: zip }],
      200,
      SuiteZipValidationSchema,
    );
    expect(checked).toMatchObject({
      outcome: 'valid',
      suite: { name: 'zip-suite', versionLabel: '1.0' },
      problems: [],
    });
    expect(checked.scripts).toEqual([
      {
        path: 'answer_verifier/verify/check_count.py',
        sizeBytes: script.length,
        sha256: sha256(script),
        runByCheck: true,
      },
    ]);
    expect(checked.verifyCounts).toEqual({ files: 1, checkScripts: 1 });
    expect(checked.rootFilesNotKept).toEqual([]);
    // No code runs before the scripts are trusted: the verifier's task waits for the worker.
    expect(checked.tasks).toEqual([
      expect.objectContaining({ key: 'answer_verifier', readiness: 'not_run' }),
    ]);

    const body = { token: checked.token!, name: ZIPPED, trustScripts: false };
    expect((await api.refused('post', '/suites/import', body, 409)).message).toBe(
      'Confirm the verifier scripts first.',
    );
    const imported = await api.json(
      'post',
      '/suites/import',
      { ...body, trustScripts: true },
      201,
      SuiteDraftViewSchema,
    );
    expect(imported).toMatchObject({ folder: ZIPPED, origin: 'zip', base: null, nextVersion: 1 });
    expect(imported.tasks.map((t) => [t.key, t.state])).toEqual([['answer_verifier', 'added']]);

    // The script is shown, never written: its source reads back, a write under verify/ is refused.
    const files = `/suites/${ZIPPED}/draft/tasks/answer_verifier/files`;
    const source_ = await api.download(`${files}/${encodeURIComponent('verify/check_count.py')}`);
    expect(sha256(source_.bytes)).toBe(sha256(script));
    await api.refused('delete', `${files}/${encodeURIComponent('verify/check_count.py')}`, {}, 400);

    const saved = await api.saveDraft(ZIPPED);
    expect(saved).toMatchObject({ outcome: 'created', taskCount: 1, validCount: 1 });
    expect(saved.suite).toMatchObject({ versionNumber: 1, versionLabel: '1.0' });
    const written = await snapshot(join(world.suitesDir, ZIPPED, 'answer_verifier'));
    expect(written).toEqual(await snapshot(join(source, 'answer_verifier')));
  });

  it('sends one load job per directory on Reload all and reports each folder', async () => {
    const before = await api.get('/suites/reload/progress', SuiteReloadProgressSchema);
    expect(before).toMatchObject({ active: false, directories: [] });
    const result = await api.json('post', '/suites/reload', {}, 200, SuiteReloadResultSchema);
    const folders = ['phase2', ZIPPED, ...COMMITTED.map(copyOf)].map((f) => `./suites/${f}`);
    expect(result.suites.map((s) => s.sourcePath).sort()).toEqual([...folders].sort());
    expect(result.suites.every((s) => s.outcome === 'unchanged')).toBe(true);

    const progress = await api.get('/suites/reload/progress', SuiteReloadProgressSchema);
    expect(progress.active).toBe(false);
    expect(progress.finishedAt).not.toBeNull();
    expect(progress.directories.map((d) => d.sourcePath).sort()).toEqual([...folders].sort());
    expect(progress.directories.every((d) => d.state === 'done')).toBe(true);
  }, 120_000);

  it.each(COMMITTED)(
    'opens a copy of %s as a draft and saves it back unchanged, touching no file',
    async (name) => {
      const folder = copyOf(name);
      const before = await snapshot(join(world.suitesDir, folder));
      const opened = await api.openDraft(folder);
      expect(opened.changes).toEqual([]);
      expect(opened.problems).toEqual([]);
      expect(opened.tasks.every((t) => t.state === 'unchanged')).toBe(true);
      const drafts = await api.get('/suites/drafts', z.array(DraftSummarySchema));
      expect(drafts.find((d) => d.folder === folder)).toMatchObject({ changeCount: 0 });

      const review = await api.get(`/suites/${folder}/draft/review`, DraftReviewSchema);
      expect(review.changes).toEqual([]);
      expect(review.writes).toEqual([]);

      const saved = await api.saveDraft(folder);
      expect(saved).toMatchObject({ outcome: 'unchanged', suite: { versionNumber: 1 } });
      expect(saved.validCount).toBe(saved.taskCount);
      await api.refused('get', `/suites/${folder}/draft`, undefined, 404);
      expect(await snapshot(join(world.suitesDir, folder))).toEqual(before);
    },
    120_000,
  );
});
