/**
 * The draft routes over HTTP (plan 4.6 and 11): a draft of a loaded folder
 * starts with no change, edits of the suite's label, description and order
 * show in its change list and problems, new suites (empty, copied) refuse a
 * taken name, the review lists what Save writes, discard leaves nothing,
 * and a version downloads as a zip whose entries hash to what is stored.
 * Every success body parses with its shared schema.
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromBuffer, type Entry } from 'yauzl';
import {
  DraftReviewSchema,
  DraftSummarySchema,
  SuiteDraftViewSchema,
  SuiteListRowSchema,
} from '@hermes-evals/shared';
import { suiteDrafts, suites } from '../../database/schema/index.js';
import {
  startDraftsApp,
  suiteFiles,
  writeSuite,
  WRITE,
  type DraftsApp,
} from './drafts-testing.helper-spec.js';

let s: DraftsApp;

beforeAll(async () => {
  s = await startDraftsApp();
}, 120_000);

afterAll(async () => {
  await s?.close();
});

const view = (body: unknown) => SuiteDraftViewSchema.parse(body);

describe('a draft of a loaded folder', () => {
  it('opens on the current version with every task unchanged, once', async () => {
    const first = await s.http().post('/api/suites/invoices-v1/draft').set(WRITE).expect(201);
    const draft = view(first.body);
    expect(draft).toMatchObject({
      folder: 'invoices-v1',
      path: './suites/invoices-v1',
      name: 'invoices-v1',
      origin: 'edit',
      nextVersion: 3,
      versionLabel: '0.3',
      changes: [],
      problems: [],
      conflict: null,
      saving: null,
    });
    expect(draft.base?.versionNumber).toBe(2);
    expect(draft.tasks.map((t) => [t.key, t.state, t.baseVersion])).toEqual([
      ['total_due', 'unchanged', 2],
      ['summary_file', 'unchanged', 1],
    ]);
    expect(draft.tasks.map((t) => t.readiness)).toEqual(['ready', 'ready']);
    const again = await s.http().post('/api/suites/invoices-v1/draft').set(WRITE).expect(200);
    expect(view(again.body).id).toBe(draft.id);
  });

  it('is listed, and GET /suites/drafts is not taken for a suite id', async () => {
    const res = await s.http().get('/api/suites/drafts').expect(200);
    expect(DraftSummarySchema.array().parse(res.body)).toEqual([
      expect.objectContaining({
        folder: 'invoices-v1',
        baseVersion: 2,
        changeCount: 0,
        taskCount: 2,
        conflict: false,
      }),
    ]);
    SuiteListRowSchema.array().parse((await s.http().get('/api/suites').expect(200)).body);
  });

  it('records label, description and order changes, and an empty label as a problem', async () => {
    const res = await s
      .http()
      .patch('/api/suites/invoices-v1/draft')
      .set(WRITE)
      .send({
        versionLabel: '0.4',
        description: 'Two questions.',
        order: ['summary_file', 'total_due'],
      })
      .expect(200);
    const draft = view(res.body);
    expect(draft.changes).toEqual([
      { kind: 'label', from: '0.3', to: '0.4' },
      {
        kind: 'description',
        from: 'Two accounts-payable questions over one ledger.',
        to: 'Two questions.',
      },
      { kind: 'order' },
    ]);
    expect(draft.tasks.map((t) => t.key)).toEqual(['summary_file', 'total_due']);
    const empty = view(
      (
        await s
          .http()
          .patch('/api/suites/invoices-v1/draft')
          .set(WRITE)
          .send({ versionLabel: '' })
          .expect(200)
      ).body,
    );
    expect(empty.problems).toEqual([{ code: 'label_empty', message: 'Add a version label.' }]);
    const back = view(
      (
        await s
          .http()
          .patch('/api/suites/invoices-v1/draft')
          .set(WRITE)
          .send({
            versionLabel: '0.3',
            description: 'Two accounts-payable questions over one ledger.',
            order: ['total_due', 'summary_file'],
          })
          .expect(200)
      ).body,
    );
    expect(back.changes).toEqual([]);
  });

  it('refuses an order that leaves a task out, and an edit on an older revision', async () => {
    await s
      .http()
      .patch('/api/suites/invoices-v1/draft')
      .set(WRITE)
      .send({ order: ['total_due'] })
      .expect(400);
    const current = view((await s.http().get('/api/suites/invoices-v1/draft').expect(200)).body);
    const stale = await s
      .http()
      .patch('/api/suites/invoices-v1/draft')
      .set(WRITE)
      .send({ versionLabel: '0.5', revision: current.revision - 1 })
      .expect(409);
    expect(stale.body.statusCode).toBe(409);
  });

  it('refuses writes while a save runs, and shows the save', async () => {
    await s.t.db
      .update(suiteDrafts)
      .set({ saveStartedAt: new Date() })
      .where(eq(suiteDrafts.sourcePath, 'invoices-v1'));
    try {
      const refused = await s
        .http()
        .patch('/api/suites/invoices-v1/draft')
        .set(WRITE)
        .send({ versionLabel: '0.5' })
        .expect(409);
      expect(refused.body.message).toMatch(/being saved/);
      const shown = view((await s.http().get('/api/suites/invoices-v1/draft').expect(200)).body);
      expect(shown.saving).toMatchObject({ step: 'staging', selfChecks: null });
    } finally {
      await s.t.db
        .update(suiteDrafts)
        .set({ saveStartedAt: null })
        .where(eq(suiteDrafts.sourcePath, 'invoices-v1'));
    }
  });

  it('reviews what Save writes', async () => {
    await s
      .http()
      .patch('/api/suites/invoices-v1/draft')
      .set(WRITE)
      .send({ versionLabel: '0.4' })
      .expect(200);
    await s
      .http()
      .put('/api/suites/invoices-v1/draft/tasks/total_due')
      .set(WRITE)
      .send({ reference: '{\n  "total_due": 1234.57\n}\n' })
      .expect(200);
    const review = DraftReviewSchema.parse(
      (await s.http().get('/api/suites/invoices-v1/draft/review').expect(200)).body,
    );
    expect(review.changes).toEqual([
      { change: { kind: 'changed', key: 'total_due' }, detail: 'reference.json changed' },
      { change: { kind: 'label', from: '0.3', to: '0.4' }, detail: 'suite.yaml label 0.3 → 0.4' },
    ]);
    expect(review.writes).toEqual([
      {
        op: 'change',
        path: './suites/invoices-v1/suite.yaml',
        beforeBytes: null,
        afterBytes: null,
        note: 'version_label 0.3 → 0.4',
      },
      {
        op: 'change',
        path: './suites/invoices-v1/total_due/reference.json',
        beforeBytes: 27,
        afterBytes: 27,
        note: null,
      },
    ]);
    expect(review.readiness).toEqual([
      { key: 'total_due', state: 'changed', readiness: 'ready', note: 'reference passes `answer`' },
    ]);
    expect(review.invalid).toEqual([]);
  });

  it('discards, leaving nothing', async () => {
    await s.http().delete('/api/suites/invoices-v1/draft').set(WRITE).expect(204);
    await s.http().get('/api/suites/invoices-v1/draft').expect(404);
    await s.http().delete('/api/suites/invoices-v1/draft').set(WRITE).expect(404);
  });

  it('answers 404 for a folder that serves no version, 400 for a name that is not a folder', async () => {
    await s.http().post('/api/suites/nope/draft').set(WRITE).expect(404);
    await s.http().get('/api/suites/Not%20a%20folder/draft').expect(400);
  });
});

describe('a new suite', () => {
  it('starts empty, blocked until it has a task', async () => {
    const res = await s
      .http()
      .post('/api/suites/drafts')
      .set(WRITE)
      .send({
        name: 'vendor-statements-v1',
        versionLabel: '0.1',
        description: 'Reconciling vendor statements.',
        from: { kind: 'empty' },
      })
      .expect(201);
    expect(view(res.body)).toMatchObject({
      folder: 'vendor-statements-v1',
      origin: 'empty',
      base: null,
      nextVersion: 1,
      tasks: [],
      changes: [],
      problems: [{ code: 'no_tasks', message: 'Add at least one task to save v1.' }],
    });
  });

  it('refuses a name a suite or a draft holds', async () => {
    const taken = await s
      .http()
      .post('/api/suites/drafts')
      .set(WRITE)
      .send({ name: 'invoices-v1', versionLabel: '0.1', from: { kind: 'empty' } })
      .expect(409);
    expect(taken.body).toEqual({
      statusCode: 409,
      message: 'invoices-v1 is already used by ./suites/invoices-v1.',
    });
    await s
      .http()
      .post('/api/suites/drafts')
      .set(WRITE)
      .send({ name: 'vendor-statements-v1', versionLabel: '0.1', from: { kind: 'empty' } })
      .expect(409);
    await s
      .http()
      .post('/api/suites/drafts')
      .set(WRITE)
      .send({ name: 'Invoices v2', versionLabel: '0.1', from: { kind: 'empty' } })
      .expect(400);
  });

  it('copies every task of a version, already checked', async () => {
    const res = await s
      .http()
      .post('/api/suites/drafts')
      .set(WRITE)
      .send({
        name: 'invoices-copy',
        versionLabel: '1.0',
        from: { kind: 'copy', suite: 'invoices-v1', versionNumber: 1 },
      })
      .expect(201);
    const draft = view(res.body);
    expect(draft.origin).toBe('copy');
    expect(draft.tasks.map((t) => [t.key, t.state, t.readiness])).toEqual([
      ['total_due', 'added', 'ready'],
      ['summary_file', 'added', 'ready'],
    ]);
    expect(draft.changes.map((c) => c.kind)).toEqual(['added', 'added']);
    const review = DraftReviewSchema.parse(
      (await s.http().get('/api/suites/invoices-copy/draft/review').expect(200)).body,
    );
    expect(review.writes[0]).toMatchObject({
      op: 'add',
      path: './suites/invoices-copy/suite.yaml',
    });
    expect(review.writes.map((w) => w.path)).toContain(
      './suites/invoices-copy/summary_file/verify/check.py',
    );
    expect(review.changes[0]!.detail).toBe('new task · 4 files · 2 checks');
  });
});

/** Every entry of a zip, path → bytes. */
async function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  const zip = await new Promise<import('yauzl').ZipFile>((ok, fail) =>
    fromBuffer(bytes, { lazyEntries: true }, (err, z) => (err ? fail(err) : ok(z!))),
  );
  const out = new Map<string, Buffer>();
  await new Promise<void>((ok, fail) => {
    zip.on('entry', (entry: Entry) => {
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return fail(err);
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          out.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.on('end', ok);
    zip.on('error', fail);
    zip.readEntry();
  });
  return out;
}

describe('GET /suites/:suite/versions/:n/zip', () => {
  it('streams every file of the version, byte for byte, as <suite>-v<n>.zip', async () => {
    const res = await s
      .http()
      .get('/api/suites/invoices-v1/versions/1/zip')
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('filename="invoices-v1-v1.zip"');
    const entries = await unzip(res.body as Buffer);
    const files = suiteFiles(1);
    // Every file the loader read, as it was on disk; suite.yaml is written anew; the README was never stored.
    const expected = Object.keys(files).filter(
      (p) => p !== 'suite.yaml' && p !== 'summary_file/README.md',
    );
    expect([...entries.keys()].sort()).toEqual(
      ['invoices-v1/suite.yaml', ...expected.map((p) => `invoices-v1/${p}`)].sort(),
    );
    for (const path of expected) {
      const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
      expect(sha(entries.get(`invoices-v1/${path}`)!), path).toBe(sha(files[path]!));
    }
    expect(entries.get('invoices-v1/suite.yaml')!.toString()).toBe(
      "name: invoices-v1\nversion_label: '0.3'\ndescription: Two accounts-payable questions over one ledger.\ntasks:\n  - total_due\n  - summary_file\n",
    );
    const [v1] = await s.t.db.select().from(suites).where(eq(suites.versionNumber, 1));
    expect(v1).toBeDefined();
  });

  it('answers 404 for a version the folder never had', async () => {
    await s.http().get('/api/suites/invoices-v1/versions/9/zip').expect(404);
  });
});

describe('a folder whose current version moves past the draft', () => {
  it('shows the conflict: what the new version changed, and the tasks both sides changed', async () => {
    await s.http().post('/api/suites/invoices-v1/draft').set(WRITE).expect(201);
    await s
      .http()
      .put('/api/suites/invoices-v1/draft/tasks/total_due')
      .set(WRITE)
      .send({ reference: '{\n  "total_due": 1234.57\n}\n' })
      .expect(200);
    await writeSuite(s.suitesDir, 'invoices-v1', {
      'total_due/reference.json': '{\n  "total_due": 1234.99\n}\n',
    });
    await s.loader.loadOne('invoices-v1');
    const draft = view((await s.http().get('/api/suites/invoices-v1/draft').expect(200)).body);
    expect(draft.base?.versionNumber).toBe(2);
    expect(draft.nextVersion).toBe(4);
    expect(draft.conflict).toMatchObject({
      cause: 'version_moved',
      baseVersion: 2,
      current: { versionNumber: 3 },
      diskChanges: { added: [], removed: [], changed: ['total_due'], nowInvalid: [], nowValid: [] },
      draftKeys: ['total_due'],
      overlap: ['total_due'],
    });
    const summaries = DraftSummarySchema.array().parse(
      (await s.http().get('/api/suites/drafts').expect(200)).body,
    );
    expect(summaries.find((d) => d.folder === 'invoices-v1')?.conflict).toBe(true);
  });
});
