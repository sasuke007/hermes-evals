/**
 * GET /runs/:id/attempts/:n/stderr (Phase 7) on PGlite: the log the worker
 * stored when the attempt ended, found through its collected event, and the
 * 404s for every attempt without one. Answers parse with AttemptStderrSchema.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ATTEMPT_STDERR_MAX_BYTES, AttemptStderrSchema } from '@hermes-evals/shared';
import { createTestDatabase, type TestDatabase } from '../../../test/support/database.js';
import { viewsConfig } from './run-fixtures-spec.js';
import { RunViewsService } from './run-views.service.js';
import { seedRunStates, type SeededRunStates } from './runs-seed-spec.js';
import { attemptStderrView, lineCount, stderrLogRefOf } from './stderr-log.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let s: SeededRunStates;
let views: RunViewsService;
const LOG = 'hermes: starting\nkey <from env API_KEY>\nhermes: exit 1\n';

const collected = (extra: Record<string, unknown>) => ({
  seq: 1,
  ts: Date.parse('2026-10-26T12:00:00.000Z'),
  type: 'platform' as const,
  payload: {
    type: 'platform',
    subtype: 'collected',
    stored: 0,
    stderr_lines: 3,
    ...extra,
  } as never,
});

beforeAll(async () => {
  t = await createTestDatabase();
  s = await seedRunStates(t.db);
  views = new RunViewsService(t.db, s.store, viewsConfig());
  const blob = await s.store.putBuffer(Buffer.from(LOG));

  // Attempt 1 failed with its log stored; attempt 2 ended before Phase 7 (no stderr_log).
  const first = await s.start('dup_invoices/baseline/1', 1, new Date('2026-10-26T12:00:00Z'));
  await s.addEvents(first, [
    collected({ stderr_log: { sha256: blob.sha256, bytes: Buffer.byteLength(LOG) } }),
  ]);
  await s.end('dup_invoices/baseline/1', first, { status: 'execution_error', category: 'other' });
  await s.requeue('dup_invoices/baseline/1');
  const second = await s.start('dup_invoices/baseline/1', 2, new Date('2026-10-26T12:10:00Z'));
  await s.addEvents(second, [collected({})]);
  await s.end('dup_invoices/baseline/1', second, { status: 'execution_error', category: 'other' });

  // A log stored past the bound, and one whose blob is gone.
  const long = await s.start('dup_invoices/baseline/2', 1, new Date('2026-10-26T12:00:00Z'));
  const end = await s.store.putBuffer(Buffer.from('the end\n'));
  await s.addEvents(long, [
    collected({
      stderr_log: { sha256: end.sha256, bytes: ATTEMPT_STDERR_MAX_BYTES + 10 },
      stderr_lines: 90_000,
    }),
  ]);
  await s.end('dup_invoices/baseline/2', long, { status: 'execution_error', category: 'other' });
  const lost = await s.start('dup_invoices/baseline/3', 1, new Date('2026-10-26T12:00:00Z'));
  await s.addEvents(lost, [collected({ stderr_log: { sha256: 'a'.repeat(64), bytes: 10 } })]);
  await s.end('dup_invoices/baseline/3', lost, { status: 'execution_error', category: 'other' });

  // Still running: no collected event yet.
  await s.start('dup_invoices/baseline/4', 1, new Date());
});

afterAll(async () => {
  await t.close();
  await s.dispose();
});

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (err: { getStatus?: () => number }) => err.getStatus?.() ?? 0,
  );

describe('GET /runs/:id/attempts/:n/stderr', () => {
  it('answers the stored log of an attempt, any attempt of the run', async () => {
    const answer = AttemptStderrSchema.parse(
      await views.stderr(s.cell('dup_invoices/baseline/1'), 1),
    );
    expect(answer).toEqual({
      runId: s.cell('dup_invoices/baseline/1'),
      attempt: 1,
      text: LOG,
      sizeBytes: Buffer.byteLength(LOG),
      totalLines: 3,
      truncated: false,
    });
  });

  it('says when the text is only the end of a longer log', async () => {
    const answer = AttemptStderrSchema.parse(
      await views.stderr(s.cell('dup_invoices/baseline/2'), 1),
    );
    expect(answer).toMatchObject({ text: 'the end\n', totalLines: 90_000, truncated: true });
  });

  it('answers 404 for a missing run or attempt, a running one and one stored before Phase 7', async () => {
    expect(await status(views.stderr('01NOSUCHRUN000000000000000', 1))).toBe(404);
    expect(await status(views.stderr(s.cell('dup_invoices/baseline/1'), 3))).toBe(404);
    expect(await status(views.stderr(s.cell('dup_invoices/baseline/1'), 2))).toBe(404);
    expect(await status(views.stderr(s.cell('dup_invoices/baseline/4'), 1))).toBe(404);
    await expect(views.stderr(s.cell('dup_invoices/baseline/1'), 2)).rejects.toThrow(
      'stderr.log of attempt 2 not found',
    );
  });

  it('answers 500 when the stored blob is gone', async () => {
    expect(await status(views.stderr(s.cell('dup_invoices/baseline/3'), 1))).toBe(500);
  });
});

describe('the stored log reference', () => {
  it('reads only a well-formed stderr_log', () => {
    const sha256 = 'b'.repeat(64);
    expect(stderrLogRefOf({ stderr_log: { sha256, bytes: 5 }, stderr_lines: 1 })).toEqual({
      sha256,
      bytes: 5,
      lines: 1,
    });
    expect(stderrLogRefOf({ stderr_log: { sha256, bytes: 5 } })).toEqual({
      sha256,
      bytes: 5,
      lines: null,
    });
    for (const bad of [
      null,
      {},
      { stderr_log: null },
      { stderr_log: { sha256: '../etc/passwd', bytes: 5 } },
      { stderr_log: { sha256, bytes: -1 } },
      { stderr_log: { sha256, bytes: 1.5 } },
    ]) {
      expect(stderrLogRefOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('counts lines as the worker does, and falls back on the text when no count was recorded', () => {
    expect([lineCount(''), lineCount('a'), lineCount('a\n'), lineCount('a\nb')]).toEqual([
      0, 1, 1, 2,
    ]);
    const view = attemptStderrView({
      runId: 'r',
      attempt: 1,
      text: 'a\nb\n',
      ref: { sha256: 'c'.repeat(64), bytes: 4, lines: null },
    });
    expect(AttemptStderrSchema.parse(view)).toMatchObject({ totalLines: 2, truncated: false });
  });
});
