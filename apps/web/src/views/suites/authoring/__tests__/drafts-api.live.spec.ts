/**
 * In live mode the draft data layer calls the routes of plan section 11 (contracts in
 * packages/shared/src/contracts/drafts.ts and draft-tasks.ts) and parses every answer with
 * its shared schema; Save reads its designed 409 and 422 bodies. Runs src/api/drafts.ts with
 * VITE_API_MODE=live against a fetch stub that answers with the fixture world's views.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateDraftTaskRequestSchema } from '@hermes-evals/shared';
import { draftView, taskDetailView } from '@/api/drafts-fixture-views';
import { draftWorld, resetDraftFixtures } from '@/api/drafts-fixtures';
import { setScenario } from '@/api/__tests__/scenario';

interface Sent {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

let sent: Sent[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(() => {
  vi.stubEnv('VITE_API_MODE', 'live');
  vi.resetModules();
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

beforeEach(() => {
  setScenario(null);
  resetDraftFixtures();
  sent = [];
  answer = { status: 200, body: {} };
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    sent.push({
      method: init.method ?? 'GET',
      path: new URL(input, 'http://localhost').pathname,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    });
  });
});

const drafts = () => import('@/api/drafts');
const sample = () => draftWorld().get('invoices-v1')!;
const view = () => draftView(sample());
const task = (key: string) =>
  taskDetailView(
    sample(),
    sample().tasks.find((t) => t.key === key)!,
  );

describe('draft routes in live mode', () => {
  it('reads a draft by folder and parses it', async () => {
    answer.body = view();
    const result = await (await drafts()).getSuiteDraft('invoices-v1');
    expect(sent[0]).toMatchObject({ method: 'GET', path: '/api/suites/invoices-v1/draft' });
    expect(result.folder).toBe('invoices-v1');
  });

  it('autosaves a task with PUT, the header the API requires, and a body the contract accepts', async () => {
    answer.body = task('overdue_count');
    const form = task('overdue_count').form!;
    await (await drafts()).updateDraftTask('invoices-v1', 'overdue_count', { form, revision: 3 });
    expect(sent[0]).toMatchObject({
      method: 'PUT',
      path: '/api/suites/invoices-v1/draft/tasks/overdue_count',
    });
    expect(sent[0]!.headers['x-requested-with']).toBe('hermes-evals');
    expect(UpdateDraftTaskRequestSchema.safeParse(sent[0]!.body).success).toBe(true);
  });

  it('encodes a file path as one segment', async () => {
    answer.body = task('overdue_count');
    await (
      await drafts()
    ).deleteDraftFile('invoices-v1', 'overdue_count', 'fixtures/docs/terms.pdf');
    expect(sent[0]!.path).toBe(
      '/api/suites/invoices-v1/draft/tasks/overdue_count/files/fixtures%2Fdocs%2Fterms.pdf',
    );
  });

  it('sends Try it and the self-check to their routes', async () => {
    const api = await drafts();
    answer.body = {
      key: 'answer',
      type: 'numeric_tolerance',
      against: 'reference',
      extraction: null,
      path: 'overdue_count',
      value: '17',
      status: 'passed',
      score: 1,
      comment: '|17 − 17| = 0 ≤ 0',
      passAt: null,
      evidence: null,
    };
    await api.tryDraftCheck('invoices-v1', 'overdue_count', { key: 'answer', reply: null });
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: '/api/suites/invoices-v1/draft/tasks/overdue_count/try',
      body: { key: 'answer', reply: null },
    });
    answer = { status: 503, body: { statusCode: 503, message: 'no worker is running' } };
    await expect(api.runDraftSelfCheck('invoices-v1', 'summary_file')).rejects.toMatchObject({
      status: 503,
      detail: 'no worker is running',
    });
  });

  it('refuses an answer that breaks its contract', async () => {
    answer.body = { folder: 'invoices-v1' };
    await expect((await drafts()).getSuiteDraft('invoices-v1')).rejects.toMatchObject({
      kind: 'contract',
    });
  });
});

describe('Save in live mode', () => {
  it('answers the new version', async () => {
    answer.body = {
      outcome: 'created',
      suite: {
        suiteId: 's7',
        name: 'invoices-v1',
        versionNumber: 2,
        versionLabel: '0.2',
        contentHash: 'a'.repeat(64),
      },
      changes: {
        added: ['overdue_count'],
        removed: [],
        changed: ['total_due'],
        nowInvalid: [],
        nowValid: [],
      },
      taskCount: 13,
      validCount: 13,
      invalid: [],
    };
    const outcome = await (await drafts()).saveSuiteDraft('invoices-v1', { versionLabel: '0.2' });
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: '/api/suites/invoices-v1/draft/save',
      body: { versionLabel: '0.2' },
    });
    expect(outcome.kind).toBe('saved');
  });

  it('reads the 409 conflict and the 422 loader failure as outcomes', async () => {
    setScenario('draft-conflict');
    resetDraftFixtures();
    const conflict = view().conflict!;
    answer = { status: 409, body: { statusCode: 409, message: 'changed on disk', conflict } };
    const api = await drafts();
    expect(await api.saveSuiteDraft('invoices-v1', {})).toMatchObject({
      kind: 'conflict',
      body: { conflict: { cause: 'version_moved' } },
    });
    answer = {
      status: 422,
      body: {
        statusCode: 422,
        message: 'not saved',
        step: 'loading',
        error: {
          file: 'overdue_count/task.yaml',
          line: 9,
          column: 7,
          message: 'unknown key prmary',
          excerpt: [],
        },
      },
    };
    expect(await api.saveSuiteDraft('invoices-v1', {})).toMatchObject({
      kind: 'not_saved',
      body: { step: 'loading' },
    });
  });

  it('throws any other failure with the API sentence', async () => {
    answer = {
      status: 503,
      body: { statusCode: 503, message: 'Saving needs the worker. Your draft is kept.' },
    };
    await expect((await drafts()).saveSuiteDraft('invoices-v1', {})).rejects.toMatchObject({
      status: 503,
      detail: 'Saving needs the worker. Your draft is kept.',
    });
  });
});
