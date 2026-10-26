/**
 * In live mode the suite authoring calls around the editor reach the endpoints of plan
 * section 11 and parse their answers with the shared schemas: the reload progress, a
 * version's download link, the zip and task imports (multipart), and a save whose refusals
 * the page draws (409, 422, 503) come back as outcomes. Runs the data layer with
 * VITE_API_MODE=live against a fetch stub.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuiteZipValidation } from '@/api/types/authoring';
import type { SuiteReloadProgress } from '@/api/types/suites';

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

let sent: Sent[] = [];
let status = 200;
let answer: unknown = {};

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
  status = 200;
  answer = {};
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = new URL(input, 'http://localhost');
    sent.push({
      method: init.method ?? 'GET',
      path: url.pathname,
      body:
        init.body instanceof FormData
          ? init.body
          : typeof init.body === 'string'
            ? JSON.parse(init.body)
            : undefined,
    });
    return new Response(JSON.stringify(answer), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
});

const suites = () => import('@/api/suites');
const authoring = () => import('@/api/suites-authoring');

const progress: SuiteReloadProgress = {
  active: true,
  startedAt: '2026-10-23T15:41:00.000Z',
  finishedAt: null,
  directories: [
    {
      sourcePath: './suites/invoices-v1',
      name: 'invoices-v1',
      state: 'loading',
      entry: null,
      error: null,
    },
  ],
};

describe('suite pages, live', () => {
  it('reads the progress of Reload all, and links a version download by folder', async () => {
    answer = progress;
    const { getReloadProgress, suiteVersionZipUrl, suiteVersionZipName } = await suites();
    expect(await getReloadProgress()).toEqual(progress);
    expect(sent[0]).toMatchObject({ method: 'GET', path: '/api/suites/reload/progress' });
    expect(suiteVersionZipUrl('invoices-v1', 6)).toBe('/api/suites/invoices-v1/versions/6/zip');
    expect(suiteVersionZipName('invoices-v1', 6)).toBe('invoices-v1-v6.zip');
  });

  it('refuses a progress answer that breaks its contract', async () => {
    answer = { ...progress, directories: [{ ...progress.directories[0], state: 'done' }] };
    const { getReloadProgress } = await suites();
    await expect(getReloadProgress()).rejects.toMatchObject({ kind: 'contract' });
  });
});

describe('authoring, live', () => {
  it('validates a suite zip as multipart, then imports it by token', async () => {
    const validation: SuiteZipValidation = {
      token: 'zip_1',
      fileName: 'vendor-statements-v1.zip',
      sizeBytes: 26_700,
      outcome: 'valid',
      suite: { name: 'vendor-statements-v1', versionLabel: '0.1', description: null },
      nameTaken: null,
      tasks: [],
      scripts: [
        {
          path: 'statement_total/verify/check.py',
          sizeBytes: 812,
          sha256: 'a'.repeat(64),
          runByCheck: true,
        },
      ],
      verifyCounts: { files: 1, checkScripts: 1 },
      rootFilesNotKept: [{ path: 'README.md', sizeBytes: 640 }],
      fileCount: 7,
      unpackedBytes: 26_700,
      problems: [],
    };
    answer = validation;
    const { validateSuiteZip } = await authoring();
    expect(await validateSuiteZip(new File(['x'], 'vendor-statements-v1.zip'))).toEqual(validation);
    expect(sent[0]!.path).toBe('/api/suites/import/validate');
    expect((sent[0]!.body as FormData).get('file')).toBeInstanceOf(File);
  });

  it('sends a task file with its settings as multipart', async () => {
    answer = {
      file: null,
      problems: [{ title: 'questions.xlsx: use CSV or JSONL.', detail: '' }],
      preview: null,
    };
    const { validateTaskImport } = await authoring();
    const result = await validateTaskImport('invoices-v1', new File(['x'], 'questions.xlsx'), null);
    expect(result.problems).toHaveLength(1);
    expect(sent[0]!.path).toBe('/api/suites/invoices-v1/draft/import/validate');
    expect((sent[0]!.body as FormData).has('settings')).toBe(false);
  });

  it('turns a save refused for want of a worker into an outcome', async () => {
    status = 503;
    answer = { statusCode: 503, message: 'No worker is running.' };
    const { saveSuiteDraft } = await authoring();
    expect(await saveSuiteDraft('invoices-v1', { revision: 3 })).toEqual({
      kind: 'no-worker',
      message: 'No worker is running.',
    });
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: '/api/suites/invoices-v1/draft/save',
      body: { revision: 3 },
    });
  });

  it("reads a save's 422: the step and the loader's located message", async () => {
    status = 422;
    answer = {
      statusCode: 422,
      message: 'overdue_count/task.yaml line 9: unknown key prmary',
      step: 'loading',
      error: {
        file: 'overdue_count/task.yaml',
        line: 9,
        column: 7,
        message: 'unknown key prmary',
        excerpt: [],
      },
    };
    const { saveSuiteDraft } = await authoring();
    expect(await saveSuiteDraft('invoices-v1', {})).toMatchObject({
      kind: 'failed',
      step: 'loading',
      message: 'overdue_count/task.yaml line 9: unknown key prmary',
    });
  });
});
