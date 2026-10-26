/**
 * The Phase 5b e2e's helpers: the authoring routes called as the web app
 * calls them (JSON with X-Requested-With, multipart uploads, downloads), each
 * answer parsed with its shared schema; a folder's files by hash, to prove a
 * save touched nothing; a zip read into memory; and the Flow E suite, written
 * through the draft API from nothing.
 *
 * The Flow E tasks are answered by the fake trials of fake-trials.ts, which
 * tell tasks apart by the files their prompt names: `total` names
 * amounts.csv, `vendor_summary` names summary.csv.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { expect } from 'vitest';
import { fromBuffer, type Entry, type ZipFile } from 'yauzl';
import type { ZodType } from 'zod';
import {
  answerInstructions,
  ApiErrorBodySchema,
  appendParagraph,
  DraftSaveResultSchema,
  DraftTaskCreateResultSchema,
  DraftTaskDetailSchema,
  SuiteDraftViewSchema,
  type ApiErrorBody,
  type DraftSaveResult,
  type DraftTaskDetail,
  type SuiteDraftView,
  type TaskForm,
} from '@hermes-evals/shared';

/** The CSRF guard's header, as the web app sends it. */
export const WRITE = { 'X-Requested-With': 'hermes-evals' } as const;

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface UploadPart {
  field: string;
  name: string;
  bytes: Buffer | string;
}

export class AuthoringClient {
  constructor(private readonly app: () => NestExpressApplication) {}

  private http() {
    return request(this.app().getHttpServer());
  }

  /** A JSON call whose answer has `status` and parses with `schema`. */
  async json<T>(
    method: Method,
    path: string,
    body: unknown,
    status: number,
    schema: ZodType<T>,
  ): Promise<T> {
    const call = this.http()[method](`/api${path}`);
    const res = method === 'get' ? await call : await call.set(WRITE).send((body ?? {}) as object);
    expect(res.status, `${method.toUpperCase()} ${path}: ${JSON.stringify(res.body)}`).toBe(status);
    return schema.parse(res.body);
  }

  get<T>(path: string, schema: ZodType<T>): Promise<T> {
    return this.json('get', path, undefined, 200, schema);
  }

  /** A call refused with `status` and the shared error body. */
  refused(method: Method, path: string, body: unknown, status: number): Promise<ApiErrorBody> {
    return this.json(method, path, body, status, ApiErrorBodySchema);
  }

  /** A call that answers 204 with no body. */
  async noContent(method: 'delete' | 'post', path: string): Promise<void> {
    const res = await this.http()[method](`/api${path}`).set(WRITE).send({});
    expect(res.status, `${method.toUpperCase()} ${path}: ${JSON.stringify(res.body)}`).toBe(204);
    expect(res.text).toBe('');
  }

  /** A multipart POST: text fields, then the files. */
  async upload<T>(
    path: string,
    fields: Readonly<Record<string, string>>,
    files: readonly UploadPart[],
    status: number,
    schema: ZodType<T>,
  ): Promise<T> {
    let call = this.http().post(`/api${path}`).set(WRITE);
    for (const [name, value] of Object.entries(fields)) call = call.field(name, value);
    for (const file of files) call = call.attach(file.field, Buffer.from(file.bytes), file.name);
    const res = await call;
    expect(res.status, `POST ${path}: ${JSON.stringify(res.body)}`).toBe(status);
    return schema.parse(res.body);
  }

  /** POST /suites/:suite/draft: a draft of the folder's current version (201), or the open one (200). */
  openDraft(folder: string, status = 201): Promise<SuiteDraftView> {
    return this.json('post', `/suites/${folder}/draft`, {}, status, SuiteDraftViewSchema);
  }

  /** POST …/draft/save, answered 200. */
  saveDraft(folder: string, body: object = {}): Promise<DraftSaveResult> {
    return this.json('post', `/suites/${folder}/draft/save`, body, 200, DraftSaveResultSchema);
  }

  task(folder: string, key: string): Promise<DraftTaskDetail> {
    return this.get(`/suites/${folder}/draft/tasks/${key}`, DraftTaskDetailSchema);
  }

  editTask(folder: string, key: string, body: object): Promise<DraftTaskDetail> {
    const path = `/suites/${folder}/draft/tasks/${key}`;
    return this.json('put', path, body, 200, DraftTaskDetailSchema);
  }

  /** One file into the task folder, as the drop zone sends it. */
  uploadFile(
    folder: string,
    key: string,
    kind: string,
    file: { name: string; text: string },
  ): Promise<DraftTaskDetail> {
    const path = `/suites/${folder}/draft/tasks/${key}/files`;
    const part = { field: 'file', name: file.name, bytes: file.text };
    return this.upload(path, { kind }, [part], 201, DraftTaskDetailSchema);
  }

  /** A blank task filled in through the Form tab, the prompt and reference editors, and uploads. */
  async writeTask(folder: string, spec: FlowETask): Promise<DraftTaskDetail> {
    const created = await this.json(
      'post',
      `/suites/${folder}/draft/tasks`,
      { kind: 'blank', key: spec.key },
      201,
      DraftTaskCreateResultSchema,
    );
    expect(created.keys).toEqual([spec.key]);
    const texts = { form: spec.form, prompt: spec.prompt, reference: spec.reference };
    await this.editTask(folder, spec.key, texts);
    let latest = await this.uploadFile(folder, spec.key, 'fixture', spec.fixture);
    if (spec.expected) latest = await this.uploadFile(folder, spec.key, 'expected', spec.expected);
    return latest;
  }

  /** A download: its headers and bytes. */
  async download(path: string): Promise<{ headers: Record<string, string>; bytes: Buffer }> {
    const res = await this.http()
      .get(`/api${path}`)
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(res.status, `GET ${path}`).toBe(200);
    return { headers: res.headers as Record<string, string>, bytes: res.body as Buffer };
  }
}

export const sha256 = (bytes: Buffer | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Every file under `dir` (dot names included), by relative path, with its bytes. */
export async function readTree(dir: string): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out.set(full.slice(dir.length + 1), await readFile(full));
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

/** Every file under `dir` by relative path, with its sha256. */
export async function snapshot(dir: string): Promise<Record<string, string>> {
  const tree = await readTree(dir);
  return Object.fromEntries([...tree].map(([path, bytes]) => [path, sha256(bytes)]));
}

/** A zip's files, by entry name. */
export async function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  const zip = await new Promise<ZipFile>((ok, fail) =>
    fromBuffer(bytes, { lazyEntries: true }, (err, z) => (err ? fail(err) : ok(z))),
  );
  const out = new Map<string, Buffer>();
  await new Promise<void>((ok, fail) => {
    zip.on('entry', (entry: Entry) => {
      if (entry.fileName.endsWith('/')) return zip.readEntry();
      zip.openReadStream(entry, (err, stream) => {
        if (err) return fail(err);
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          out.set(entry.fileName, Buffer.concat(chunks));
          zip.readEntry();
        });
        stream.on('error', fail);
      });
    });
    zip.on('end', ok);
    zip.on('error', fail);
    zip.readEntry();
  });
  return out;
}

// ---------------------------------------------------------------------------
// The Flow E suite, written through the draft API
// ---------------------------------------------------------------------------

export const FLOW_E = 'zz-smoke-flow-e';

/** A Flow E task as the editor fills it in. */
export interface FlowETask {
  key: string;
  form: TaskForm;
  prompt: string;
  reference: string;
  fixture: { name: string; text: string };
  /** The expected workspace's file, for a file check. */
  expected?: { name: string; text: string };
}

/** A form with the limits and answer block every Flow E task shares. */
const form = (overrides: Partial<TaskForm>): TaskForm => ({
  summary: '',
  maxTurns: 10,
  runBudgetSeconds: 120,
  toolsetsNeeded: ['file'],
  answerPath: null,
  checks: [],
  expectedWorkspace: null,
  expectedHome: null,
  negativeControl: null,
  ...overrides,
});

/** An answer check: the sum of a CSV column (fake-trials.ts answers it without a skill as 10.0). */
export const TOTAL: FlowETask = {
  key: 'total',
  form: form({
    summary: 'Sum the amounts',
    answerPath: 'total',
    checks: [{ key: 'answer', type: 'numeric_tolerance', primary: true, params: { abs: 0.01 } }],
  }),
  prompt: appendParagraph(
    'Add up the `amount` column of `amounts.csv`.',
    answerInstructions('total', { total: 10.5 }),
  ),
  reference: '{ "total": 10.5 }\n',
  fixture: { name: 'amounts.csv', text: 'id,amount\n1,4.25\n2,6.25\n' },
};

/** A file check with an expected workspace, which only the worker can self-check. */
export const VENDOR_SUMMARY: FlowETask = {
  key: 'vendor_summary',
  form: form({
    summary: 'Write summary.csv with one row per vendor',
    toolsetsNeeded: ['file', 'terminal'],
    checks: [
      {
        key: 'summary_csv',
        type: 'file_check',
        primary: true,
        params: { path: 'summary.csv', format: 'csv', columns: ['vendor', 'total'], row_count: 2 },
      },
    ],
  }),
  prompt: appendParagraph(
    'Read `invoices.csv` and write `summary.csv` with columns vendor,total, one row per vendor.',
    answerInstructions(null, { done: true }),
  ),
  reference: '{ "done": true }\n',
  fixture: { name: 'invoices.csv', text: 'vendor,amount\nAcme,10\nAcme,5\nGlobex,7\n' },
  expected: { name: 'summary.csv', text: 'vendor,total\nAcme,15\nGlobex,7\n' },
};

/** Tasks from a CSV (SA.9): keys, prompts and the value at the answer path. */
export const QUESTIONS_CSV =
  'key,question,answer\n' +
  'sum_twice,"Add up the `amount` column of `amounts.csv`, then double it.",21\n' +
  'sum_half,"Add up the `amount` column of `amounts.csv`, then halve it.",5.25\n';
