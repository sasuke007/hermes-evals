/**
 * readSuiteZip's Phase 7 answers (Phase 5b questions 2, 12 and 18): the
 * files at the suite root the draft leaves out, which verify/ files a check
 * runs, and a text too long for the editor kept as a read-only blob.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTHORING_LIMITS } from '@hermes-evals/shared';
import { BlobStore } from '../../storage/blob-store.js';
import type { SuiteZipRead } from './parsers.js';
import { readSuiteZipFile } from './suite-zip.js';
import { buildZip, TASK_YAML, vendorStatements, type ZipItem } from './zip-testing.helper-spec.js';

const sha = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');

/** `n` letters that do not compress far (the zip reader refuses a 200-fold expansion). */
function noisy(n: number): string {
  let seed = 7;
  let out = '';
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out += String.fromCharCode(97 + (seed % 26));
  }
  return out;
}

let work: string;
let blobs: BlobStore;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), 'suite-zip-root-'));
  blobs = new BlobStore(join(work, 'data'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function contentsOf(items: ZipItem[]) {
  const path = join(work, 'upload.zip');
  await writeFile(path, await buildZip(items));
  const read: SuiteZipRead = await readSuiteZipFile(path, blobs);
  if (!read.ok) throw new Error(`refused: ${JSON.stringify(read.problems)}`);
  return read.contents;
}

describe('files at the suite root', () => {
  it('lists the root files other than suite.yaml, by path, under a stripped folder too', async () => {
    const contents = await contentsOf(
      vendorStatements('top/', [
        { path: 'top/README.md', content: '# Notes\n' },
        { path: 'top/LICENSE', content: 'MIT\n' },
      ]),
    );
    expect(contents.rootFilesNotKept).toEqual([
      { path: 'LICENSE', sizeBytes: 4 },
      { path: 'README.md', sizeBytes: 8 },
    ]);
    expect(contents.tasks.map((t) => t.key)).toEqual(['unmatched_lines']);
  });

  it('is empty for a zip of suite.yaml and task folders alone', async () => {
    expect((await contentsOf(vendorStatements())).rootFilesNotKept).toEqual([]);
  });
});

describe('verify/ files a check runs', () => {
  it('marks the scripts verifier_script checks name, through ./ and in subfolders', async () => {
    const taskYaml = `${TASK_YAML}  - key: checked
    type: verifier_script
    params: { script: ./check.py }
  - key: deeper
    type: verifier_script
    params: { script: lib/inner.py }
`;
    const contents = await contentsOf(
      vendorStatements('', [
        { path: 'unmatched_lines/verify/check.py', content: 'print(1)\n' },
        { path: 'unmatched_lines/verify/lib/inner.py', content: 'print(2)\n' },
        { path: 'unmatched_lines/verify/expected_stock.json', content: '{}\n' },
      ]).map((item) =>
        item.path === 'unmatched_lines/task.yaml' ? { ...item, content: taskYaml } : item,
      ),
    );
    expect(contents.scripts.map((s) => [s.path, s.runByCheck])).toEqual([
      ['unmatched_lines/verify/check.py', true],
      ['unmatched_lines/verify/expected_stock.json', false],
      ['unmatched_lines/verify/lib/inner.py', true],
    ]);
  });

  it('marks none in a task whose checks name no script', async () => {
    const contents = await contentsOf(
      vendorStatements('', [{ path: 'unmatched_lines/verify/check.py', content: 'print(1)\n' }]),
    );
    expect(contents.scripts).toEqual([
      {
        path: 'unmatched_lines/verify/check.py',
        sizeBytes: 9,
        sha256: sha('print(1)\n'),
        runByCheck: false,
      },
    ]);
  });
});

describe('texts longer than the editor holds', () => {
  it('keeps a prompt over the limit as an other blob, byte for byte, and one at the limit as text', async () => {
    const limit = AUTHORING_LIMITS.draftTextMaxChars;
    const long = `${noisy(limit)}\n`;
    const atLimit = `${noisy(limit - 1)}\n`;
    const contents = await contentsOf(
      vendorStatements('', [
        { path: 'second/task.yaml', content: TASK_YAML },
        { path: 'second/prompt.md', content: atLimit },
        { path: 'second/reference.json', content: '{ "unmatched": [] }\n' },
      ]).map((item) =>
        item.path === 'unmatched_lines/prompt.md' ? { ...item, content: long } : item,
      ),
    );
    const [first, second] = contents.tasks;
    expect(first!.prompt).toBeNull();
    expect(first!.files.find((f) => f.path === 'prompt.md')).toEqual({
      path: 'prompt.md',
      kind: 'other',
      sha256: sha(long),
      size: Buffer.byteLength(long),
    });
    expect((await blobs.read(sha(long))).toString('utf8')).toBe(long);
    expect(second!.prompt).toBe(atLimit);
    expect(second!.files.map((f) => f.path)).not.toContain('prompt.md');
  });
});
