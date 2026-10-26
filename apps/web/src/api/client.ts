/**
 * The one way the web app talks to the API (plan 11). Every response is parsed with its
 * shared zod schema from @hermes-evals/shared, so a contract change fails loudly at the
 * boundary instead of somewhere in a page. Every failure is an ApiError whose message is what
 * ErrorBanner quotes verbatim: "GET /api/experiments → 502 · upstream api:8080 connection
 * refused", with the API's own sentence and, for a 400, its issues per field.
 *
 * Components never call these: they call the functions in src/api/<domain>.ts, which pick
 * live or fixtures (source.ts). See src/api/README.md.
 */
import { ApiErrorBodySchema, type ApiErrorBody } from '@hermes-evals/shared';
import type { ZodType } from 'zod';

/** Every path is relative to this; nginx (Compose) and Vite (pnpm dev) proxy it to the API. */
export const API_BASE = '/api';

/** The CSRF guard's header (plan 6.1): any state-changing call without it is refused. */
export const REQUESTED_WITH = 'hermes-evals';

export type ApiIssue = NonNullable<ApiErrorBody['issues']>[number];

/**
 * http: the API answered with an error status · network: no answer at all · contract: the
 * answer did not match its shared schema (a bug on one side or the other).
 */
export type ApiErrorKind = 'http' | 'network' | 'contract';

export class ApiError extends Error {
  /** "GET /api/experiments". */
  readonly request: string;
  /** The API's sentence (`message` of its error body), or what stood in for it. */
  readonly detail: string;
  /** One per field for a request that failed validation: { path: 'headers.0.env', message }. */
  readonly issues: ApiIssue[];
  readonly kind: ApiErrorKind;
  /**
   * The whole JSON error body, for refusals that carry more than a sentence (an import's 422
   * keeps its preview); null when the answer was not JSON. Parse it with its shared schema.
   */
  readonly body: unknown;

  constructor(
    /** HTTP status; 0 when nothing answered. */
    public readonly status: number,
    request: string,
    detail: string,
    issues: ApiIssue[] = [],
    kind: ApiErrorKind = 'http',
    body: unknown = null,
  ) {
    super(`${request} → ${status} · ${detail}`);
    this.name = 'ApiError';
    this.request = request;
    this.detail = detail;
    this.issues = issues;
    this.kind = kind;
    this.body = body;
  }

  /** The request ("GET /api/x"); kept under its old name for existing callers. */
  get path(): string {
    return this.request;
  }

  /** The issue for one field, by its dotted path: issueFor('name'). */
  issueFor(path: string): string | null {
    return this.issues.find((issue) => issue.path === path)?.message ?? null;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** The message to show for any failure: the ApiError's line, or the error's own message. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** "GET /api/experiments" (the query string is left out of messages). */
function describe(method: string, path: string): string {
  return `${method} ${API_BASE}${path.split('?')[0]}`;
}

/** The API's error body is `{ statusCode, message, issues? }`; anything else is quoted raw. */
async function errorFrom(res: Response, request: string): Promise<ApiError> {
  const text = await res.text().catch(() => '');
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON: an nginx or proxy page */
  }
  const parsed = ApiErrorBodySchema.safeParse(body);
  if (parsed.success) {
    return new ApiError(
      res.status,
      request,
      parsed.data.message,
      parsed.data.issues ?? [],
      'http',
      body,
    );
  }
  const raw = text.trim().slice(0, 300);
  return new ApiError(res.status, request, raw || res.statusText || 'no response body');
}

async function send(request: string, url: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ApiError(0, request, errorMessage(err), [], 'network');
  }
  if (!res.ok) throw await errorFrom(res, request);
  return res;
}

function parse<T>(request: string, status: number, schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  const first = issues[0];
  const where = first ? `${first.path || '(root)'}: ${first.message}` : 'unknown';
  throw new ApiError(
    status,
    request,
    `the response does not match its contract (${where})`,
    issues,
    'contract',
  );
}

async function json(res: Response, request: string): Promise<unknown> {
  if (res.status === 204) return undefined;
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(res.status, request, 'the response is not JSON', [], 'contract');
  }
}

/** GET a path (without /api) and parse the answer with its shared schema. */
export async function apiGet<T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> {
  const request = describe('GET', path);
  const res = await send(request, `${API_BASE}${path}`, {
    ...init,
    method: 'GET',
    headers: { accept: 'application/json', ...init?.headers },
  });
  return parse(request, res.status, schema, await json(res, request));
}

/** The start of a text body: what apiGetText read, and whether the body went on past it. */
export interface TextStart {
  text: string;
  /** The body goes on past `text`. */
  truncated: boolean;
}

/** Reads at most `maxBytes` of a response body, then stops the download. */
async function readStart(res: Response, maxBytes: number): Promise<TextStart> {
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    return { text: text.slice(0, maxBytes), truncated: text.length > maxBytes };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > maxBytes) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  const bytes = new Uint8Array(Math.min(size, maxBytes));
  let at = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.byteLength, bytes.length - at));
    bytes.set(part, at);
    at += part.byteLength;
    if (at >= bytes.length) break;
  }
  // A multi-byte character cut at the limit decodes as U+FFFD, which a preview tolerates.
  return { text: new TextDecoder().decode(bytes), truncated };
}

/**
 * GET a path that answers bytes rather than JSON (an artifact's content) and read at most
 * `maxBytes` of it as text. Nothing is parsed; failures are ApiErrors like apiGet's.
 */
export async function apiGetText(path: string, maxBytes: number): Promise<TextStart> {
  const request = describe('GET', path);
  const res = await send(request, `${API_BASE}${path}`, {
    method: 'GET',
    headers: { accept: 'text/plain, */*' },
  });
  return readStart(res, maxBytes);
}

export type SendMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A state-changing call. JSON bodies go as application/json (an empty object when there is
 * none), FormData as multipart; both carry X-Requested-With, which the API requires so that
 * another site cannot drive it (plan 6.1). With a schema the answer is parsed with it;
 * without one the answer is ignored (204, or a body nobody reads).
 */
export async function apiSend<T>(
  method: SendMethod,
  path: string,
  body: unknown,
  schema: ZodType<T>,
): Promise<T>;
export async function apiSend(method: SendMethod, path: string, body?: unknown): Promise<void>;
export async function apiSend<T>(
  method: SendMethod,
  path: string,
  body?: unknown,
  schema?: ZodType<T>,
): Promise<T | void> {
  const request = describe(method, path);
  const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-requested-with': REQUESTED_WITH,
  };
  if (!multipart) headers['content-type'] = 'application/json';
  const res = await send(request, `${API_BASE}${path}`, {
    method,
    headers,
    body: multipart ? (body as FormData) : JSON.stringify(body ?? {}),
  });
  if (!schema) return;
  return parse(request, res.status, schema, await json(res, request));
}
