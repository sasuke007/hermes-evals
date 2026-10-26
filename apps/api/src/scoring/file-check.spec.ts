import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCheckParamsSchema } from '@hermes-evals/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkFile, locateRegularFile } from './file-check.js';

const SUMMARY = 'vendor,outstanding\nACME,120.50\nGlobex,80.00\n';

describe('file_check', () => {
  let ws: string;
  let outside: string;
  beforeAll(() => {
    ws = mkdtempSync(join(tmpdir(), 'file-check-'));
    outside = mkdtempSync(join(tmpdir(), 'file-check-outside-'));
    writeFileSync(join(ws, 'summary.csv'), SUMMARY);
    writeFileSync(join(ws, 'bom.csv'), `\uFEFF${SUMMARY}`);
    writeFileSync(join(ws, 'ragged.csv'), 'a,b\n1,2,3\n');
    writeFileSync(join(ws, 'header.csv'), 'vendor , outstanding\n');
    writeFileSync(join(ws, 'report.json'), '{"total": 200.5, "vendors": ["ACME", "Globex"]}');
    writeFileSync(join(ws, 'broken.json'), '{"total": ');
    writeFileSync(join(ws, 'notes.txt'), 'Totals reconciled. ACME owes 120.50.');
    writeFileSync(join(ws, 'binary.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x41]));
    mkdirSync(join(ws, 'out'));
    writeFileSync(join(ws, 'out', 'nested.txt'), 'deep');
    writeFileSync(join(outside, 'secret.txt'), 'ACME');
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'link.txt'));
    symlinkSync(outside, join(ws, 'linkdir'));
    execFileSync('mkfifo', [join(ws, 'pipe')]);
  });
  afterAll(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  const check = (params: Record<string, unknown>) =>
    checkFile(FileCheckParamsSchema.parse(params), ws);

  it('passes an existing file with no other checks', async () => {
    expect(await check({ path: 'summary.csv' })).toMatchObject({
      status: 'passed',
      score: 1,
      observed: { path: 'summary.csv', exists: true, size: SUMMARY.length },
    });
    expect((await check({ path: 'out/nested.txt' })).status).toBe('passed');
  });

  it('fails a missing file unless must_exist is false', async () => {
    expect(await check({ path: 'nope.csv' })).toMatchObject({
      status: 'failed',
      score: 0,
      comment: 'nope.csv does not exist',
    });
    expect(await check({ path: 'nope.csv', must_exist: false, format: 'csv' })).toMatchObject({
      status: 'passed',
      score: 1,
    });
    // A parent that is a file, not a folder, means the file cannot exist.
    expect((await check({ path: 'summary.csv/x' })).comment).toBe('summary.csv/x does not exist');
  });

  it('checks CSV columns and data rows', async () => {
    const ok = await check({
      path: 'summary.csv',
      format: 'csv',
      columns: ['outstanding', 'vendor'],
      row_count: 2,
    });
    expect(ok).toMatchObject({
      status: 'passed',
      observed: { columns: ['vendor', 'outstanding'], row_count: 2 },
    });
    expect(ok.comment).toBe(
      'summary.csv: exists, valid CSV, has columns outstanding, vendor, 2 data rows',
    );
    const bad = await check({
      path: 'summary.csv',
      format: 'csv',
      columns: ['vendor', 'due'],
      row_count: 5,
    });
    expect(bad).toMatchObject({
      status: 'failed',
      score: 0,
      comment: 'summary.csv: missing columns due; 2 data rows, expected 5',
    });
  });

  it('reads a BOM, trims header cells and refuses ragged rows', async () => {
    expect((await check({ path: 'bom.csv', format: 'csv', columns: ['vendor'] })).status).toBe(
      'passed',
    );
    expect(
      (await check({ path: 'header.csv', format: 'csv', columns: ['vendor'], row_count: 0 }))
        .status,
    ).toBe('passed');
    expect((await check({ path: 'ragged.csv', format: 'csv' })).comment).toMatch(/not valid CSV/);
  });

  it('checks JSON and a JSON schema', async () => {
    const schema = {
      type: 'object',
      required: ['total', 'vendors'],
      properties: { total: { type: 'number' }, vendors: { type: 'array', minItems: 2 } },
    };
    expect((await check({ path: 'report.json', format: 'json', json_schema: schema })).status).toBe(
      'passed',
    );
    const wrong = await check({
      path: 'report.json',
      format: 'json',
      json_schema: { ...schema, properties: { total: { type: 'string' } } },
    });
    expect(wrong).toMatchObject({ status: 'failed' });
    expect(wrong.comment).toMatch(/does not match the JSON schema: file\/total must be string/);
    expect((await check({ path: 'broken.json', format: 'json' })).comment).toMatch(
      /not valid JSON/,
    );
  });

  it('errors, rather than failing the agent, on a schema that cannot compile', async () => {
    const result = await check({
      path: 'report.json',
      format: 'json',
      json_schema: { type: 'object', requried: ['total'] },
    });
    expect(result).toMatchObject({ status: 'error', score: null });
    expect(result.comment).toMatch(/the json_schema is invalid/);
  });

  it('checks text and substrings', async () => {
    expect(
      (await check({ path: 'notes.txt', format: 'text', contains: ['ACME', '120.50'] })).status,
    ).toBe('passed');
    expect(await check({ path: 'notes.txt', contains: ['ACME', 'Globex'] })).toMatchObject({
      status: 'failed',
      comment: 'notes.txt: does not contain "Globex"',
    });
    expect((await check({ path: 'binary.bin', format: 'text' })).comment).toBe(
      'binary.bin is not valid UTF-8 text',
    );
  });

  it('never follows a link, and refuses folders and special files', async () => {
    expect(await check({ path: 'link.txt', contains: ['ACME'] })).toMatchObject({
      status: 'failed',
      comment: 'refused: link.txt is a symbolic link',
    });
    expect(await check({ path: 'linkdir/secret.txt' })).toMatchObject({
      status: 'failed',
      comment: 'refused: linkdir is a symbolic link',
    });
    expect((await check({ path: 'out' })).comment).toBe('refused: out is a directory');
    // A FIFO is never opened, so the check cannot hang on it.
    expect((await check({ path: 'pipe' })).comment).toBe('refused: pipe is not a regular file');
    // must_exist: false does not let a link through.
    expect((await check({ path: 'link.txt', must_exist: false })).status).toBe('failed');
  });

  it('errors when the workspace itself is missing', async () => {
    const result = await checkFile(
      FileCheckParamsSchema.parse({ path: 'a.txt' }),
      join(ws, 'missing-root'),
    );
    expect(result).toMatchObject({ status: 'error', score: null });
  });

  it('normalises harmless path spellings', async () => {
    expect(await locateRegularFile(ws, './out//nested.txt')).toEqual({
      state: 'file',
      path: 'out/nested.txt',
    });
    expect(await locateRegularFile(ws, '../x')).toMatchObject({ state: 'refused' });
  });
});

describe('file_check with root: home (Phase 6 P2)', () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'file-check-home-'));
    mkdirSync(join(home, 'memories'));
    writeFileSync(
      join(home, 'memories', 'USER.md'),
      'Prefers reports in EUR.\n§\nWorks in Lisbon.',
    );
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const params = (p: Record<string, unknown>) =>
    FileCheckParamsSchema.parse({ root: 'home', ...p });

  it('reads the memory file under the home folder it is given', async () => {
    expect(
      await checkFile(params({ path: 'memories/USER.md', contains: ['EUR'] }), home),
    ).toMatchObject({
      status: 'passed',
      comment: 'memories/USER.md: exists, contains all 1 strings',
      expected: { root: 'home', path: 'memories/USER.md', must_exist: true },
    });
    expect(await checkFile(params({ path: 'memories/MEMORY.md' }), home)).toMatchObject({
      status: 'failed',
      comment: 'memories/MEMORY.md does not exist',
    });
  });

  it('says nothing about the root of a workspace check, as before', async () => {
    const result = await checkFile(FileCheckParamsSchema.parse({ path: 'memories/USER.md' }), home);
    expect(result.expected).toEqual({ path: 'memories/USER.md', must_exist: true });
  });

  it('is refused outside memories/, the only home folder collected', () => {
    const parsed = FileCheckParamsSchema.safeParse({ root: 'home', path: 'config.yaml' });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]).toMatchObject({ path: ['path'] });
  });
});
