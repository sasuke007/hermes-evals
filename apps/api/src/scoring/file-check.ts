/**
 * file_check (plan 9.3): checks one file the agent left in the workspace.
 * Pure over a directory, so the evaluator (artifacts materialised from
 * blobs) and the loader's self-check (the expected workspace, then the
 * untouched fixtures) run the same code.
 *
 * The workspace is agent-made, so the file is found without following any
 * link: every component of the path is lstat-ed, a link anywhere is refused,
 * and only a regular file is opened (O_NOFOLLOW, then fstat).
 *
 * Status: anything wrong with the file is `failed` (the agent's output);
 * a broken check, such as an invalid json_schema or an unreadable
 * workspace, is `error`.
 */
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileCheckParams, JsonValue } from '@hermes-evals/shared';
import { Ajv } from 'ajv';
import { parse as parseCsv } from 'csv-parse/sync';
import { MAX_ARTIFACT_BYTES, readTrialFile } from '../sandbox/trial-files.js';
import { binary, guardedAsync, scorerError, type ScorerResult } from './result.js';

/** The same cap as collection: a larger artifact is stored without content. */
export const MAX_CHECKED_FILE_BYTES = MAX_ARTIFACT_BYTES;

export type FileLocation =
  { state: 'absent' } | { state: 'refused'; reason: string } | { state: 'file'; path: string };

const errorCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

/**
 * Finds `relPath` under `root` with lstat only. A parent that is missing or is
 * not a directory means the file is absent; a link anywhere is refused.
 */
export async function locateRegularFile(root: string, relPath: string): Promise<FileLocation> {
  const segments = relPath.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.length === 0 || segments.includes('..') || relPath.startsWith('/')) {
    return { state: 'refused', reason: 'the path leaves the workspace' };
  }
  let current = await realpath(root);
  for (const [i, segment] of segments.entries()) {
    current = join(current, segment);
    const shown = segments.slice(0, i + 1).join('/');
    let stat;
    try {
      stat = await lstat(current);
    } catch (err) {
      const code = errorCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' };
      throw err;
    }
    if (stat.isSymbolicLink()) return { state: 'refused', reason: `${shown} is a symbolic link` };
    const last = i === segments.length - 1;
    if (!last && !stat.isDirectory()) return { state: 'absent' };
    if (last && stat.isDirectory()) return { state: 'refused', reason: `${shown} is a directory` };
    if (last && !stat.isFile())
      return { state: 'refused', reason: `${shown} is not a regular file` };
  }
  return { state: 'file', path: segments.join('/') };
}

interface Check {
  ok: boolean;
  /** What passed, or why not. */
  detail: string;
}

function checkCsv(
  text: string,
  params: FileCheckParams,
  observed: Record<string, JsonValue>,
): Check[] {
  let records: string[][];
  try {
    records = parseCsv(text, { bom: true, skip_empty_lines: true }) as string[][];
  } catch (err) {
    return [{ ok: false, detail: `not valid CSV: ${(err as Error).message}` }];
  }
  const header = (records[0] ?? []).map((cell) => cell.trim());
  const rows = Math.max(0, records.length - 1);
  observed.columns = header;
  observed.row_count = rows;
  const checks: Check[] = [{ ok: true, detail: 'valid CSV' }];
  if (params.columns) {
    const missing = params.columns.filter((c) => !header.includes(c));
    checks.push(
      missing.length === 0
        ? { ok: true, detail: `has columns ${params.columns.join(', ')}` }
        : { ok: false, detail: `missing columns ${missing.join(', ')}` },
    );
  }
  if (params.row_count !== undefined) {
    checks.push({
      ok: rows === params.row_count,
      detail:
        rows === params.row_count
          ? `${rows} data rows`
          : `${rows} data rows, expected ${params.row_count}`,
    });
  }
  return checks;
}

/** Thrown for a json_schema Ajv cannot compile: the check is broken, not the file. */
class InvalidSchema extends Error {}

function checkJson(text: string, params: FileCheckParams): Check[] {
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    return [{ ok: false, detail: `not valid JSON: ${(err as Error).message}` }];
  }
  const checks: Check[] = [{ ok: true, detail: 'valid JSON' }];
  if (params.json_schema) {
    // JSON Schema draft-07, Ajv's default. Strict: an unknown keyword or format
    // is an authoring mistake, reported as an error rather than ignored.
    const ajv = new Ajv({ allErrors: true, logger: false });
    let validate;
    try {
      validate = ajv.compile(params.json_schema);
    } catch (err) {
      throw new InvalidSchema(`the json_schema is invalid: ${(err as Error).message}`);
    }
    if (validate(value)) {
      checks.push({ ok: true, detail: 'matches the JSON schema' });
    } else {
      const errors = ajv.errorsText(validate.errors, { dataVar: 'file', separator: '; ' });
      checks.push({ ok: false, detail: `does not match the JSON schema: ${errors.slice(0, 500)}` });
    }
  }
  return checks;
}

/** Runs every declared check on the file; the key passes only when all of them do. */
export async function checkFile(
  params: FileCheckParams,
  workspaceDir: string,
): Promise<ScorerResult> {
  return guardedAsync(async () => {
    const expected = expectedOf(params);
    const observed: Record<string, JsonValue> = { path: params.path };
    const located = await locateRegularFile(workspaceDir, params.path);
    if (located.state === 'absent') {
      observed.exists = false;
      return params.must_exist
        ? binary(false, `${params.path} does not exist`, { observed, expected })
        : binary(true, `${params.path} is absent, which is allowed`, { observed, expected });
    }
    if (located.state === 'refused') {
      return binary(false, `refused: ${located.reason}`, { observed, expected });
    }
    observed.exists = true;
    const read = await readTrialFile(
      await realpath(workspaceDir),
      located.path,
      MAX_CHECKED_FILE_BYTES,
    );
    if (!read.ok) {
      if (read.reason === 'unreadable') {
        return scorerError(`${params.path} could not be read: ${read.detail}`);
      }
      const why =
        read.reason === 'too_large'
          ? `is larger than ${MAX_CHECKED_FILE_BYTES} bytes`
          : `was refused (${read.reason}: ${read.detail})`;
      return binary(false, `${params.path} ${why}`, { observed, expected });
    }
    observed.size = read.content.length;

    const checks: Check[] = [{ ok: true, detail: 'exists' }];
    if (params.format !== undefined || params.contains !== undefined) {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(read.content);
      } catch {
        return binary(false, `${params.path} is not valid UTF-8 text`, { observed, expected });
      }
      try {
        if (params.format === 'csv') checks.push(...checkCsv(text, params, observed));
        if (params.format === 'json') checks.push(...checkJson(text, params));
        if (params.format === 'text') checks.push({ ok: true, detail: 'valid UTF-8 text' });
      } catch (err) {
        if (err instanceof InvalidSchema) return scorerError(err.message);
        throw err;
      }
      if (params.contains) {
        const absent = params.contains.filter((needle) => !text.includes(needle));
        checks.push(
          absent.length === 0
            ? { ok: true, detail: `contains all ${params.contains.length} strings` }
            : {
                ok: false,
                detail: `does not contain ${absent.map((a) => JSON.stringify(a)).join(', ')}`,
              },
        );
      }
    }
    const failing = checks.filter((c) => !c.ok);
    const comment =
      failing.length === 0
        ? `${params.path}: ${checks.map((c) => c.detail).join(', ')}`
        : `${params.path}: ${failing.map((c) => c.detail).join('; ')}`;
    return binary(failing.length === 0, comment, { observed, expected });
  });
}

/** The declared checks, as the score row's `expected`. */
function expectedOf(params: FileCheckParams): JsonValue {
  const expected: Record<string, JsonValue> = { path: params.path, must_exist: params.must_exist };
  if (params.format !== undefined) expected.format = params.format;
  if (params.columns !== undefined) expected.columns = params.columns;
  if (params.row_count !== undefined) expected.row_count = params.row_count;
  if (params.json_schema !== undefined) expected.json_schema = params.json_schema;
  if (params.contains !== undefined) expected.contains = params.contains;
  return expected;
}
