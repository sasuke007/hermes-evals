import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore } from '../../storage/blob-store.js';
import { sha256Hex } from '../loader/hashing.js';
import { writeDraftTaskFolder, type DraftFileRef, type DraftTaskFolder } from './materialise.js';

let root: string;
let store: BlobStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'materialise-'));
  store = new BlobStore(join(root, 'data'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function blob(
  path: string,
  content: string,
  kind: DraftFileRef['kind'],
): Promise<DraftFileRef> {
  const ref = await store.putBuffer(Buffer.from(content));
  return { path, kind, sha256: ref.sha256, size: ref.size };
}

async function task(overrides: Partial<DraftTaskFolder> = {}): Promise<DraftTaskFolder> {
  return {
    key: 'total_due',
    taskYaml: 'summary: Sum\n',
    prompt: 'Reply with ```json\n',
    reference: '﻿{ "total": 3 }\n',
    rubrics: { 'rubric.md': 'Be fair.\n' },
    files: [
      await blob('expected/out.csv', 'a\n1\n', 'expected'),
      await blob('fixtures/docs/in.csv', 'a\n', 'fixture'),
      await blob('home/memories/USER.md', 'Prefers EUR', 'home_seed'),
      await blob('notes.txt', 'kept as is', 'other'),
      await blob('verify/check.py', 'print(1)\n', 'verifier'),
    ],
    ...overrides,
  };
}

/** Every file under `dir`, path → text. */
async function tree(dir: string, prefix = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, await tree(dir, rel));
    else out[rel] = await readFile(join(dir, rel), 'utf8');
  }
  return out;
}

describe('writeDraftTaskFolder', () => {
  it('writes the texts exactly as stored and every blob file, and lists them with their hashes', async () => {
    const dir = join(root, 'out', 'total_due');
    await mkdir(join(root, 'out'));
    const written = await writeDraftTaskFolder(await task(), dir, { blobs: store });
    expect(await tree(dir)).toEqual({
      'expected/out.csv': 'a\n1\n',
      'fixtures/docs/in.csv': 'a\n',
      'home/memories/USER.md': 'Prefers EUR',
      'notes.txt': 'kept as is',
      'prompt.md': 'Reply with ```json\n',
      'reference.json': '﻿{ "total": 3 }\n',
      'rubric.md': 'Be fair.\n',
      'task.yaml': 'summary: Sum\n',
      'verify/check.py': 'print(1)\n',
    });
    // The byte-order mark is written back, so an unedited file hashes as it did.
    const reference = await readFile(join(dir, 'reference.json'));
    expect(reference.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(written.map((f) => f.path)).toEqual(Object.keys(await tree(dir)).sort());
    expect(written.find((f) => f.path === 'reference.json')).toEqual({
      path: 'reference.json',
      sha256: sha256Hex(reference),
      size: reference.length,
    });
  });

  it('writes only the blob kinds asked for, and no file for a null text', async () => {
    const dir = join(root, 'task');
    await writeDraftTaskFolder(await task({ reference: null, rubrics: {} }), dir, {
      blobs: store,
      kinds: new Set(['fixture', 'expected', 'expected_home', 'home_seed']),
    });
    expect(Object.keys(await tree(dir)).sort()).toEqual([
      'expected/out.csv',
      'fixtures/docs/in.csv',
      'home/memories/USER.md',
      'prompt.md',
      'task.yaml',
    ]);
  });

  it.each([
    ['../escape.txt'],
    ['/etc/passwd'],
    ['fixtures/./a.csv'],
    ['fixtures//a.csv'],
    ['fixtures\\a.csv'],
    [''],
  ])('refuses %j before writing anything', async (path) => {
    const bad = await task({ files: [await blob(path, 'x', 'other')] });
    const dir = join(root, 'task');
    await expect(writeDraftTaskFolder(bad, dir, { blobs: store })).rejects.toThrow(/refusing/);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a path written twice, a folder that exists, and a file where a folder goes', async () => {
    const twice = await task({ rubrics: { 'notes.txt': 'again' } });
    await expect(writeDraftTaskFolder(twice, join(root, 'a'), { blobs: store })).rejects.toThrow(
      /written twice/,
    );
    await mkdir(join(root, 'b'));
    await expect(
      writeDraftTaskFolder(await task(), join(root, 'b'), { blobs: store }),
    ).rejects.toThrow(/EEXIST/);
    const clash = await task({ rubrics: { fixtures: 'a file named like the folder' } });
    await expect(writeDraftTaskFolder(clash, join(root, 'c'), { blobs: store })).rejects.toThrow(
      /fixtures is not a folder|EEXIST|EISDIR/,
    );
  });

  it('refuses bytes that do not match the draft, and a blob the store lacks', async () => {
    const good = await blob('fixtures/a.csv', 'right', 'fixture');
    await writeFile(store.path(good.sha256), 'wrong');
    await expect(
      writeDraftTaskFolder(await task({ files: [good] }), join(root, 'a'), { blobs: store }),
    ).rejects.toThrow(/do not match/);
    const absent = {
      path: 'fixtures/b.csv',
      kind: 'fixture' as const,
      sha256: 'f'.repeat(64),
      size: 1,
    };
    await expect(
      writeDraftTaskFolder(await task({ files: [absent] }), join(root, 'b'), { blobs: store }),
    ).rejects.toThrow(/ENOENT/);
  });
});
