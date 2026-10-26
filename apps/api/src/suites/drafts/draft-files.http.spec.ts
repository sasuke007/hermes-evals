/**
 * The file routes of a draft task over HTTP (plan 4.6 and 11; SA.6):
 * uploads to the blob store, reads and previews, moves and deletes, the
 * expected folder named in task.yaml by its first file, home seeds, and
 * every write under verify/ refused (R7) while its source stays readable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DraftTaskDetailSchema,
  TablePreviewSchema,
  type DraftTaskDetail,
} from '@hermes-evals/shared';
import {
  CHECK_PY,
  startDraftsApp,
  TOTAL_DUE_YAML,
  WRITE,
  type DraftsApp,
} from './drafts-testing.helper-spec.js';

let s: DraftsApp;
const base = '/api/suites/invoices-v1/draft';

beforeAll(async () => {
  s = await startDraftsApp();
  await s.http().post(base).set(WRITE).expect(201);
}, 120_000);

afterAll(async () => {
  await s?.close();
});

const detail = (body: unknown): DraftTaskDetail => DraftTaskDetailSchema.parse(body);
const put = (key: string, body: object) =>
  s.http().put(`${base}/tasks/${key}`).set(WRITE).send(body);

describe('files', () => {
  it('uploads a workspace file to the blob store, and reads and previews it', async () => {
    const csv = 'id,amount\n1,2\n';
    const res = await s
      .http()
      .post(`${base}/tasks/total_due/files`)
      .set(WRITE)
      .field('kind', 'fixture')
      .field('path', 'docs/ledger.csv')
      .attach('file', Buffer.from(csv), 'ledger.csv')
      .expect(201);
    const task = detail(res.body);
    expect(task.files.find((f) => f.path === 'fixtures/docs/ledger.csv')).toMatchObject({
      kind: 'fixture',
      agentPath: '/workspace/docs/ledger.csv',
      sizeBytes: csv.length,
    });
    expect(task.state).toBe('changed');
    const bytes = await s
      .http()
      .get(`${base}/tasks/total_due/files/${encodeURIComponent('fixtures/docs/ledger.csv')}`)
      .expect(200);
    expect(bytes.text).toBe(csv);
    const preview = TablePreviewSchema.parse(
      (
        await s
          .http()
          .get(
            `${base}/tasks/total_due/files/${encodeURIComponent('fixtures/docs/ledger.csv')}/preview`,
          )
          .expect(200)
      ).body,
    );
    expect(preview).toEqual({ columns: ['id', 'amount'], rows: [['1', '2']], totalRows: 1 });
  });

  it('moves and deletes a file, and the task is unchanged again', async () => {
    const path = encodeURIComponent('fixtures/docs/ledger.csv');
    const moved = detail(
      (
        await s
          .http()
          .patch(`${base}/tasks/total_due/files/${path}`)
          .set(WRITE)
          .send({ path: 'fixtures/ledger.csv' })
          .expect(200)
      ).body,
    );
    expect(moved.files.map((f) => f.path)).toContain('fixtures/ledger.csv');
    await s
      .http()
      .patch(`${base}/tasks/total_due/files/${encodeURIComponent('fixtures/ledger.csv')}`)
      .set(WRITE)
      .send({ path: 'fixtures/invoices.csv' })
      .expect(409);
    const deleted = detail(
      (
        await s
          .http()
          .delete(`${base}/tasks/total_due/files/${encodeURIComponent('fixtures/ledger.csv')}`)
          .set(WRITE)
          .expect(200)
      ).body,
    );
    expect(deleted.state).toBe('unchanged');
  });

  it('names the expected folder in task.yaml when an expected file is the first', async () => {
    const res = await s
      .http()
      .post(`${base}/tasks/total_due/files`)
      .set(WRITE)
      .field('kind', 'expected')
      .attach('file', Buffer.from('a\n'), 'out.csv')
      .expect(201);
    const task = detail(res.body);
    expect(task.taskYaml).toBe(`${TOTAL_DUE_YAML}self_check:\n  expected_workspace: expected\n`);
    expect(task.files.find((f) => f.path === 'expected/out.csv')).toMatchObject({
      kind: 'expected',
      visibility: 'hidden',
    });
    await s.http().post(`${base}/tasks/total_due/revert`).set(WRITE).expect(200);
  });

  it('refuses every write under verify/ (R7), but shows its source', async () => {
    const script = encodeURIComponent('verify/check.py');
    for (const target of [
      'verify/evil.py',
      'Verify/evil.py',
      './verify/evil.py',
      'fixtures/../verify/evil.py',
    ]) {
      await s
        .http()
        .patch(`${base}/tasks/total_due/files/${encodeURIComponent('fixtures/invoices.csv')}`)
        .set(WRITE)
        .send({ path: target })
        .expect(400);
    }
    await s
      .http()
      .patch(`${base}/tasks/summary_file/files/${script}`)
      .set(WRITE)
      .send({ path: 'fixtures/check.py' })
      .expect(400);
    await s.http().delete(`${base}/tasks/summary_file/files/${script}`).set(WRITE).expect(400);
    await s
      .http()
      .post(`${base}/tasks/summary_file/files`)
      .set(WRITE)
      .field('kind', 'fixture')
      .field('path', '../verify/evil.py')
      .attach('file', Buffer.from('x'), 'evil.py')
      .expect(400);
    await put('summary_file', { rubrics: [{ path: 'verify/rubric.md', text: 'x' }] }).expect(400);
    const source = await s
      .http()
      .get(`${base}/tasks/summary_file/files/${script}`)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect((source.body as Buffer).toString()).toBe(CHECK_PY);
  });

  it('refuses an unsafe path, a home path that is not a seed, and the text files', async () => {
    await s
      .http()
      .post(`${base}/tasks/total_due/files`)
      .set(WRITE)
      .field('kind', 'fixture')
      .field('path', '/etc/passwd')
      .attach('file', Buffer.from('x'), 'a')
      .expect(400);
    await s
      .http()
      .post(`${base}/tasks/total_due/files`)
      .set(WRITE)
      .field('kind', 'home_seed')
      .attach('file', Buffer.from('x'), 'notes.md')
      .expect(400);
    await s.http().delete(`${base}/tasks/total_due/files/prompt.md`).set(WRITE).expect(400);
    await s
      .http()
      .post(`${base}/tasks/total_due/files`)
      .set(WRITE)
      .field('kind', 'fixture')
      .expect(400);
  });

  it('adds a home seed where the agent finds it', async () => {
    const res = await s
      .http()
      .post(`${base}/tasks/total_due/files`)
      .set(WRITE)
      .field('kind', 'home_seed')
      .attach('file', Buffer.from('Prefers EUR.\n'), 'USER.md')
      .expect(201);
    expect(detail(res.body).files.find((f) => f.path === 'home/memories/USER.md')).toMatchObject({
      kind: 'home_seed',
      visibility: 'agent',
      agentPath: '~/memories/USER.md',
    });
    await s.http().post(`${base}/tasks/total_due/revert`).set(WRITE).expect(200);
  });
});
