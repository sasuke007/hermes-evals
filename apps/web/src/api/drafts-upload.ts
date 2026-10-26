/**
 * Two calls of the draft data layer that client.ts's apiSend cannot make: a file upload
 * with its progress (FileDropZone's thin bar, "9.1 of 22.6 KB"), which fetch does not
 * report, and a request whose designed failures carry a body to read (Save's 409 conflict
 * and 422 loader error). Both send X-Requested-With (plan 6.1), parse every answer with its
 * shared schema, and fail with an ApiError worded as client.ts words it.
 */
import { ApiErrorBodySchema, DraftTaskDetailSchema } from '@hermes-evals/shared';
import type { ZodType } from 'zod';
import type { DraftFileUploadFields, DraftTaskDetail } from './types/authoring';
import { API_BASE, ApiError, REQUESTED_WITH, errorMessage } from './client';
import { apiMode, FIXTURE_LATENCY_MS, fixture, fixtureWorld } from './source';

const describe = (method: string, path: string) => `${method} ${API_BASE}${path.split('?')[0]}`;

function contractError(
  request: string,
  status: number,
  schema: ZodType,
  value: unknown,
): ApiError | null {
  const parsed = schema.safeParse(value);
  if (parsed.success) return null;
  const issues = parsed.error.issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
  }));
  const first = issues[0];
  const where = first ? `${first.path || '(root)'}: ${first.message}` : 'unknown';
  return new ApiError(
    status,
    request,
    `the response does not match its contract (${where})`,
    issues,
    'contract',
  );
}

function bodyOf(text: string): unknown {
  try {
    return text ? (JSON.parse(text) as unknown) : null;
  } catch {
    return null;
  }
}

/** The ApiError of a failed answer: the API's `{ statusCode, message, issues? }`, else the raw text. */
function httpError(request: string, status: number, statusText: string, text: string): ApiError {
  const parsed = ApiErrorBodySchema.safeParse(bodyOf(text));
  if (parsed.success)
    return new ApiError(status, request, parsed.data.message, parsed.data.issues ?? []);
  return new ApiError(
    status,
    request,
    text.trim().slice(0, 300) || statusText || 'no response body',
  );
}

export type FailureAnswer<T> =
  { ok: true; value: T } | { ok: false; status: number; body: unknown };

/**
 * A JSON request whose listed failure statuses come back with their parsed body instead of
 * being thrown; every other failure throws as apiSend would.
 */
export async function sendWithFailures<T>(
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  body: unknown,
  schema: ZodType<T>,
  failures: Record<number, ZodType>,
): Promise<FailureAnswer<T>> {
  const request = describe(method, path);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-requested-with': REQUESTED_WITH,
      },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    throw new ApiError(0, request, errorMessage(err), [], 'network');
  }
  const text = await res.text().catch(() => '');
  const failure = failures[res.status];
  if (!res.ok && failure) {
    const value = bodyOf(text);
    const broken = contractError(request, res.status, failure, value);
    if (broken) throw broken;
    return { ok: false, status: res.status, body: value };
  }
  if (!res.ok) throw httpError(request, res.status, res.statusText, text);
  const value = bodyOf(text);
  const broken = contractError(request, res.status, schema, value);
  if (broken) throw broken;
  return { ok: true, value: value as T };
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface UploadOptions {
  onProgress?: (progress: UploadProgress) => void;
  /** Aborting cancels the upload ("Cancel", or leaving the editor). */
  signal?: AbortSignal;
}

function aborted(request: string): ApiError {
  return new ApiError(0, request, 'the upload was cancelled', [], 'network');
}

/**
 * POST …/tasks/:key/files (multipart: `file`, `kind`, `path`): adds a file to a draft task
 * and answers the task. Files over 25 MB are refused by the API (413) before any byte is
 * stored, and the drop zone refuses them before sending.
 */
export function uploadDraftFile(
  folder: string,
  key: string,
  file: File,
  fields: DraftFileUploadFields,
  options: UploadOptions = {},
): Promise<DraftTaskDetail> {
  const path = `/suites/${encodeURIComponent(folder)}/draft/tasks/${encodeURIComponent(key)}/files`;
  const request = describe('POST', path);
  if (apiMode !== 'live') return fixtureUpload(folder, key, file, fields, options, request);
  return new Promise<DraftTaskDetail>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE}${path}`);
    xhr.setRequestHeader('accept', 'application/json');
    xhr.setRequestHeader('x-requested-with', REQUESTED_WITH);
    xhr.upload.onprogress = (e) =>
      options.onProgress?.({ loaded: e.loaded, total: e.lengthComputable ? e.total : file.size });
    xhr.onerror = () =>
      reject(new ApiError(0, request, 'the upload did not reach the API', [], 'network'));
    xhr.onabort = () => reject(aborted(request));
    xhr.onload = () => {
      const text = xhr.responseText;
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(httpError(request, xhr.status, xhr.statusText, text));
        return;
      }
      const value = bodyOf(text);
      const broken = contractError(request, xhr.status, DraftTaskDetailSchema, value);
      if (broken) reject(broken);
      else resolve(value as DraftTaskDetail);
    };
    options.signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    const form = new FormData();
    form.append('kind', fields.kind);
    if (fields.path) form.append('path', fields.path);
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

/** Fixtures: the bar fills in a few steps (none under Vitest), then the world takes the file. */
async function fixtureUpload(
  folder: string,
  key: string,
  file: File,
  fields: DraftFileUploadFields,
  options: UploadOptions,
  request: string,
): Promise<DraftTaskDetail> {
  const steps = FIXTURE_LATENCY_MS > 0 ? 5 : 0;
  for (let i = 1; i <= steps; i++) {
    if (options.signal?.aborted) throw aborted(request);
    await new Promise((r) => setTimeout(r, FIXTURE_LATENCY_MS * 2));
    options.onProgress?.({ loaded: Math.round((file.size * i) / steps), total: file.size });
  }
  if (options.signal?.aborted) throw aborted(request);
  // fixture() honours the loading and error scenarios; the world then takes the file.
  await fixture(null, { request });
  return (await fixtureWorld()).draftOps.uploadFile(folder, key, file, fields);
}
