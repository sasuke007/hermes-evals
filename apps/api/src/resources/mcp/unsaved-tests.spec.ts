/** The passing results of unsaved forms kept for their save (Phase 5 question 14). */
import { describe, expect, it } from 'vitest';
import { passedRecordOf, UnsavedMcpTests } from './unsaved-tests.js';

const view = {
  status: 'passed' as const,
  definitionHash: 'a'.repeat(64),
  requestedAt: '2026-10-26T10:00:00.000Z',
  finishedAt: '2026-10-26T10:00:02.000Z',
  startedMs: 1171,
  tools: [
    { name: 'list_invoices', description: 'List invoices', included: true },
    { name: 'delete_invoice', description: null, included: false },
  ],
};

describe('passedRecordOf', () => {
  it('writes the record a worker would have stored, without the view-only fields', () => {
    expect(passedRecordOf(view, 'job-1')).toEqual({
      status: 'passed',
      job_id: 'job-1',
      requested_at: '2026-10-26T10:00:00.000Z',
      finished_at: '2026-10-26T10:00:02.000Z',
      started_ms: 1171,
      tools: [{ name: 'list_invoices', description: 'List invoices' }, { name: 'delete_invoice' }],
    });
  });
});

describe('UnsavedMcpTests', () => {
  it('answers by definition hash, the newest result winning', () => {
    const kept = new UnsavedMcpTests();
    kept.remember('h1', passedRecordOf(view, 'job-1'));
    kept.remember('h1', passedRecordOf(view, 'job-2'));
    expect(kept.passedFor('h1')).toMatchObject({ job_id: 'job-2' });
    expect(kept.passedFor('h2')).toBeNull();
  });

  it('forgets a result after a day', () => {
    let now = 0;
    const kept = new UnsavedMcpTests();
    kept.now = () => now;
    kept.remember('h1', passedRecordOf(view, 'job-1'));
    now = 24 * 60 * 60 * 1000;
    expect(kept.passedFor('h1')).not.toBeNull();
    now += 1;
    expect(kept.passedFor('h1')).toBeNull();
  });

  it('keeps at most 200 results, dropping the oldest first', () => {
    const kept = new UnsavedMcpTests();
    for (let i = 0; i <= 200; i++) kept.remember(`h${i}`, passedRecordOf(view, `job-${i}`));
    expect(kept.passedFor('h0')).toBeNull();
    expect(kept.passedFor('h1')).not.toBeNull();
    expect(kept.passedFor('h200')).not.toBeNull();
  });
});
