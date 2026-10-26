/**
 * Uploads refused for their size (Phase 5b question 11, settled for Phase
 * 7) over HTTP: the 413 is answered as before, and the refusal is kept on
 * the task, so readiness reports it ("`ledger-2025.parquet` is over 25 MB.")
 * after a reload, until a file is stored at its path, the path is deleted or
 * the task is reverted. The review does not count it as a task the loader
 * would store invalid: no file is left behind.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTHORING_LIMITS,
  DraftReviewSchema,
  DraftTaskDetailSchema,
  type DraftTaskDetail,
} from '@hermes-evals/shared';
import { startDraftsApp, WRITE, type DraftsApp } from './drafts-testing.helper-spec.js';

let s: DraftsApp;
const base = '/api/suites/invoices-v1/draft';
const files = `${base}/tasks/total_due/files`;
const OVER = Buffer.alloc(AUTHORING_LIMITS.suiteMaxFileBytes + 1, 1);

beforeAll(async () => {
  s = await startDraftsApp();
  await s.http().post(base).set(WRITE).expect(201);
}, 120_000);

afterAll(async () => {
  await s?.close();
});

const task = async (): Promise<DraftTaskDetail> =>
  DraftTaskDetailSchema.parse((await s.http().get(`${base}/tasks/total_due`).expect(200)).body);

const fileLimits = (detail: DraftTaskDetail) => ({
  row: detail.readiness.rules.find((r) => r.rule === 'file_limits')!,
  issues: detail.readiness.issues.filter((i) => i.rule === 'file_limits'),
});

describe('an upload refused for its size', () => {
  it('answers 413 and is reported by readiness until its path holds a file or is deleted', async () => {
    const refused = await s
      .http()
      .post(files)
      .set(WRITE)
      .field('kind', 'fixture')
      .field('path', 'ledger-2025.parquet')
      .attach('file', OVER, 'ledger-2025.parquet')
      .expect(413);
    expect(refused.body).toEqual({ statusCode: 413, message: 'the file is larger than 25 MB' });

    // A reload reads it from the task: the board's words, its Fix on the file's path.
    const reloaded = await task();
    expect(fileLimits(reloaded)).toEqual({
      row: {
        rule: 'file_limits',
        status: 'problem',
        message: '`ledger-2025.parquet` is over 25 MB.',
        target: { section: 'workspace', field: 'fixtures/ledger-2025.parquet' },
      },
      issues: [
        {
          rule: 'file_limits',
          severity: 'problem',
          target: { section: 'workspace', field: 'fixtures/ledger-2025.parquet' },
          message: '`ledger-2025.parquet` is over 25 MB.',
        },
      ],
    });
    expect(reloaded.readiness.summary).toBe('problems');
    expect(reloaded.files.map((f) => f.path)).not.toContain('fixtures/ledger-2025.parquet');
    // No file is left behind, so the loader would not store the task invalid.
    const review = DraftReviewSchema.parse((await s.http().get(`${base}/review`).expect(200)).body);
    expect(review.invalid.map((t) => t.key)).not.toContain('total_due');

    // Without a path, the file's own name places it; a second refusal is listed beside the first.
    await s
      .http()
      .post(files)
      .set(WRITE)
      .field('kind', 'fixture')
      .attach('file', OVER, 'dump.bin')
      .expect(413);
    expect(fileLimits(await task()).issues.map((i) => i.target.field)).toEqual([
      'fixtures/dump.bin',
      'fixtures/ledger-2025.parquet',
    ]);

    // Deleting the path dismisses it; a file stored at the other path replaces it.
    const path = encodeURIComponent('fixtures/ledger-2025.parquet');
    await s.http().delete(`${files}/${path}`).set(WRITE).expect(200);
    expect(fileLimits(await task()).issues.map((i) => i.target.field)).toEqual([
      'fixtures/dump.bin',
    ]);
    await s
      .http()
      .post(files)
      .set(WRITE)
      .field('kind', 'fixture')
      .attach('file', Buffer.from('small now\n'), 'dump.bin')
      .expect(201);
    const after = await task();
    expect(fileLimits(after)).toMatchObject({ row: { status: 'passed' }, issues: [] });
    await s.http().delete(`${files}/${path}`).set(WRITE).expect(404);
    await s.http().post(`${base}/tasks/total_due/revert`).set(WRITE).expect(200);
  });

  it('is dismissed by a revert of the task', async () => {
    await s
      .http()
      .post(files)
      .set(WRITE)
      .field('kind', 'expected')
      .field('path', 'summary.csv')
      .attach('file', OVER, 'summary.csv')
      .expect(413);
    expect(fileLimits(await task()).row).toMatchObject({
      status: 'problem',
      target: { section: 'expected', field: 'expected/summary.csv' },
    });
    await s.http().post(`${base}/tasks/total_due/revert`).set(WRITE).expect(200);
    expect(fileLimits(await task()).row.status).toBe('passed');
  });

  it('answers the same 413 unrecorded when the request cannot place it', async () => {
    // No kind, a path under verify/ (R7), a task the draft does not hold.
    await s.http().post(files).set(WRITE).attach('file', OVER, 'nokind.bin').expect(413);
    await s
      .http()
      .post(files)
      .set(WRITE)
      .field('kind', 'fixture')
      .field('path', '../verify/check.py')
      .attach('file', OVER, 'check.py')
      .expect(413);
    await s
      .http()
      .post(`${base}/tasks/no_such_task/files`)
      .set(WRITE)
      .field('kind', 'fixture')
      .attach('file', OVER, 'ghost.bin')
      .expect(413);
    expect(fileLimits(await task()).issues).toEqual([]);
  });
});
