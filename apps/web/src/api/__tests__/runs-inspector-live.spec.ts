/**
 * The run inspector's data layer in live mode (VITE_API_MODE=live, fetch stubbed): each call
 * goes to its endpoint and parses the answer with its shared schema, so a response that
 * breaks the contract fails here with a `contract` ApiError; actions send X-Requested-With;
 * a text artifact is read as text, cut at the preview limit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunEventsQuerySchema } from '@hermes-evals/shared';
import { SAMPLE_RUN_ID } from '@/fixtures/experiments';
import { runDetailFixture, runEventsFixture } from '@/fixtures/inspector';
import { rescoreRunFixture } from '@/fixtures/runs';

interface Sent {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

let sent: Sent[] = [];
let answer: () => Response = () => json({});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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
  sent = [];
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    sent.push({
      method: init.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    return answer();
  });
});

const runs = () => import('@/api/runs');
const off = () => false;
const last = (): Sent => sent[sent.length - 1]!;

describe('reads', () => {
  it('GET /runs/:id parses the detail with RunDetailSchema', async () => {
    const detail = runDetailFixture(off, SAMPLE_RUN_ID)!;
    answer = () => json(detail);
    const run = await (await runs()).getRun(SAMPLE_RUN_ID);
    expect(last()).toMatchObject({ method: 'GET', path: `/api/runs/${SAMPLE_RUN_ID}` });
    expect(run.task.key).toBe('dup_invoices');
  });

  it('refuses a detail that breaks the contract', async () => {
    const detail = { ...runDetailFixture(off, SAMPLE_RUN_ID)!, status: 'finished' };
    answer = () => json(detail);
    await expect((await runs()).getRun(SAMPLE_RUN_ID)).rejects.toMatchObject({
      kind: 'contract',
      message: expect.stringContaining('the response does not match its contract (status:'),
    });
  });

  it('GET /runs/:id/attempts/:n/stderr parses the whole log with AttemptStderrSchema', async () => {
    const log = {
      runId: SAMPLE_RUN_ID,
      attempt: 2,
      text: 'a\nb\n',
      sizeBytes: 4,
      totalLines: 2,
      truncated: false,
    };
    answer = () => json(log);
    expect(await (await runs()).getAttemptStderr(SAMPLE_RUN_ID, 2)).toEqual(log);
    expect(last()).toMatchObject({
      method: 'GET',
      path: `/api/runs/${SAMPLE_RUN_ID}/attempts/2/stderr`,
    });
    // `truncated` must say whether the log is over ATTEMPT_STDERR_MAX_BYTES.
    answer = () => json({ ...log, truncated: true });
    await expect((await runs()).getAttemptStderr(SAMPLE_RUN_ID, 2)).rejects.toMatchObject({
      kind: 'contract',
    });
  });

  it('GET /runs/:id/events sends the cursor the API parses back', async () => {
    answer = () => json(runEventsFixture(off, SAMPLE_RUN_ID, 3));
    const page = await (await runs()).listRunEvents(SAMPLE_RUN_ID, 3);
    expect(last().path).toBe(`/api/runs/${SAMPLE_RUN_ID}/events`);
    expect(RunEventsQuerySchema.parse(last().query)).toEqual({ after: 3 });
    expect(page.events[0]!.seq).toBe(4);
    await (await runs()).listRunEvents(SAMPLE_RUN_ID);
    expect(RunEventsQuerySchema.parse(last().query)).toEqual({ after: 0 });
  });

  it('GET …/preview answers a table or null', async () => {
    answer = () => json(null);
    expect(await (await runs()).getArtifactPreview(SAMPLE_RUN_ID, 'art_1')).toBeNull();
    expect(last().path).toBe(`/api/runs/${SAMPLE_RUN_ID}/artifacts/art_1/preview`);
    answer = () => json({ columns: ['a'], rows: [['1']], totalRows: 4 });
    expect(await (await runs()).getArtifactPreview(SAMPLE_RUN_ID, 'art_1')).toEqual({
      columns: ['a'],
      rows: [['1']],
      totalRows: 4,
    });
  });

  it('reads a text artifact as text and stops at the preview limit', async () => {
    answer = () => new Response('x'.repeat(100), { status: 200 });
    const { getArtifactText } = await runs();
    expect(await getArtifactText(SAMPLE_RUN_ID, 'art_txt', 40)).toEqual({
      text: 'x'.repeat(40),
      truncated: true,
    });
    expect(last().path).toBe(`/api/runs/${SAMPLE_RUN_ID}/artifacts/art_txt/content`);
    answer = () => new Response('short\n', { status: 200 });
    expect(await getArtifactText(SAMPLE_RUN_ID, 'art_txt')).toEqual({
      text: 'short\n',
      truncated: false,
    });
  });

  it("quotes the API's message when the artifact cannot be read", async () => {
    answer = () => json({ statusCode: 404, message: 'artifact art_txt not found' }, 404);
    await expect((await runs()).getArtifactText(SAMPLE_RUN_ID, 'art_txt')).rejects.toMatchObject({
      status: 404,
      message: `GET /api/runs/${SAMPLE_RUN_ID}/artifacts/art_txt/content → 404 · artifact art_txt not found`,
    });
  });
});

describe('actions', () => {
  it('POST rescore, retry and cancel with X-Requested-With, parsed with their schemas', async () => {
    const { rescoreRun, retryRun, cancelRun } = await runs();
    answer = () => json(rescoreRunFixture(SAMPLE_RUN_ID));
    const rescored = await rescoreRun(SAMPLE_RUN_ID);
    expect(rescored.evaluation.cause).toBe('rescore');
    expect(last()).toMatchObject({ method: 'POST', path: `/api/runs/${SAMPLE_RUN_ID}/rescore` });
    expect(last().headers['x-requested-with']).toBe('hermes-evals');

    answer = () => json({ runId: SAMPLE_RUN_ID, status: 'queued', attempt: 2 });
    expect((await retryRun(SAMPLE_RUN_ID)).attempt).toBe(2);
    expect(last().path).toBe(`/api/runs/${SAMPLE_RUN_ID}/retry`);

    answer = () => json({ runId: SAMPLE_RUN_ID, status: 'running', attempt: null });
    expect((await cancelRun(SAMPLE_RUN_ID)).status).toBe('running');
    expect(last().path).toBe(`/api/runs/${SAMPLE_RUN_ID}/cancel`);
    expect(last().headers['x-requested-with']).toBe('hermes-evals');
  });

  it('passes on a 409 with its sentence', async () => {
    answer = () =>
      json(
        {
          statusCode: 409,
          message: 'Re-score needs Nous Portal for the method judge: Nous Portal is not connected.',
        },
        409,
      );
    await expect((await runs()).rescoreRun(SAMPLE_RUN_ID)).rejects.toMatchObject({
      status: 409,
      detail: 'Re-score needs Nous Portal for the method judge: Nous Portal is not connected.',
    });
  });
});
