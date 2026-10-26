/**
 * Rebuilding a workspace from blobs: paths an agent chose can never write
 * outside the scratch root, and every file is a copy, so a verifier that
 * writes to its workspace cannot change a stored blob.
 */
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BlobStore } from '../storage/blob-store.js';
import type { ArtifactRecord } from './evidence.js';
import {
  materialiseHome,
  materialiseVerifyDir,
  materialiseWorkspace,
  normaliseRelativePath,
  safeSegments,
} from './workspace.js';

let root: string;
let store: BlobStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'hermes-evals-workspace-'));
  store = new BlobStore(join(root, 'data'));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

const artifact = (
  path: string,
  sha256: string | null,
  size = 1,
  root: ArtifactRecord['root'] = 'workspace',
): ArtifactRecord => ({
  id: `a-${root}-${path}`,
  root,
  path,
  origin: 'agent',
  size,
  sha256,
  skippedReason: sha256 === null ? 'too_large' : null,
});

describe('safeSegments', () => {
  it('normalises relative paths and refuses any that leave the root', () => {
    expect(safeSegments('out/summary.csv')).toEqual(['out', 'summary.csv']);
    expect(normaliseRelativePath('./out//summary.csv/')).toBe('out/summary.csv');
    for (const unsafe of ['', '.', '/etc/passwd', '../x', 'a/../b', 'a\\b', 'a\0b']) {
      expect(safeSegments(unsafe)).toBeNull();
    }
  });
});

describe('materialise', () => {
  it('writes artifacts with content at their paths and leaves skipped ones out', async () => {
    const ref = await store.putBuffer(Buffer.from('vendor,total\n'));
    const dir = join(root, 'ws-1');
    const written = await materialiseWorkspace(
      store,
      [artifact('out/summary.csv', ref.sha256), artifact('big.bin', null, 30_000_000)],
      dir,
    );
    expect(written).toBe(1);
    expect(await readdir(dir)).toEqual(['out']);
    // A copy, not a link: changing it leaves the blob as it was.
    await writeFile(join(dir, 'out', 'summary.csv'), 'changed');
    expect(await readFile(store.path(ref.sha256), 'utf8')).toBe('vendor,total\n');
  });

  it('keeps the workspace and the home files apart (Phase 6 P2)', async () => {
    const summary = await store.putBuffer(Buffer.from('vendor,total\n'));
    const user = await store.putBuffer(Buffer.from('Reports in EUR.'));
    const both = [
      artifact('summary.csv', summary.sha256),
      artifact('memories/USER.md', user.sha256, 15, 'home'),
    ];
    const ws = join(root, 'ws-home');
    const home = join(root, 'home-1');
    expect(await materialiseWorkspace(store, both, ws)).toBe(1);
    expect(await readdir(ws)).toEqual(['summary.csv']);
    expect(await materialiseHome(store, both, home)).toBe(1);
    expect(await readFile(join(home, 'memories', 'USER.md'), 'utf8')).toBe('Reports in EUR.');
    // No home files: an empty folder, which is what --home then names.
    const empty = join(root, 'home-2');
    expect(await materialiseHome(store, [both[0]!], empty)).toBe(0);
    expect(await readdir(empty)).toEqual([]);
  });

  it('refuses an artifact path that would leave the workspace', async () => {
    const ref = await store.putBuffer(Buffer.from('escape'));
    const dir = join(root, 'ws-2');
    await expect(
      materialiseWorkspace(store, [artifact('../escaped.txt', ref.sha256)], dir),
    ).rejects.toThrow(/refusing to write/);
    expect(await readdir(root)).not.toContain('escaped.txt');
  });

  it('writes the verify/ folder without its prefix and skips other task files', async () => {
    const script = await store.putBuffer(Buffer.from('print(1)\n'));
    const util = await store.putBuffer(Buffer.from('X = 1\n'));
    const dir = join(root, 'verify-1');
    const written = await materialiseVerifyDir(
      store,
      [
        { path: 'verify/check.py', sha256: script.sha256 },
        { path: 'verify/lib/util.py', sha256: util.sha256 },
        { path: 'rubric.md', sha256: util.sha256 },
      ],
      dir,
    );
    expect(written).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(['check.py', 'lib']);
    expect(await readFile(join(dir, 'lib', 'util.py'), 'utf8')).toBe('X = 1\n');
  });
});
